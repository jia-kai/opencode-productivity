import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { Fzf, type FzfResultItem } from "fzf"

export interface PromptHistoryEntry {
  id: string
  prompt: string
  createdAt: number
}

export interface PromptHistoryMatch extends PromptHistoryEntry {
  score: number
}

export interface HistorySearchOptions {
  limit?: number
  dbPath?: string
}

export const MAX_PROMPT_HISTORY_ENTRIES = 4_096
export const MAX_VISIBLE_PROMPT_HISTORY_MATCHES = 100

type StatementRows = Array<Record<string, unknown>>

export function resolveHistoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
  return env.OPENCODE_HISTORY_DB || path.join(dataHome, "opencode", "opencode.db")
}

export function fuzzyScore(query: string, candidate: string): number {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return 1
  return new Fzf([candidate], { casing: "case-insensitive" }).find(normalizedQuery)[0]?.score ?? 0
}

export function dedupePrompts(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
  const byPrompt = new Map<string, PromptHistoryEntry>()
  for (const entry of entries) {
    const key = entry.prompt.trim().replace(/\s+/g, " ")
    const existing = byPrompt.get(key)
    if (!existing || entry.createdAt > existing.createdAt) byPrompt.set(key, entry)
  }
  return [...byPrompt.values()]
}

export function rankPromptHistory(
  entries: PromptHistoryEntry[],
  query: string,
  limit = 50,
): PromptHistoryMatch[] {
  return new PromptHistoryIndex(entries).find(query, limit)
}

export const PROMPT_HISTORY_SCORING_WINDOW = 4_096

const SUBSTRING_SCORE = 1_000_000
const SUBSEQUENCE_SCORE_BASE = 500_000

export interface PreparedPromptHistoryEntry extends PromptHistoryEntry {
  searchText: string
}

export function preparePromptHistoryEntries(entries: PromptHistoryEntry[]): PreparedPromptHistoryEntry[] {
  return dedupePrompts(entries)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((entry) => ({
      ...entry,
      searchText: entry.prompt.slice(0, PROMPT_HISTORY_SCORING_WINDOW).toLowerCase(),
    }))
}

export function scorePromptHistoryMatch(query: string, searchText: string): number {
  if (searchText.includes(query)) return SUBSTRING_SCORE
  let from = 0
  let first = -1
  let last = -1
  for (let index = 0; index < query.length; index += 1) {
    const at = searchText.indexOf(query[index], from)
    if (at < 0) return 0
    if (first < 0) first = at
    last = at
    from = at + 1
  }
  const tightness = query.length / (last - first + 1)
  const earliness = 1 - first / searchText.length
  return SUBSEQUENCE_SCORE_BASE * (0.7 * tightness + 0.3 * earliness)
}

export class PromptHistoryIndex {
  private items: PreparedPromptHistoryEntry[]

  constructor(entries: PromptHistoryEntry[]) {
    this.items = preparePromptHistoryEntries(entries)
  }

  static fromPrepared(items: PreparedPromptHistoryEntry[]): PromptHistoryIndex {
    const index = Object.create(PromptHistoryIndex.prototype) as PromptHistoryIndex
    ;(index as unknown as { items: PreparedPromptHistoryEntry[] }).items = items
    return index
  }

  get size(): number {
    return this.items.length
  }

  get all(): readonly PreparedPromptHistoryEntry[] {
    return this.items
  }

  find(query: string, limit = MAX_VISIBLE_PROMPT_HISTORY_MATCHES): PromptHistoryMatch[] {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return this.items.slice(0, limit).map(toMatchWithScore(1))
    }
    const matches: PromptHistoryMatch[] = []
    for (const item of this.items) {
      const score = scorePromptHistoryMatch(normalizedQuery, item.searchText)
      if (score > 0) matches.push(toMatchWithScore(score)(item))
    }
    matches.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
    return matches.slice(0, limit)
  }
}

function toMatchWithScore(score: number) {
  return (item: PreparedPromptHistoryEntry): PromptHistoryMatch => ({
    id: item.id,
    prompt: item.prompt,
    createdAt: item.createdAt,
    score,
  })
}

export function filterPromptHistory(
  entries: PromptHistoryEntry[],
  query: string,
  limit = MAX_VISIBLE_PROMPT_HISTORY_MATCHES,
): PromptHistoryMatch[] {
  return new PromptHistoryIndex(entries).find(query, limit)
}

export function searchPromptHistory(query: string, options: HistorySearchOptions = {}): PromptHistoryMatch[] {
  const dbPath = options.dbPath ?? resolveHistoryDbPath()
  if (!existsSync(dbPath)) return []
  const resultLimit = Math.min(options.limit ?? 50, MAX_PROMPT_HISTORY_ENTRIES)
  const rows = loadPromptRows(dbPath, Math.min(Math.max(resultLimit, 200), MAX_PROMPT_HISTORY_ENTRIES))
  return rankPromptHistory(rows, query, resultLimit)
}

export function loadPromptHistoryEntries(dbPath: string, limit: number): PromptHistoryEntry[] {
  return loadPromptRows(dbPath, limit)
}

export interface PromptHistorySnapshot {
  dbPath: string
  mtimeMs: number
  items: PreparedPromptHistoryEntry[]
  index: PromptHistoryIndex
}

let cachedPromptHistory: PromptHistorySnapshot | undefined
let promptHistoryRefresh: Promise<PromptHistorySnapshot> | undefined

export function getCachedPromptHistorySnapshot(): PromptHistorySnapshot | undefined {
  return cachedPromptHistory
}

export function refreshPromptHistorySnapshot(dbPath = resolveHistoryDbPath()): Promise<PromptHistorySnapshot> {
  if (!promptHistoryRefresh) {
    promptHistoryRefresh = (async () => {
      const mtimeMs = existsSync(dbPath) ? statSync(dbPath).mtimeMs : -1
      if (cachedPromptHistory?.dbPath === dbPath && cachedPromptHistory.mtimeMs === mtimeMs) {
        return cachedPromptHistory
      }
      const entries = await loadPromptHistoryEntriesAsync(dbPath, MAX_PROMPT_HISTORY_ENTRIES).catch(
        () => loadPromptHistoryEntries(dbPath, MAX_PROMPT_HISTORY_ENTRIES),
      )
      const items = preparePromptHistoryEntries(entries)
      cachedPromptHistory = { dbPath, mtimeMs, items, index: PromptHistoryIndex.fromPrepared(items) }
      return cachedPromptHistory
    })()
    void promptHistoryRefresh.finally(() => {
      promptHistoryRefresh = undefined
    })
  }
  return promptHistoryRefresh
}

async function loadPromptHistoryEntriesAsync(dbPath: string, limit: number): Promise<PromptHistoryEntry[]> {
  const worker = new Worker(new URL("./history-worker.js", import.meta.url), {
    workerData: { dbPath, limit },
  })
  try {
    return await new Promise<PromptHistoryEntry[]>((resolve, reject) => {
      worker.once("message", resolve)
      worker.once("error", reject)
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`history worker exited with code ${code}`))
      })
    })
  } finally {
    void worker.terminate()
  }
}

function loadPromptRows(dbPath: string, limit: number): PromptHistoryEntry[] {
  return loadPromptRowsWithNodeSqlite(dbPath, limit) ?? loadPromptRowsWithBunSqlite(dbPath, limit) ?? []
}

function loadPromptRowsWithNodeSqlite(dbPath: string, limit: number): PromptHistoryEntry[] | undefined {
  let db: import("node:sqlite").DatabaseSync | undefined
  try {
    const sqlite = requireNodeSqlite()
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    for (const sql of candidates) {
      try {
        const rows = db.prepare(sql).all(limit) as StatementRows
        const parsed = rows.map(normalizeRow).filter((entry): entry is PromptHistoryEntry => Boolean(entry?.prompt))
        if (parsed.length > 0) return parsed
      } catch {
        // Try the next known schema candidate.
      }
    }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
  return undefined
}

interface BunSqliteModule {
  Database: new (path: string, options?: { readonly?: boolean }) => {
    query(sql: string): { all(...args: unknown[]): StatementRows }
    close(): void
  }
}

function loadPromptRowsWithBunSqlite(dbPath: string, limit: number): PromptHistoryEntry[] | undefined {
  let db: InstanceType<BunSqliteModule["Database"]> | undefined
  try {
    const sqlite = requireBunSqlite()
    if (!sqlite) return undefined
    db = new sqlite.Database(dbPath, { readonly: true })
    for (const sql of candidates) {
      try {
        const rows = db.query(sql).all(limit)
        const parsed = rows.map(normalizeRow).filter((entry): entry is PromptHistoryEntry => Boolean(entry?.prompt))
        if (parsed.length > 0) return parsed
      } catch {
        // Try the next known schema candidate.
      }
    }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
  return undefined
}

const candidates = [
  `with recent_user_messages as (
      select m.id, m.time_created as createdAt
      from message m
      where json_extract(m.data, '$.role') = 'user'
        and exists (
          select 1
          from part p
          where p.message_id = m.id
            and json_extract(p.data, '$.type') = 'text'
            and json_extract(p.data, '$.text') is not null
            and coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
        )
      order by m.time_created desc
      limit ?
    )
    select id, group_concat(text, char(10)) as prompt, createdAt
    from (
      select m.id as id, json_extract(p.data, '$.text') as text, m.createdAt, p.time_created as partCreatedAt
      from recent_user_messages m
      join part p on p.message_id = m.id
      where json_extract(p.data, '$.type') = 'text'
        and json_extract(p.data, '$.text') is not null
        and coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
      order by m.createdAt desc, p.time_created asc
    )
    group by id, createdAt
    order by createdAt desc`,
  `select id, json_extract(prompt, '$.text') as prompt, time_created as createdAt
    from session_input
    where json_extract(prompt, '$.text') is not null
    order by time_created desc
    limit ?`,
  `select id, prompt, time_created as createdAt from session_input order by time_created desc limit ?`,
  `select id, text as prompt, time_created as createdAt from message where role = 'user' order by time_created desc limit ?`,
  `select id, prompt, created_at as createdAt from prompt_history order by created_at desc limit ?`,
  `select id, content as prompt, created_at as createdAt from messages where role = 'user' order by created_at desc limit ?`,
]

function normalizeRow(row: Record<string, unknown>): PromptHistoryEntry | undefined {
  const prompt = typeof row.prompt === "string" ? row.prompt : undefined
  if (!prompt) return undefined
  const id = typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : prompt.slice(0, 32)
  const rawCreatedAt = row.createdAt
  const createdAt =
    typeof rawCreatedAt === "number"
      ? rawCreatedAt
      : typeof rawCreatedAt === "string"
        ? Date.parse(rawCreatedAt) || Number(rawCreatedAt) || 0
        : 0
  return { id, prompt, createdAt }
}

function requireNodeSqlite(): typeof import("node:sqlite") {
  return process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
}

function requireBunSqlite(): BunSqliteModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as unknown as ((id: string) => unknown) | undefined
  const builtin = getBuiltinModule?.("bun:sqlite")
  if (isBunSqliteModule(builtin)) return builtin

  const req = Function("return typeof require === 'function' ? require : undefined")() as
    | ((id: string) => unknown)
    | undefined
  const required = req?.("bun:sqlite")
  return isBunSqliteModule(required) ? required : undefined
}

function isBunSqliteModule(value: unknown): value is BunSqliteModule {
  return !!value && typeof value === "object" && typeof (value as { Database?: unknown }).Database === "function"
}
