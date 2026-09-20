import { type PreparedPromptHistoryEntry } from "./history.js"
import { currentHistoryDialogState, DetailedStatus, EMPTY_HISTORY_OPTION_ID, ensurePromptHistoryLoaded, formatWakeup, toHistoryOptions, wrapPreview } from "./tui-shared.js"
import { setup } from "./tui-v2.js"
import {
  startProductivityTuiIpcServer,
  type ProductivityActionResponse,
  type ProductivityPeerSnapshot,
  type ProductivityTuiIpcServer,
} from "./ipc.js"
import {
  type BackgroundStatusSnapshot,
  type ProductivityStatusSnapshot,
} from "./status.js"
import type { WakeupRecord } from "./scheduler.js"
import { latestAssistantMarkdown, previewPalette } from "./preview-support.js"
import { checkPreviewEnvironment } from "./preview-environment.js"
import { encodePreviewPayload, MAX_PREVIEW_CLI_PAYLOAD_LENGTH } from "./preview-payload.js"
import { previewTmuxArgs } from "./preview-tmux.js"
import { createComponent } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const PLUGIN_ID = "opencode-productivity-history"

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
          openHistorySelect(api)
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
    if (activeTuiIpc === tuiIpc) activeTuiIpc = undefined
    void tuiIpc?.close()
  })
  ensurePromptHistoryLoaded()
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

/**
 * Hybrid default export: OpenCode v2 TUI loaders consume `id` + `setup`,
 * while OpenCode v1 TUI loaders consume `id` + `tui` (mirrors the
 * dynamic-context-pruning v2 migration).
 */
export default {
  id: PLUGIN_ID,
  setup,
  tui,
}

function openHistorySelect(api: any) {
  const [version, setVersion] = createSignal(0)
  ensurePromptHistoryLoaded(() => setVersion((value) => value + 1))
  api.ui.dialog.replace(() => HistorySearchDialog({ api, version }))
}

function HistorySearchDialog(props: {
  api: any
  version: () => number
}) {
  const [filter, setFilter] = createSignal("")
  const snapshot = () => (props.version(), currentHistoryDialogState())
  const visibleMatches = createMemo(() => {
    const index = snapshot().index
    return index ? index.find(filter()) : []
  })
  const byID = createMemo(() => {
    const matches = new Map<string, PreparedPromptHistoryEntry>()
    for (const item of snapshot().items) matches.set(item.id, item)
    return matches
  })
  return props.api.ui.DialogSelect({
    title: "Prompt History",
    placeholder: snapshot().index ? `Search ${snapshot().items.length} prompts` : "Loading prompt history",
    get options() {
      const state = snapshot()
      if (!state.index) {
        return [{
          title: "Loading prompt history…",
          value: EMPTY_HISTORY_OPTION_ID,
          description: "One moment",
        }]
      }
      return toHistoryOptions(visibleMatches())
    },
    skipFilter: true,
    onFilter: setFilter,
    onSelect: (option: { value: string }) => {
      if (option.value === EMPTY_HISTORY_OPTION_ID) return
      const match = byID().get(option.value)
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
