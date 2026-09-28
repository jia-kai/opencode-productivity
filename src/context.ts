import type { SessionContext } from "@opencode/plugin/promise/session"

export interface ContextRow {
  name: string
  characters: number
  tokens: number
  items: number
  details: Array<{ name: string; tokens: number }>
}

export interface ContextReport {
  capturedAt: number
  model: SessionContext["model"]
  agent: string
  tokens: number
  rows: ContextRow[]
  media: number
}

export function formatContextReport(report: ContextReport, contextLimit?: number): string {
  const count = (value: number) => value.toLocaleString("en-US")
  const percent = (tokens: number) => `${(report.tokens ? tokens / report.tokens * 100 : 0).toFixed(1)}%`
  const width = Math.max("Category".length, ...report.rows.map((row) => row.name.length))
  const lines = [
    `Model: ${report.model.providerID}/${report.model.id}`,
    `Agent: ${report.agent}`,
    `Captured: ${new Date(report.capturedAt).toLocaleString()}`,
    "",
    `Estimated input: ~${count(report.tokens)} tokens`,
    contextLimit ? `Context limit: ${count(contextLimit)} tokens · ~${(report.tokens / contextLimit * 100).toFixed(1)}% used` : "Context limit: unavailable",
    "",
    `${"Category".padEnd(width)}  ${"Tokens".padStart(9)}  ${"Share".padStart(6)}`,
    "─".repeat(width + 19),
    ...report.rows.map((row) => `${row.name.padEnd(width)}  ${(`~${count(row.tokens)}`).padStart(9)}  ${percent(row.tokens).padStart(6)}`),
    ...(report.rows.length ? [] : ["No text or tool definitions in this request."]),
  ]
  for (const row of report.rows) {
    if (!row.details.length) continue
    lines.push("", `${row.name} — details`, "─".repeat(row.name.length + 10))
    for (const detail of row.details) lines.push(`  ~${count(detail.tokens)} tokens  ${detail.name}`)
  }
  lines.push("", "Estimate notes", "─".repeat(14),
    "Counts use 1 token per 4 Unicode characters, not a model tokenizer.",
    "Message framing and media token costs are excluded. Provider state may be opaque.",
    "This snapshot precedes the response; new output and composer edits are excluded.",
    "Changes made by later context hooks are excluded. Send another message to refresh.")
  if (report.media) lines.push(`${count(report.media)} media attachments excluded from the estimate.`)
  return lines.join("\n")
}

// A deliberately transparent heuristic, independent of provider/tokenizer.
export const estimateTokens = (text: string) => Math.ceil(Array.from(text).length / 4)

export function analyzeContext(context: Pick<SessionContext, "system" | "messages" | "tools" | "model" | "agent">, capturedAt = Date.now()): ContextReport {
  const rows = new Map<string, ContextRow>()
  let media = 0
  const add = (name: string, text: string, detail?: string) => {
    if (!text) return
    const row = rows.get(name) ?? { name, characters: 0, tokens: 0, items: 0, details: [] }
    row.characters += Array.from(text).length
    const tokens = estimateTokens(text)
    row.tokens += tokens
    row.items++
    if (detail) {
      const existing = row.details.find((entry) => entry.name === detail)
      if (existing) existing.tokens += tokens
      else row.details.push({ name: detail, tokens })
    }
    rows.set(name, row)
  }
  const system = (text: string) => {
    // Extract only recognizable host-generated sections, never classify user
    // text by keywords. Preserve every character exactly once in the breakdown.
    const pattern = /Skills provide specialized instructions[\s\S]*?<\/available_skills>|<available_skills>[\s\S]*?<\/available_skills>/g
    let offset = 0
    for (const match of text.matchAll(pattern)) {
      instructions(text.slice(offset, match.index))
      add("Skills catalog", match[0])
      offset = match.index! + match[0].length
    }
    instructions(text.slice(offset))
  }
  const instructions = (text: string) => {
    const marker = /^Instructions from: (.+)$/gm
    const matches = [...text.matchAll(marker)]
    if (!matches.length) { add("System prompt / other instructions", text); return }
    add("System prompt / other instructions", text.slice(0, matches[0].index))
    matches.forEach((match, index) => {
      const file = match[1].trim()
      add(/(?:^|\/)AGENTS\.md$/i.test(file) ? "AGENTS.md" : "Other instruction files",
        text.slice(match.index, matches[index + 1]?.index ?? text.length), file)
    })
  }
  for (const part of context.system) system(part.text)
  for (const [name, tool] of Object.entries(context.tools)) {
    add("Tool definitions", JSON.stringify({ name, description: tool.description, input: tool.input }), name)
  }
  for (const message of context.messages) {
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (message.role === "system") system(part.text)
          else add(message.role === "user" ? "User messages" : "Assistant messages", part.text)
          break
        case "tool-call": add("Tool calls", JSON.stringify({ name: part.name, input: part.input }), part.name); break
        case "tool-result":
          add(part.name === "skill" ? "Loaded skills" : "Tool results", JSON.stringify(part.result), part.name)
          break
        case "media": media++; break
        case "reasoning": add("Reasoning / provider state", JSON.stringify(part)); break
        case "compaction": add("Compaction / provider state", JSON.stringify(part)); break
        default: add("Other message parts", JSON.stringify(part))
      }
    }
  }
  const result = [...rows.values()].sort((a, b) => b.tokens - a.tokens)
  for (const row of result) row.details.sort((a, b) => b.tokens - a.tokens)
  return { capturedAt, model: context.model, agent: context.agent, tokens: result.reduce((total, row) => total + row.tokens, 0), rows: result, media }
}

// Keep aggregates only, with a bounded number of sessions. No prompt bodies
// or tool outputs are retained or written to disk.
export class ContextSnapshots {
  private readonly reports = new Map<string, ContextReport>()
  constructor(private readonly limit = 100) {}
  capture(context: SessionContext) {
    const report = analyzeContext(context)
    this.reports.delete(context.sessionID)
    this.reports.set(context.sessionID, report)
    if (this.reports.size > this.limit) this.reports.delete(this.reports.keys().next().value!)
  }
  get(sessionID: string) { return this.reports.get(sessionID) }
}
