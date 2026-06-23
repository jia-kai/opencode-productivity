import { rankPromptHistory, searchPromptHistory, type PromptHistoryMatch } from "./history.js"
import {
  consumeActionResponse,
  detailedStatus,
  readStatusSnapshot,
  writeActionRequest,
  writeResetRequest,
  type BackgroundStatusSnapshot,
  type ProductivityActionResponse,
  type ProductivityStatusSnapshot,
} from "./status.js"
import type { WakeupRecord } from "./scheduler.js"
import { createComponent, createElement, insert, setProp } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

const HISTORY_INDEX_LIMIT = 5_000
const HISTORY_VISIBLE_LIMIT = 160
const PLUGIN_ID = "opencode-productivity-history"

export const id = PLUGIN_ID

export const tui: TuiPlugin = async (api: any) => {
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
          requestProductivityReset(api)
          api.route?.navigate?.("home")
          api.ui?.dialog?.clear?.()
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
}

function openBackgroundManager(api: any) {
  const snapshot = readSnapshot(api)
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
  const snapshot = readSnapshot(api)
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
  const directory = api.state?.path?.directory ?? "."
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  writeActionRequest(directory, { id, ...request })
  const response = await waitForActionResponse(directory, id)
  if (response) return response
  return { id, respondedAt: "", ok: false, title: "Productivity Action Timed Out", message: "The server plugin did not respond to the TUI request." }
}

async function waitForActionResponse(directory: string, id: string): Promise<ProductivityActionResponse | undefined> {
  for (let i = 0; i < 40; i++) {
    const response = consumeActionResponse(directory, id)
    if (response) return response
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return undefined
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
  const allMatches = searchPromptHistory("", { limit: HISTORY_INDEX_LIMIT })
  const byID = new Map(allMatches.map((match) => [match.id, match]))

  api.ui.dialog.replace(() => HistorySearchDialog({ api, initialQuery, allMatches, byID }))
}

function HistorySearchDialog(props: {
  api: any
  initialQuery: string
  allMatches: PromptHistoryMatch[]
  byID: Map<string, PromptHistoryMatch>
}) {
  const rank = (query: string) => toHistoryOptions(rankPromptHistory(props.allMatches, query.trim(), HISTORY_VISIBLE_LIMIT))
  const [options, setOptions] = createSignal(rank(props.initialQuery))
  return props.api.ui.DialogSelect({
    title: "Prompt History",
    placeholder: `Filter ${props.allMatches.length} prompts`,
    get options() {
      return options()
    },
    skipFilter: true,
    onFilter: (query: string) => setOptions(rank(query)),
    onSelect: (option: { value: string }) => {
      const match = props.byID.get(option.value)
      if (!match) return
      insertPrompt(props.api, match.prompt)
      props.api.ui.dialog.clear()
    },
  })
}

function registerStatusSlots(api: any): () => void {
  const [snapshot, setSnapshot] = createSignal(readSnapshot(api))
  const interval = setInterval(() => {
    setSnapshot(readSnapshot(api))
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
  const box = createElement("box")
  setProp(box, "flexDirection", "column")
  insert(box, () => {
    const snapshot = props.getSnapshot()
    return detailedStatus(snapshot.wakeups, snapshot.commands).split("\n").filter(Boolean).map(renderStatusLine)
  })
  return box
}

function renderStatusLine(line: string) {
  const text = createElement("text")
  setProp(text, "wrapMode", "word")
  insert(text, line)
  return text
}

function readSnapshot(api: any) {
  return readStatusSnapshot(api.state?.path?.directory ?? ".")
}

function requestProductivityReset(api: any) {
  try {
    writeResetRequest(api.state?.path?.directory ?? ".", "session.new")
  } catch (error) {
    api.ui?.toast?.({
      variant: "error",
      message: error instanceof Error ? error.message : "Failed to request productivity state reset",
    })
  }
}

function toHistoryOptions(matches: PromptHistoryMatch[]) {
  return matches.map((match) => ({
    title: oneLine(match.prompt).slice(0, 100),
    value: match.id,
    description: new Date(match.createdAt).toLocaleString(),
    footer: oneLine(match.prompt).slice(0, 140),
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
