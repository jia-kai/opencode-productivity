import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { ProductivityRpc } from "./rpc.js"
import { PromptHistoryIndex, searchPromptHistory, type PromptHistoryEntry } from "./history.js"
import type { WakeupRecord } from "./scheduler.js"

export default Plugin.define({
  id: "opencode.productivity.tui",
  setup(context) {
    const rpc = context.client.rpc(ProductivityRpc)
    const location = context.location ?? context.data.location.default()
    const [wakeups, setWakeups] = createSignal<WakeupRecord[]>([])
    const [now, setNow] = createSignal(Date.now())
    const refresh = async () => {
      try { setWakeups(await rpc.list({}, { location }) as WakeupRecord[]) }
      catch { /* server may be restarting */ }
    }
    void refresh()
    const off = rpc.events.on("changed", () => { void refresh() })
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    const slot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const active = () => wakeups().filter((w) => w.sessionID === sessionID && w.status === "scheduled")
        return <Show when={active().length > 0}>
          <box flexDirection="column">
            <text fg={context.theme.text.base}>Wakeup timers</text>
            <For each={active()}>{(w) => <text fg={context.theme.text.muted}>
              {w.name} · {Math.max(0, Math.ceil((Date.parse(w.runAt) - now()) / 1000))}s · {w.message}
            </text>}</For>
          </box>
        </Show>
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
