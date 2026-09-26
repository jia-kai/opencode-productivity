import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { jsx } from "@opentui/solid/jsx-runtime"
import { ProductivityRpc } from "./rpc.js"
import { PromptHistoryIndex, searchPromptHistory, type PromptHistoryEntry } from "./history.js"
import type { WakeupRecord } from "./scheduler.js"
import type { ShellInfo } from "@opencode/client"

export default Plugin.define({
  id: "opencode.productivity.tui",
  setup(context) {
    const rpc = context.client.rpc(ProductivityRpc)
    const location = context.location ?? context.data.location.default()
    const [wakeups, setWakeups] = createSignal<WakeupRecord[]>([])
    const [commands, setCommands] = createSignal<ShellInfo[]>([])
    const [now, setNow] = createSignal(Date.now())
    const refresh = async () => {
      const [timers, shells] = await Promise.allSettled([rpc.list({}, { location }), rpc.backgroundList({}, { location })])
      if (timers.status === "fulfilled") setWakeups(timers.value as WakeupRecord[])
      if (shells.status === "fulfilled") setCommands(shells.value as ShellInfo[])
    }
    void refresh()
    const off = rpc.events.on("changed", () => { void refresh() })
    const interval = setInterval(() => {
      setNow(Date.now())
      if (commands().length) void refresh()
    }, 1_000)
    const slot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const [commandsExpanded, setCommandsExpanded] = createSignal(true)
        const [timersExpanded, setTimersExpanded] = createSignal(true)
        const active = () => wakeups().filter((w) => w.sessionID === sessionID && w.status === "scheduled")
        const shells = () => commands().filter((shell) => shell.metadata.sessionID === sessionID)
        // tsc's JSX runtime needs an explicit reactive boundary.
        const content = createMemo(() => {
          now()
          return <box flexDirection="column">
          <Show when={shells().length > 0}>
            <box flexDirection="column">
              <box onMouseDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                setCommandsExpanded((expanded) => !expanded)
              }}>
                <text selectable={false} fg={context.theme.text.base}>
                  {commandsExpanded() ? "▾" : "▸"} Background commands ({shells().length})
                </text>
              </box>
              <Show when={commandsExpanded()}>
                <For each={shells()}>{(shell) => <text fg={context.theme.text.muted}>
                  {shell.command.replace(/\s+/g, " ")} · {Math.max(0, Math.floor((now() - shell.time.started) / 1000))}s
                </text>}</For>
              </Show>
            </box>
          </Show>
          <Show when={active().length > 0}>
            <box flexDirection="column">
              <box onMouseDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                setTimersExpanded((expanded) => !expanded)
              }}>
                <text selectable={false} fg={context.theme.text.base}>
                  {timersExpanded() ? "▾" : "▸"} Wakeup timers ({active().length})
                </text>
              </box>
              <Show when={timersExpanded()}>
                <For each={active()}>{(w) => <text fg={context.theme.text.muted}>
                  {w.name} · {Math.max(0, Math.ceil((Date.parse(w.runAt) - now()) / 1000))}s · {w.message}
                </text>}</For>
              </Show>
            </box>
          </Show>
          </box>
        })
        return jsx("box", { get children() { return content() } })
      },
    })
    const app = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 100,
          bindings: ["productivity.history"],
          commands: [
            {
              id: "productivity.background",
              title: "Background shell commands",
              group: "Productivity",
              palette: true,
              slash: { name: "oc-background" },
              run: async () => {
                try {
                  const shells = await rpc.backgroundList({}, { location }) as ShellInfo[]
                  setCommands(shells)
                  if (!shells.length) { context.ui.toast.show({ message: "No running background commands" }); return }
                  const selected = await context.ui.dialog.select({
                    title: "Background shell commands",
                    options: shells.map((shell) => ({ title: shell.command.replace(/\s+/g, " "), value: shell.id, description: `${shell.id} · PID ${shell.pid ?? "unknown"}` })),
                  })
                  const shell = shells.find((shell) => shell.id === selected)
                  if (!shell) return
                  const stop = await context.ui.dialog.confirm({ title: "Stop background command?", message: shell.command })
                  if (stop) {
                    await rpc.backgroundKill({ id: shell.id, sessionID: String(shell.metadata.sessionID) }, { location })
                    await refresh()
                  }
                } catch (error) { context.ui.toast.show({ message: String(error), variant: "error" }) }
              },
            },
            {
              id: "productivity.timers",
              title: "Active wakeup timers",
              group: "Productivity",
              palette: true,
              slash: { name: "oc-timers" },
              run: async () => {
                await refresh()
                const active = wakeups().filter((w) => w.status === "scheduled")
                if (!active.length) { context.ui.toast.show({ message: "No active wakeup timers" }); return }
                const selected = await context.ui.dialog.select({
                  title: "Active wakeup timers",
                  options: active.map((w) => ({ title: `${w.name} · ${w.runAt}`, value: w.id, description: w.message })),
                })
                if (!selected) return
                const cancel = await context.ui.dialog.confirm({ title: "Cancel wakeup?", message: selected })
                if (cancel) { await rpc.cancel({ target: selected }, { location }); await refresh() }
              },
            },
            {
              id: "productivity.history",
              title: "Search prompt history",
              group: "Productivity",
              palette: true,
              slash: { name: "oc-history", arguments: true },
              bind: "ctrl+r",
              run: async (input) => {
                const query = input?.trim() || await context.ui.dialog.prompt({ title: "Search prompt history", placeholder: "Whole words, separated by spaces" })
                if (!query) return
                let entries: PromptHistoryEntry[]
                try { entries = searchPromptHistory("", { limit: 4096 }) } catch (error) {
                  context.ui.toast.show({ message: String(error), variant: "error" }); return
                }
                const matches = new PromptHistoryIndex(entries).find(query)
                if (!matches.length) { context.ui.toast.show({ message: "No matching prompts" }); return }
                const selected = await context.ui.dialog.select({
                  title: "Prompt history · newest first",
                  options: matches.map((entry) => ({ title: entry.prompt.replace(/\s+/g, " ").slice(0, 100), value: entry.id, description: new Date(entry.createdAt).toLocaleString(), footer: entry.prompt.slice(0, 400) })),
                })
                const prompt = matches.find((entry) => entry.id === selected)?.prompt
                if (!prompt) return
                const editor = context.renderer.currentFocusedEditor
                if (!editor) {
                  context.ui.toast.show({ message: "Prompt editor is unavailable", variant: "error" })
                  return
                }
                // OpenCode 2 has no public composer insertion method. The picker restores focus to its editor.
                editor.insertText(prompt)
                editor.focus()
              },
            },
          ],
        }))
        return null
      },
    })
    return () => { off(); clearInterval(interval); slot(); app() }
  },
})
