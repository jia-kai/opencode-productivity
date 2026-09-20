import {
  sidebarBackgroundStatusCommands,
  type BackgroundStatusSnapshot,
  type ProductivityStatusSnapshot,
} from "./status.js"
import type { WakeupRecord } from "./scheduler.js"
import {
  PromptHistoryIndex,
  refreshPromptHistorySnapshot,
  type PreparedPromptHistoryEntry,
  type PromptHistoryMatch,
} from "./history.js"
import { createComponent, createElement, insert, setProp } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"

export const EMPTY_HISTORY_OPTION_ID = "__opencode_productivity_empty_history__"

export function formatWakeup(wakeup: WakeupRecord): string {
  return [
    `ID: ${wakeup.id}`,
    `Name: ${wakeup.name}`,
    `Status: ${wakeup.status}`,
    `Run at: ${wakeup.runAt}`,
    `Due: ${wakeup.dueInSeconds}s`,
    `Message: ${wakeup.message}`,
  ].join("\n")
}

export function DetailedStatus(props: { getSnapshot: () => ProductivityStatusSnapshot }) {
  const wakeups = createMemo(() => props.getSnapshot().wakeups.filter((wakeup) => wakeup.status === "scheduled").slice(0, 5))
  const commands = createMemo(() => sidebarBackgroundStatusCommands(props.getSnapshot().commands))

  const box = createElement("box")
  setProp(box, "flexDirection", "column")
  setProp(box, "gap", 1)
  insert(box, [
    StatusSection({
      title: "Wakeup status",
      rows: () => wakeups().map((wakeup) => ({ text: `${wakeup.name} ${formatSidebarWakeupTime(wakeup.runAt)}: ${wakeup.message}` })),
    }),
    StatusSection({
      title: "Background status",
      rows: () => commands().map(formatSidebarBackgroundRow),
    }),
  ])
  return box
}

interface StatusRow {
  text: string
  fg?: string
}

function StatusSection(props: { title: string; rows: () => StatusRow[] }) {
  const [open, setOpen] = createSignal(true)
  const box = createElement("box")
  setProp(box, "flexDirection", "column")

  const header = createElement("text")
  setProp(header, "wrapMode", "word")
  setProp(header, "attributes", TextAttributes.BOLD)
  setProp(header, "onMouseDown", () => props.rows().length > 0 && setOpen((value) => !value))
  insert(header, () => {
    const rows = props.rows()
    if (rows.length === 0) return ""
    return `${open() ? "▼" : "▶"} ${props.title}`
  })
  insert(box, header)

  const rowsBox = createElement("box")
  setProp(rowsBox, "flexDirection", "column")
  insert(rowsBox, () => {
    if (!open()) return []
    return props.rows().map((row) => StatusRowText(row))
  })
  insert(box, rowsBox)
  return box
}

function StatusRowText(row: StatusRow) {
  const text = createElement("text")
  setProp(text, "wrapMode", "word")
  if (row.fg) setProp(text, "fg", row.fg)
  insert(text, `- ${row.text}`)
  return text
}

function formatSidebarBackgroundRow(command: BackgroundStatusSnapshot): StatusRow {
  const exitCode = command.exitCode
  if (command.status === "running" || typeof exitCode !== "number") {
    return { text: `${command.id} ${command.status}: ${command.command}` }
  }
  return {
    text: `${command.id} exit ${exitCode}: ${command.command}`,
    fg: exitCode === 0 ? "white" : "red",
  }
}

function formatSidebarWakeupTime(runAt: string, now = new Date()): string {
  const date = new Date(runAt)
  if (!Number.isFinite(date.getTime())) return runAt
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (isSameLocalDay(date, now)) return time
  const dateOptions: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" }
  return `${date.toLocaleDateString(undefined, dateOptions)} ${time}`
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

export function toHistoryOptions(matches: PromptHistoryMatch[]) {
  if (matches.length === 0) {
    return [{
      title: "No prompt history matches",
      value: EMPTY_HISTORY_OPTION_ID,
      description: "Keep typing or press Esc",
    }]
  }
  return matches.map((match) => ({
    title: wrapPreview(match.prompt, 88, 4),
    value: match.id,
    description: new Date(match.createdAt).toLocaleString(),
    footer: wrapPreview(match.prompt, 88, 6),
  }))
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

export function wrapPreview(value: string, width: number, maxLines: number): string {
  const words = oneLine(value).split(" ").filter(Boolean)
  if (words.length === 0) return ""

  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (lines.length >= maxLines) break
    if (word.length > width) {
      if (line) {
        lines.push(line)
        line = ""
        if (lines.length >= maxLines) break
      }
      for (let index = 0; index < word.length && lines.length < maxLines; index += width) {
        const chunk = word.slice(index, index + width)
        if (chunk.length === width && index + width < word.length && lines.length === maxLines - 1) {
          lines.push(`${chunk.slice(0, Math.max(0, width - 3))}...`)
          break
        }
        lines.push(chunk)
      }
      continue
    }

    const next = line ? `${line} ${word}` : word
    if (next.length <= width) {
      line = next
      continue
    }
    lines.push(line)
    line = word
  }
  if (line && lines.length < maxLines) lines.push(line)

  const rendered = lines.slice(0, maxLines)
  if (words.join(" ").length > rendered.join(" ").length && rendered.length > 0) {
    const last = rendered[rendered.length - 1]
    rendered[rendered.length - 1] = `${last.slice(0, Math.max(0, width - 3))}...`
  }
  return rendered.join("\n")
}

export interface HistoryDialogState {
  status: "loading" | "ready"
  items: PreparedPromptHistoryEntry[]
  index: PromptHistoryIndex | undefined
}

let historyDialogState: HistoryDialogState = { status: "loading", items: [], index: undefined }
let historyRefreshInFlight: Promise<void> | undefined

export function ensurePromptHistoryLoaded(onUpdate?: () => void): Promise<void> {
  const pending = refreshPromptHistorySnapshot()
  if (historyRefreshInFlight) {
    if (onUpdate) void historyRefreshInFlight.then(onUpdate, onUpdate)
    return historyRefreshInFlight
  }
  historyRefreshInFlight = pending
    .then((snapshot) => {
      historyDialogState = { status: "ready", items: snapshot.items, index: snapshot.index }
      onUpdate?.()
    })
    .catch(() => {
      historyDialogState = { status: "ready", items: [], index: PromptHistoryIndex.fromPrepared([]) }
      onUpdate?.()
    })
    .finally(() => {
      historyRefreshInFlight = undefined
    })
  return historyRefreshInFlight
}

export function currentHistoryDialogState(): HistoryDialogState {
  return historyDialogState
}
