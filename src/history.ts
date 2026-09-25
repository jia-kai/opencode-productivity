import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

export interface PromptHistoryEntry {
  id: string
  prompt: string
  createdAt: number
}
export interface PromptHistoryMatch extends PromptHistoryEntry { score: number }
export const MAX_PROMPT_HISTORY_ENTRIES = 4_096
export const MAX_VISIBLE_PROMPT_HISTORY_MATCHES = 100

export function resolveHistoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_HISTORY_DB || path.join(env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode", "opencode.db")
}

export function dedupePrompts(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
  const seen = new Set<string>()
  return entries.sort((a, b) => b.createdAt - a.createdAt).filter((entry) => {
    const key = entry.prompt.trim().replace(/\s+/g, " ")
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function words(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
}

export class PromptHistoryIndex {
  private readonly entries: PromptHistoryEntry[]
  private readonly postings = new Map<string, Set<number>>()
  constructor(entries: PromptHistoryEntry[]) {
    this.entries = dedupePrompts(entries)
    this.entries.forEach((entry, index) => {
      for (const word of new Set(words(entry.prompt))) {
        let posting = this.postings.get(word)
        if (!posting) this.postings.set(word, posting = new Set())
        posting.add(index)
      }
    })
  }
  find(query: string, limit = MAX_VISIBLE_PROMPT_HISTORY_MATCHES): PromptHistoryMatch[] {
    const terms = [...new Set(words(query))]
    if (terms.length === 0) return this.entries.slice(0, limit).map((entry) => ({ ...entry, score: 1 }))
    const lists = terms.map((term) => this.postings.get(term))
    if (lists.some((list) => !list)) return []
    const smallest = lists.reduce((a, b) => a!.size <= b!.size ? a : b)!
    const matches: PromptHistoryMatch[] = []
    for (const index of smallest) {
      if (lists.every((list) => list!.has(index))) matches.push({ ...this.entries[index], score: terms.length })
      if (matches.length >= limit) break
    }
    return matches
  }
}

export function rankPromptHistory(entries: PromptHistoryEntry[], query: string, limit = 50): PromptHistoryMatch[] {
  return new PromptHistoryIndex(entries).find(query, limit)
}
export function filterPromptHistory(entries: PromptHistoryEntry[], query: string, limit = MAX_VISIBLE_PROMPT_HISTORY_MATCHES): PromptHistoryMatch[] {
  return rankPromptHistory(entries, query, limit)
}

export function searchPromptHistory(query: string, options: { limit?: number; dbPath?: string } = {}): PromptHistoryMatch[] {
  const dbPath = options.dbPath ?? resolveHistoryDbPath()
  if (!existsSync(dbPath)) return []
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(`
      select m.id, m.time_created as createdAt, group_concat(json_extract(p.data, '$.text'), char(10)) as prompt
      from (select id, time_created from message
            where json_extract(data, '$.role') = 'user'
              and exists (select 1 from part p0 where p0.message_id = message.id
                and json_extract(p0.data, '$.type') = 'text'
                and coalesce(json_extract(p0.data, '$.synthetic'), 0) = 0
                and json_extract(p0.data, '$.text') is not null)
            order by rowid desc limit ?) m
      join part p on p.message_id = m.id
      where json_extract(p.data, '$.type') = 'text'
        and coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
        and json_extract(p.data, '$.text') is not null
      group by m.id, m.time_created
      order by m.time_created desc
    `).all(MAX_PROMPT_HISTORY_ENTRIES) as Array<{ id: string; createdAt: number; prompt: string }>
    return rankPromptHistory(rows, query, Math.min(options.limit ?? 50, MAX_PROMPT_HISTORY_ENTRIES))
  } finally {
    db.close()
  }
}
