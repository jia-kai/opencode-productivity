import {
  MAX_PROMPT_HISTORY_ENTRIES,
  PromptHistoryIndex,
  searchPromptHistory,
  type PromptHistoryMatch,
} from "./history.js"
import {
  encodeProductivityTuiCommand,
  productivityProjectID,
  startProductivityTuiIpcServer,
  type ProductivityActionResponse,
  type ProductivityPeerSnapshot,
  type ProductivityTuiIpcServer,
} from "./ipc.js"
import {
  sidebarBackgroundStatusCommands,
  type BackgroundStatusSnapshot,
  type ProductivityStatusSnapshot,
} from "./status.js"
import type { WakeupRecord } from "./scheduler.js"
import { latestAssistantMarkdown, previewPalette } from "./preview-support.js"
import { checkPreviewEnvironment } from "./preview-environment.js"
import { encodePreviewPayload, MAX_PREVIEW_CLI_PAYLOAD_LENGTH } from "./preview-payload.js"
import { previewTmuxArgs } from "./preview-tmux.js"
import { createComponent, createElement, insert, setProp } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const PLUGIN_ID = "opencode-productivity-history"
const EMPTY_HISTORY_OPTION_ID = "__opencode_productivity_empty_history__"

export const id = PLUGIN_ID

let activeTuiIpc: ProductivityTuiIpcServer | undefined

export const tui: TuiPlugin = async (api: any) => {
  const directory = api.state?.path?.directory ?? "."
  let tuiIpc: ProductivityTuiIpcServer | undefined
  const [peers, setPeers] = createSignal<ProductivityPeerSnapshot[]>([])
  const refreshPeers = () => {
    setPeers(tuiIpc?.peers() ?? [])
    api.renderer?.requestRender?.()
  }
  try {
    tuiIpc = await startProductivityTuiIpcServer(directory, refreshPeers)
    activeTuiIpc = tuiIpc
  } catch (error) {
    api.ui?.toast?.({ variant: "error", message: error instanceof Error ? error.message : "Failed to start productivity TUI IPC" })
  }

  const announce = () => {
    if (!tuiIpc) return
    const sessionID = currentSessionID(api)
    void api.client?.tui?.publish?.({
      directory: api.state?.path?.directory,
      workspace: api.workspace?.current?.(),
      body: {
        type: "tui.command.execute",
        properties: {
          command: encodeProductivityTuiCommand({
            op: "connect",
            projectID: productivityProjectID(directory),
            socketPath: tuiIpc.socketPath,
            sessionID,
          }),
        },
      },
    }).catch(() => undefined)
  }
  announce()
  const announceInterval = setInterval(announce, 1_000)
  ;(announceInterval as { unref?: () => void }).unref?.()

  const unregister = api.keymap.registerLayer({
    priority: 100,
    commands: [
      {
        namespace: "palette",
        name: "productivity.history.search",
        title: "Search Prompt History",
        desc: "Find an earlier prompt and insert it into the current prompt editor",
        category: "Productivity",
        suggested: true,
        slashName: "oc-history",
        slashAliases: ["history-search", "prompt-history"],
        run() {
          openHistorySelect(api, "")
        },
      },
      {
        namespace: "palette",
        name: "session.new",
        title: "New session",
        desc: "Start a new session and reset productivity plugin state",
        category: "Session",
        slashName: "new",
        slashAliases: ["clear"],
        run() {
          void requestProductivityReset(api)
          api.route?.navigate?.("home")
          api.ui?.dialog?.clear?.()
        },
      },
      {
        namespace: "palette",
        name: "productivity.preview.open",
        title: "Preview Latest Response",
        desc: "Render the latest assistant Markdown and LaTeX in a tmux window",
        category: "Productivity",
        suggested: true,
        slashName: "oc-preview",
        slashAliases: ["preview-response"],
        run() {
          void openMarkdownPreview(api)
        },
      },
      {
        namespace: "palette",
        name: "productivity.background.manage",
        title: "Manage Background Commands",
        desc: "Inspect background command state, view retained output, or cancel running commands",
        category: "Productivity",
        suggested: true,
        slashName: "oc-background",
        slashAliases: ["background-status", "bg"],
        run() {
          openBackgroundManager(api)
        },
      },
      {
        namespace: "palette",
        name: "productivity.wakeups.manage",
        title: "Manage Wakeups",
        desc: "Inspect or cancel scheduled wakeups",
        category: "Productivity",
        suggested: true,
        slashName: "oc-wakeups",
        slashAliases: ["wakeups"],
        run() {
          openWakeupManager(api)
        },
      },
    ],
    bindings: [{ key: "ctrl+r", cmd: "productivity.history.search", desc: "Search prompt history", preventDefault: true }],
  })

  const unregisterSlots = registerStatusSlots(api)
  if (typeof unregister === "function") api.lifecycle.onDispose(unregister)
  api.lifecycle.onDispose(unregisterSlots)
  api.lifecycle.onDispose(() => {
    clearInterval(announceInterval)
    if (activeTuiIpc === tuiIpc) activeTuiIpc = undefined
    void tuiIpc?.close()
  })
}

async function openMarkdownPreview(api: any): Promise<void> {
  const markdown = latestAssistantMarkdown(api)
  if (!markdown) {
    api.ui.toast({ variant: "warning", message: "No assistant response is available to preview." })
    return
  }
  try {
    const environment = await checkPreviewEnvironment()
    const payload = encodePreviewPayload({
      markdown,
      palette: previewPalette(api),
      resourcePath: api.state?.path?.directory,
    })
    if (payload.length > MAX_PREVIEW_CLI_PAYLOAD_LENGTH) {
      throw new Error("The compressed preview is too large to pass safely as a command-line argument.")
    }
    const viewerPath = fileURLToPath(new URL("./preview-window.js", import.meta.url))
    const child = spawn(environment.tmux, previewTmuxArgs(environment.node, viewerPath, payload), {
      stdio: ["ignore", "ignore", "ignore"],
    })
    let spawned = false
    child.once("error", (error) => {
      api.ui.toast({ variant: "error", message: `Failed to open tmux preview: ${error.message}` })
    })
    child.once("spawn", () => {
      spawned = true
    })
    child.once("close", (code: number | null) => {
      if (!spawned || code === 0) {
        if (code === 0) {
          api.ui.toast({ variant: "success", message: "Opened Markdown preview in tmux." })
        }
        return
      }
      api.ui.toast({ variant: "error", message: `tmux failed to open the preview (exit ${code ?? "unknown"}).` })
    })
  } catch (error) {
    api.ui.toast({
      variant: "error",
      message: error instanceof Error ? error.message : "Failed to render Markdown preview",
      duration: 8_000,
    })
  }
}

function openBackgroundManager(api: any) {
  const snapshot = readSelectedSnapshot(api)
  if (snapshot.commands.length === 0) {
    showAlert(api, "Background Commands", "No background commands.")
    return
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Background Commands",
      placeholder: "Filter commands",
      options: snapshot.commands.slice().reverse().map((command) => ({
        title: `${command.name} (${command.id})`,
        description: `${command.status} · ${command.processStatus}`,
        footer: command.command,
        value: command,
      })),
      onSelect: (option: { value: BackgroundStatusSnapshot }) => openBackgroundActions(api, option.value),
    }),
  )
}

function openBackgroundActions(api: any, command: BackgroundStatusSnapshot) {
  const actions = [
    { title: "View stdout tail", description: "Show retained stdout lines", value: { action: "stdout" } },
    { title: "View stderr tail", description: "Show retained stderr lines", value: { action: "stderr" } },
    ...(command.status === "running"
      ? [{ title: "Cancel command", description: "Kill process and notify the originating LLM session", value: { action: "cancel" } }]
      : []),
  ]
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `${command.name} (${command.id})`,
      placeholder: "Choose action",
      options: actions,
      onSelect: async (option: { value: { action: string } }) => {
        if (option.value.action === "cancel") {
          const response = await sendAction(api, { action: "cancel-background", target: command.id })
          showAlert(api, response.title, response.message)
          return
        }
        const response = await sendAction(api, {
          action: "pull-background-output",
          target: command.id,
          stream: option.value.action === "stderr" ? "stderr" : "stdout",
          tail: 120,
          limit: 200,
        })
        showAlert(api, response.title, response.message)
      },
    }),
  )
}

function openWakeupManager(api: any) {
  const snapshot = readSelectedSnapshot(api)
  const wakeups = snapshot.wakeups.filter((wakeup) => wakeup.status === "scheduled")
  if (wakeups.length === 0) {
    showAlert(api, "Wakeups", "No scheduled wakeups.")
    return
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Wakeups",
      placeholder: "Filter wakeups",
      options: wakeups.map((wakeup) => ({
        title: `${wakeup.name} (${wakeup.id})`,
        description: `${wakeup.dueInSeconds}s · ${wakeup.runAt}`,
        footer: wakeup.message,
        value: wakeup,
      })),
      onSelect: (option: { value: WakeupRecord }) => openWakeupActions(api, option.value),
    }),
  )
}

function openWakeupActions(api: any, wakeup: WakeupRecord) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `${wakeup.name} (${wakeup.id})`,
      placeholder: "Choose action",
      options: [
        { title: "View details", description: wakeup.runAt, footer: wakeup.message, value: { action: "details" } },
        { title: "Cancel wakeup", description: "Cancel and notify the originating LLM session", value: { action: "cancel" } },
      ],
      onSelect: async (option: { value: { action: string } }) => {
        if (option.value.action === "details") {
          showAlert(api, "Wakeup Details", formatWakeup(wakeup))
          return
        }
        const response = await sendAction(api, { action: "cancel-wakeup", target: wakeup.id })
        showAlert(api, response.title, response.message)
      },
    }),
  )
}

async function sendAction(
  api: any,
  request: { action: "cancel-wakeup" | "cancel-background" | "pull-background-output"; target: string; stream?: "stdout" | "stderr" | "both"; tail?: number; limit?: number },
): Promise<ProductivityActionResponse> {
  const peer = selectedInstance(api)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (!peer || !activeTuiIpc) return { id, respondedAt: "", ok: false, title: "Productivity Action Unavailable", message: "No productivity plugin instance is available for this conversation yet." }
  return await activeTuiIpc.send(peer, { id, ...request })
}

function showAlert(api: any, title: string, message: string) {
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message: message.slice(0, 6_000) }))
}

function formatWakeup(wakeup: WakeupRecord): string {
  return [
    `ID: ${wakeup.id}`,
    `Name: ${wakeup.name}`,
    `Status: ${wakeup.status}`,
    `Run at: ${wakeup.runAt}`,
    `Due: ${wakeup.dueInSeconds}s`,
    `Message: ${wakeup.message}`,
  ].join("\n")
}

export default {
  id: PLUGIN_ID,
  tui,
}

function openHistorySelect(api: any, initialQuery: string) {
  const allMatches = searchPromptHistory(initialQuery, { limit: MAX_PROMPT_HISTORY_ENTRIES })
  const byID = new Map(allMatches.map((match) => [match.id, match]))

  api.ui.dialog.replace(() => HistorySearchDialog({ api, allMatches, byID }))
}

function HistorySearchDialog(props: {
  api: any
  allMatches: PromptHistoryMatch[]
  byID: Map<string, PromptHistoryMatch>
}) {
  const [filter, setFilter] = createSignal("")
  const historyIndex = new PromptHistoryIndex(props.allMatches)
  const visibleMatches = createMemo(() => historyIndex.find(filter()))
  return props.api.ui.DialogSelect({
    title: "Prompt History",
    placeholder: `Search ${props.allMatches.length} prompts`,
    get options() {
      return toHistoryOptions(visibleMatches())
    },
    skipFilter: true,
    onFilter: setFilter,
    onSelect: (option: { value: string }) => {
      const match = props.byID.get(option.value)
      if (!match) return
      insertPrompt(props.api, match.prompt)
      props.api.ui.dialog.clear()
    },
  })
}

function registerStatusSlots(api: any): () => void {
  const [snapshot, setSnapshot] = createSignal(readSelectedSnapshot(api))
  const interval = setInterval(() => {
    setSnapshot(readSelectedSnapshot(api))
    api.renderer?.requestRender?.()
  }, 1_000)
  ;(interval as { unref?: () => void }).unref?.()

  const registration = api.slots.register({
    order: 650,
    slots: {
      sidebar_content() {
        return createComponent(DetailedStatus, { getSnapshot: snapshot })
      },
    },
  })

  return () => {
    clearInterval(interval)
    if (typeof registration === "function") registration()
    else if (typeof registration === "string") api.slots.unregister?.(registration)
  }
}

function DetailedStatus(props: { getSnapshot: () => ProductivityStatusSnapshot }) {
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

function readSelectedSnapshot(api: any): ProductivityStatusSnapshot {
  const instance = selectedInstance(api)
  if (instance) {
    return {
      updatedAt: instance.updatedAt,
      ipc: instance.socketPath ? { instanceID: instance.instanceID, serverPid: instance.serverPid, socketPath: instance.socketPath } : undefined,
      wakeups: instance.wakeups,
      commands: instance.commands,
    }
  }
  return { updatedAt: "", wakeups: [], commands: [] }
}

function selectedInstance(api: any): ProductivityPeerSnapshot | undefined {
  return selectFromPeers(activeTuiIpc?.peers() ?? [], currentSessionID(api))
}

function selectFromPeers(peers: ProductivityPeerSnapshot[], sessionID?: string): ProductivityPeerSnapshot | undefined {
  const fresh = peers.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  if (sessionID) return fresh.find((peer) => peer.sessions.includes(sessionID))
  return fresh[0]
}

function currentSessionID(api: any): string | undefined {
  const route = api.route?.current
  return route?.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
}

async function requestProductivityReset(api: any) {
  const peer = selectedInstance(api)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (!peer || !activeTuiIpc) {
    api.ui?.toast?.({ variant: "error", message: "No productivity plugin instance is available for this conversation yet." })
    return
  }
  const response = await activeTuiIpc.send(peer, { id, action: "reset", target: "session.new" })
  if (!response.ok) {
    api.ui?.toast?.({
      variant: "error",
      message: response.message || "Failed to request productivity state reset",
    })
  }
}

function toHistoryOptions(matches: PromptHistoryMatch[]) {
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

async function insertPrompt(api: any, text: string) {
  if (!text) return
  try {
    await api.client.tui.appendPrompt({
      directory: api.state.path.directory,
      workspace: api.workspace?.current?.(),
      text,
    })
    api.ui.toast({ variant: "success", message: "Inserted prompt history entry" })
  } catch (error) {
    api.ui.toast({
      variant: "error",
      message: error instanceof Error ? error.message : "Failed to insert prompt history entry",
    })
  }
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function wrapPreview(value: string, width: number, maxLines: number): string {
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
