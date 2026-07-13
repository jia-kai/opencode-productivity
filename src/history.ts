import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

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
  const q = query.trim().toLowerCase()
  const c = candidate.toLowerCase()
  if (!q) return 1
  if (c === q) return 10_000
  if (c.includes(q)) return 5_000 - c.indexOf(q)

  let score = 0
  let lastIndex = -1
  let streak = 0
  for (const char of q) {
    const index = c.indexOf(char, lastIndex + 1)
    if (index === -1) return 0
    streak = index === lastIndex + 1 ? streak + 1 : 1
    score += 20 + streak * 5 - Math.min(index - lastIndex, 20)
    lastIndex = index
  }
  return Math.max(score, 1)
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
  return dedupePrompts(entries)
    .map((entry) => ({ ...entry, score: fuzzyScore(query, entry.prompt) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.createdAt - a.createdAt || b.score - a.score)
    .slice(0, limit)
}

export function filterPromptHistory(
  entries: PromptHistoryEntry[],
  query: string,
  limit = MAX_VISIBLE_PROMPT_HISTORY_MATCHES,
): PromptHistoryMatch[] {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) {
    return dedupePrompts(entries)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((entry) => ({ ...entry, score: 1 }))
  }
  return dedupePrompts(entries)
    .map((entry) => ({ ...entry, score: fuzzyScore(normalizedQuery, entry.prompt) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
    .slice(0, limit)
}

export function searchPromptHistory(query: string, options: HistorySearchOptions = {}): PromptHistoryMatch[] {
  const dbPath = options.dbPath ?? resolveHistoryDbPath()
  if (!existsSync(dbPath)) return []
  const resultLimit = Math.min(options.limit ?? 50, MAX_PROMPT_HISTORY_ENTRIES)
  const rows = loadPromptRows(dbPath, Math.min(Math.max(resultLimit, 200), MAX_PROMPT_HISTORY_ENTRIES))
  return rankPromptHistory(rows, query, resultLimit)
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
