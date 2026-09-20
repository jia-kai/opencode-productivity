import {
  startProductivityTuiIpcServer,
  type ProductivityActionResponse,
  type ProductivityPeerSnapshot,
  type ProductivityTuiIpcServer,
} from "./ipc.js"
import {
  currentHistoryDialogState,
  DetailedStatus,
  EMPTY_HISTORY_OPTION_ID,
  ensurePromptHistoryLoaded,
  formatWakeup,
  toHistoryOptions,
  wrapPreview,
  type HistoryDialogState,
} from "./tui-shared.js"
import type { PromptHistoryMatch } from "./history.js"
import { type BackgroundStatusSnapshot, type ProductivityStatusSnapshot } from "./status.js"
import type { WakeupRecord } from "./scheduler.js"
import { checkPreviewEnvironment } from "./preview-environment.js"
import { encodePreviewPayload, MAX_PREVIEW_CLI_PAYLOAD_LENGTH } from "./preview-payload.js"
import { previewTmuxArgs } from "./preview-tmux.js"
import type { PreviewPalette } from "./vendor/pi-markdown-preview.js"
import { createComponent, createElement, insert, setProp } from "@opentui/solid"
import { TextAttributes, type KeyEvent } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

type TuiContext = Parameters<Plugin.Definition["setup"]>[0]

/**
 * OpenCode v2 TUI plugin setup. Mirrors the v1 TUI plugin in src/tui.tsx using
 * the v2 host APIs (keymap layers, promise dialogs, ui slots); where v2 has no
 * equivalent (composer prompt insertion, v1 theme tokens) it falls back to an
 * OSC52 clipboard copy and a fixed palette.
 */

let activeTuiIpc: ProductivityTuiIpcServer | undefined

export const setup: Plugin.Definition["setup"] = async (context) => {
  const directory = context.location?.directory ?? "."
  let tuiIpc: ProductivityTuiIpcServer | undefined
  try {
    tuiIpc = await startProductivityTuiIpcServer(directory, () => {})
    activeTuiIpc = tuiIpc
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      message: error instanceof Error ? error.message : "Failed to start productivity TUI IPC",
    })
  }

  // The keymap provider only exists inside a ui.slot render scope, so the
  // layer must be registered from the app slot's render callback (same as the
  // dynamic-context-pruning v2 TUI plugin).
  const unregisterAppSlot = context.ui.slot({
    append: "app",
    render: (): any => {
      context.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      {
        id: "palette.productivity.history.search",
        title: "Search Prompt History",
        description: "Find an earlier prompt and insert it into the current prompt editor",
        group: "Productivity",
        suggested: true,
        bind: "ctrl+r",
        palette: true,
        slash: { name: "oc-history", aliases: ["history-search", "prompt-history"] },
        run() {
          void openHistorySelect(context)
        },
      },
      {
        id: "palette.session.new",
        title: "New session",
        description: "Start a new session and reset productivity plugin state",
        group: "Session",
        palette: true,
        slash: { name: "new", aliases: ["clear"] },
        run() {
          void requestProductivityReset(context)
          context.ui.router.navigate({ type: "home" })
          context.ui.dialog.clear()
        },
      },
      {
        id: "palette.productivity.preview.open",
        title: "Preview Latest Response",
        description: "Render the latest assistant Markdown and LaTeX in a tmux window",
        group: "Productivity",
        suggested: true,
        palette: true,
        slash: { name: "oc-preview", aliases: ["preview-response"] },
        run() {
          void openMarkdownPreview(context, directory)
        },
      },
      {
        id: "palette.productivity.background.manage",
        title: "Manage Background Commands",
        description: "Inspect background command state, view retained output, or cancel running commands",
        group: "Productivity",
        suggested: true,
        palette: true,
        slash: { name: "oc-background", aliases: ["background-status", "bg"] },
        run() {
          void openBackgroundManager(context)
        },
      },
      {
        id: "palette.productivity.wakeups.manage",
        title: "Manage Wakeups",
        description: "Inspect or cancel scheduled wakeups",
        group: "Productivity",
        suggested: true,
        palette: true,
        slash: { name: "oc-wakeups", aliases: ["wakeups"] },
        run() {
          void openWakeupManager(context)
        },
      },
    ],
    bindings: ["palette.productivity.history.search"],
      }))
      return null
    },
  })

  const [snapshot, setSnapshot] = createSignal(readSelectedSnapshot(context))
  const interval = setInterval(() => {
    setSnapshot(readSelectedSnapshot(context))
  }, 1_000)
  ;(interval as { unref?: () => void }).unref?.()

  const unregisterSlot = context.ui.slot({
    append: "sidebar.content",
    render: (): any => createComponent(DetailedStatus, { getSnapshot: snapshot }),
  })

  ensurePromptHistoryLoaded()

  return () => {
    clearInterval(interval)
    unregisterSlot()
    if (typeof unregisterAppSlot === "function") (unregisterAppSlot as () => void)()
    if (activeTuiIpc === tuiIpc) activeTuiIpc = undefined
    void tuiIpc?.close()
  }
}

interface HistoryKeyInput {
  on: (event: "keypress", handler: (event: KeyEvent) => void) => unknown
  off: (event: "keypress", handler: (event: KeyEvent) => void) => unknown
}

const HISTORY_VISIBLE_ROWS = 12

async function openHistorySelect(context: TuiContext) {
  await ensurePromptHistoryLoaded()
  const dialog = context.ui.dialog as typeof context.ui.dialog & { show?: unknown; set?: unknown }
  const showAvailable = typeof dialog.show === "function"
  const setAvailable = typeof dialog.set === "function"
  if (showAvailable && setAvailable) {
    try {
      await openLiveHistorySearch(context)
      return
    } catch (error) {
      context.ui.toast.show({
        variant: "error",
        message: `Live history search unavailable: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  } else {
    context.ui.toast.show({
      variant: "error",
      message: `Live history search unavailable: dialog.show=${showAvailable} dialog.set=${setAvailable}`,
    })
  }
  await openHistorySelectFallback(context)
}

/**
 * Live-search dialog: re-runs the custom scorer on every keystroke (the same
 * incremental UX as the v1 DialogSelect filter), driven by raw key events from
 * the host renderer's keyInput so it does not depend on plugin-side solid
 * context providers.
 */
async function openLiveHistorySearch(context: TuiContext) {
  const state = currentHistoryDialogState()
  if (!state.index) return
  const keyInput = context.renderer ? (context.renderer.keyInput as unknown as HistoryKeyInput | undefined) : undefined
  context.ui.dialog.set({ size: "large" })
  let settled = false
  let handleKeypress: ((event: KeyEvent) => void) | undefined
  let attached = false
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  function close() {
    if (settled) return
    settled = true
    if (handleKeypress) keyInput?.off("keypress", handleKeypress)
    try {
      context.ui.dialog.clear()
    } catch {}
    resolveClosed()
  }
  try {
    // The overlay must be constructed inside the render callback: element
    // factories resolve the host renderer from the render context.
    context.ui.dialog.show((): any => {
      const overlay = HistorySearchOverlay({
        getState: currentHistoryDialogState,
        onAccept: (match) => {
          close()
          void insertPrompt(context, match.prompt)
        },
        onClose: close,
      })
      if (!attached) {
        attached = true
        handleKeypress = overlay.handleKeypress
        keyInput?.on("keypress", overlay.handleKeypress)
      }
      return overlay.element
    }, close)
  } catch (error) {
    close()
    throw error
  }
  await closed
}

function HistorySearchOverlay(props: {
  getState: () => HistoryDialogState
  onAccept: (match: PromptHistoryMatch) => void
  onClose: () => void
}) {
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)

  const matches = createMemo(() => {
    const index = props.getState().index
    return index ? index.find(query()) : []
  })
  const clampedCursor = () => Math.min(cursor(), Math.max(0, matches().length - 1))
  const windowStart = () =>
    Math.max(0, Math.min(clampedCursor() - Math.floor(HISTORY_VISIBLE_ROWS / 2), matches().length - HISTORY_VISIBLE_ROWS))

  const handleKeypress = (event: KeyEvent) => {
    const name = event.name ?? ""
    if (name === "escape" || (event.ctrl && name === "c")) {
      props.onClose()
      return
    }
    if (name === "return" || name === "enter") {
      const match = matches()[clampedCursor()]
      if (match) props.onAccept(match)
      return
    }
    if (name === "up") {
      setCursor(Math.max(0, clampedCursor() - 1))
      return
    }
    if (name === "down") {
      setCursor(Math.min(matches().length - 1, clampedCursor() + 1))
      return
    }
    if (name === "backspace") {
      setQuery((value) => value.slice(0, -1))
      setCursor(0)
      return
    }
    if (event.ctrl || event.meta || event.super) return
    const sequence = event.sequence ?? ""
    if (sequence.length === 1 && sequence.charCodeAt(0) >= 32) {
      setQuery((value) => `${value}${sequence}`.slice(0, 200))
      setCursor(0)
    }
  }

  const box = createElement("box")
  setProp(box, "flexDirection", "column")
  setProp(box, "gap", 1)

  const title = createElement("text")
  setProp(title, "attributes", TextAttributes.BOLD)
  insert(title, () => {
    const state = props.getState()
    const trimmed = query().trim()
    return trimmed
      ? `Prompt History — prompts matching “${trimmed}”`
      : `Prompt History — search ${state.items.length} prompts. Leave empty to list the most recent.`
  })

  const searchLine = createElement("text")
  setProp(searchLine, "attributes", TextAttributes.BOLD)
  insert(searchLine, () => `❯ ${query()}▌`)

  const listBox = createElement("box")
  setProp(listBox, "flexDirection", "column")
  insert(listBox, () => {
    const all = matches()
    if (all.length === 0) {
      const empty = createElement("text")
      setProp(empty, "fg", "yellow")
      insert(empty, "No prompt history matches. Keep typing or press Esc.")
      return [empty]
    }
    const start = windowStart()
    return all.slice(start, start + HISTORY_VISIBLE_ROWS).map((match, offset) => {
      const selected = start + offset === clampedCursor()
      const row = createElement("box")
      setProp(row, "flexDirection", "column")
      const line = createElement("text")
      setProp(line, "wrapMode", "word")
      if (selected) setProp(line, "attributes", TextAttributes.BOLD)
      insert(line, `${selected ? "▸ " : "  "}${wrapPreview(match.prompt, 96, 1)}`)
      const date = createElement("text")
      setProp(date, "fg", "gray")
      insert(date, `  ${new Date(match.createdAt).toLocaleString()}`)
      insert(row, [line, date])
      return row
    })
  })

  const hint = createElement("text")
  setProp(hint, "fg", "gray")
  insert(hint, "Type to search · ↑/↓ move · enter copy prompt · esc close")

  insert(box, [title, searchLine, listBox, hint])
  return { element: box, handleKeypress }
}

async function openHistorySelectFallback(context: TuiContext) {
  const state = currentHistoryDialogState()
  if (!state.index) return
  const query = await context.ui.dialog.prompt({
    title: "Prompt History",
    description: `Search ${state.items.length} prompts. Leave empty to list the most recent.`,
    placeholder: "Search terms…",
  })
  if (query === undefined) return
  const matches = state.index.find(query)
  const options = toHistoryOptions(matches)
  if (options.length === 1 && options[0].value === EMPTY_HISTORY_OPTION_ID) {
    context.ui.toast.show({ variant: "warning", message: "No prompt history matches." })
    return
  }
  const selected = await context.ui.dialog.select({
    title: query.trim() ? `Prompts matching “${query.trim()}”` : "Recent prompts",
    options,
  })
  if (!selected || selected === EMPTY_HISTORY_OPTION_ID) return
  const match = state.items.find((item) => item.id === selected)
  if (!match) return
  await insertPrompt(context, match.prompt)
}

async function insertPrompt(context: TuiContext, text: string) {
  if (!text) return
  // v2 exposes no composer-insertion API; copy to the clipboard instead.
  const renderer = context.renderer as { copyToClipboardOSC52?: (text: string) => boolean } | undefined
  const copied = renderer?.copyToClipboardOSC52?.(text) ?? false
  context.ui.toast.show({
    variant: copied ? "success" : "warning",
    message: copied
      ? "Prompt history entry copied to clipboard (paste to insert)"
      : "Could not copy prompt history entry to clipboard",
  })
}

async function openMarkdownPreview(context: TuiContext, directory: string) {
  const markdown = latestAssistantMarkdownV2(context)
  if (!markdown) {
    context.ui.toast.show({ variant: "warning", message: "No assistant response is available to preview." })
    return
  }
  try {
    const environment = await checkPreviewEnvironment()
    const payload = encodePreviewPayload({
      markdown,
      palette: DEFAULT_PREVIEW_PALETTE,
      resourcePath: directory,
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
      context.ui.toast.show({ variant: "error", message: `Failed to open tmux preview: ${error.message}` })
    })
    child.once("spawn", () => {
      spawned = true
    })
    child.once("close", (code: number | null) => {
      if (!spawned || code === 0) {
        if (code === 0) {
          context.ui.toast.show({ variant: "success", message: "Opened Markdown preview in tmux." })
        }
        return
      }
      context.ui.toast.show({ variant: "error", message: `tmux failed to open the preview (exit ${code ?? "unknown"}).` })
    })
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      message: error instanceof Error ? error.message : "Failed to render Markdown preview",
      duration: 8_000,
    })
  }
}

/**
 * v2 themes do not expose the v1 token map; the preview renderer uses a fixed
 * Nord-inspired palette instead.
 */
const DEFAULT_PREVIEW_PALETTE: PreviewPalette = {
  mode: "dark",
  background: "#2e3440",
  panel: "#3b4252",
  element: "#434c5e",
  text: "#eceff4",
  muted: "#89929b",
  heading: "#88c0d0",
  link: "#81a1c1",
  code: "#a3be8c",
  quote: "#89929b",
  border: "#3b4252",
  accent: "#88c0d0",
  error: "#bf616a",
  warning: "#ebcb8b",
  success: "#a3be8c",
}

function latestAssistantMarkdownV2(context: TuiContext): string | undefined {
  const route = context.ui.router.current()
  const sessionID = route?.type === "session" && typeof route.sessionID === "string" ? route.sessionID : undefined
  if (!sessionID) return undefined
  const messages = (context.data as unknown as {
    session: { message: { list(sessionID: string): unknown } }
  }).session.message.list(sessionID)
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Record<string, unknown>
    const info = typeof message.info === "object" && message.info ? message.info as Record<string, unknown> : message
    if (info.role !== "assistant") continue
    const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(info.parts) ? info.parts : []
    const text = parts
      .filter((part: unknown) => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text")
      .map((part: unknown) => (part as Record<string, unknown>).text)
      .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n\n")
    if (text) return text
  }
  return undefined
}

async function openBackgroundManager(context: TuiContext) {
  const snapshot = readSelectedSnapshot(context)
  if (snapshot.commands.length === 0) {
    await context.ui.dialog.alert({ title: "Background Commands", message: "No background commands." })
    return
  }
  const selected = await context.ui.dialog.select({
    title: "Background Commands",
    options: snapshot.commands.slice().reverse().map((command) => ({
      title: `${command.name} (${command.id})`,
      description: `${command.status} · ${command.processStatus}`,
      footer: command.command,
      value: command.id,
    })),
  })
  if (!selected) return
  const command = snapshot.commands.find((entry) => entry.id === selected)
  if (!command) return
  await openBackgroundActions(context, command)
}

async function openBackgroundActions(context: TuiContext, command: BackgroundStatusSnapshot) {
  const actions = [
    { title: "View stdout tail", description: "Show retained stdout lines", value: "stdout" },
    { title: "View stderr tail", description: "Show retained stderr lines", value: "stderr" },
    ...(command.status === "running"
      ? [{ title: "Cancel command", description: "Kill process and notify the originating LLM session", value: "cancel" }]
      : []),
  ]
  const action = await context.ui.dialog.select({
    title: `${command.name} (${command.id})`,
    options: actions,
  })
  if (!action) return
  if (action === "cancel") {
    const response = await sendAction(context, { action: "cancel-background", target: command.id })
    await context.ui.dialog.alert({ title: response.title, message: response.message })
    return
  }
  const response = await sendAction(context, {
    action: "pull-background-output",
    target: command.id,
    stream: action === "stderr" ? "stderr" : "stdout",
    tail: 120,
    limit: 200,
  })
  await context.ui.dialog.alert({ title: response.title, message: response.message })
}

async function openWakeupManager(context: TuiContext) {
  const snapshot = readSelectedSnapshot(context)
  const wakeups = snapshot.wakeups.filter((wakeup) => wakeup.status === "scheduled")
  if (wakeups.length === 0) {
    await context.ui.dialog.alert({ title: "Wakeups", message: "No scheduled wakeups." })
    return
  }
  const selected = await context.ui.dialog.select({
    title: "Wakeups",
    options: wakeups.map((wakeup) => ({
      title: `${wakeup.name} (${wakeup.id})`,
      description: `${wakeup.dueInSeconds}s · ${wakeup.runAt}`,
      footer: wakeup.message,
      value: wakeup.id,
    })),
  })
  if (!selected) return
  const wakeup = wakeups.find((entry) => entry.id === selected)
  if (!wakeup) return
  await openWakeupActions(context, wakeup)
}

async function openWakeupActions(context: TuiContext, wakeup: WakeupRecord) {
  const action = await context.ui.dialog.select({
    title: `${wakeup.name} (${wakeup.id})`,
    options: [
      { title: "View details", description: wakeup.runAt, footer: wakeup.message, value: "details" },
      { title: "Cancel wakeup", description: "Cancel and notify the originating LLM session", value: "cancel" },
    ],
  })
  if (!action) return
  if (action === "details") {
    await context.ui.dialog.alert({ title: "Wakeup Details", message: formatWakeup(wakeup) })
    return
  }
  const response = await sendAction(context, { action: "cancel-wakeup", target: wakeup.id })
  await context.ui.dialog.alert({ title: response.title, message: response.message })
}

async function sendAction(
  context: TuiContext,
  request: { action: "cancel-wakeup" | "cancel-background" | "pull-background-output"; target: string; stream?: "stdout" | "stderr" | "both"; tail?: number; limit?: number },
): Promise<ProductivityActionResponse> {
  const peer = selectedInstance(context)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (!peer || !activeTuiIpc) {
    return { id, respondedAt: "", ok: false, title: "Productivity Action Unavailable", message: "No productivity plugin instance is available for this conversation yet." }
  }
  return await activeTuiIpc.send(peer, { id, ...request })
}

async function requestProductivityReset(context: TuiContext) {
  const peer = selectedInstance(context)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (!peer || !activeTuiIpc) {
    context.ui.toast.show({ variant: "error", message: "No productivity plugin instance is available for this conversation yet." })
    return
  }
  const response = await activeTuiIpc.send(peer, { id, action: "reset", target: "session.new" })
  if (!response.ok) {
    context.ui.toast.show({
      variant: "error",
      message: response.message || "Failed to request productivity state reset",
    })
  }
}

function readSelectedSnapshot(context: TuiContext): ProductivityStatusSnapshot {
  const instance = selectedInstance(context)
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

function selectedInstance(context: TuiContext): ProductivityPeerSnapshot | undefined {
  return selectFromPeers(activeTuiIpc?.peers() ?? [], currentSessionID(context))
}

function selectFromPeers(peers: ProductivityPeerSnapshot[], sessionID?: string): ProductivityPeerSnapshot | undefined {
  const fresh = peers.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  if (sessionID) return fresh.find((peer) => peer.sessions.includes(sessionID))
  return fresh[0]
}

function currentSessionID(context: TuiContext): string | undefined {
  const route = context.ui.router.current()
  return route?.type === "session" && typeof route.sessionID === "string" ? route.sessionID : undefined
}
