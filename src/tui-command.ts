import { searchPromptHistory } from "./history.js"
import { detailedStatus } from "./status.js"
import type { BackgroundManager } from "./background.js"
import type { WakeupScheduler } from "./scheduler.js"
import type { OpenCodeClient } from "./types.js"
import { showToast } from "./delivery.js"

export async function handleTuiCommand(input: unknown, state: {
  client?: OpenCodeClient
  scheduler: WakeupScheduler
  background: BackgroundManager
}): Promise<boolean> {
  const command = extractCommand(input)
  if (!command) return false
  if (command === "oc-history") {
    await openPromptHistory(state.client, extractArguments(input))
    return true
  }
  if (command === "oc-wakeups" || command === "oc-background") {
    await showToast(state.client, detailedStatus(state.scheduler.list(), state.background.list()), "info")
    return true
  }
  return false
}

export async function openPromptHistory(client: OpenCodeClient | undefined, query = ""): Promise<void> {
  const matches = searchPromptHistory(query)
  if (matches.length === 0) {
    await showToast(client, "No prompt history matches found", "warning")
    return
  }
  const best = matches[0]
  if (client?.tui?.appendPrompt) {
    await client.tui.appendPrompt({ body: { text: best.prompt } })
    await showToast(client, `Inserted prompt history match: ${best.prompt.slice(0, 80)}`, "success")
  } else {
    await showToast(client, matches.slice(0, 5).map((match, index) => `${index + 1}. ${match.prompt.slice(0, 80)}`).join("\n"), "info")
  }
}

function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  const properties = typeof record.properties === "object" && record.properties ? (record.properties as Record<string, unknown>) : undefined
  const raw = record.command ?? record.name ?? record.id ?? properties?.command ?? properties?.name ?? properties?.id
  return typeof raw === "string" ? raw.replace(/^\//, "") : undefined
}

function extractArguments(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  const properties = typeof record.properties === "object" && record.properties ? (record.properties as Record<string, unknown>) : undefined
  const raw = record.arguments ?? record.args ?? properties?.arguments ?? properties?.args
  return typeof raw === "string" ? raw : ""
}
