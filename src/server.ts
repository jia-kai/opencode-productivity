import { Plugin } from "@opencode/plugin"
import { WakeupScheduler } from "./scheduler.js"
import { ProductivityRpc } from "./rpc.js"
import { localTimeContext } from "./time.js"
import { BackgroundCommands, nativeShellApi } from "./background.js"

const text = (value: unknown) => ({ content: JSON.stringify(value) })
const string = { type: "string" } as const
const number = { type: "number" } as const

export default Plugin.define({
  id: "opencode.productivity",
  async setup(ctx) {
    let changed = () => {}
    const scheduler = new WakeupScheduler(ctx.session, () => changed())
    const background = new BackgroundCommands(nativeShellApi(ctx.location.directory))
    const rpc = await ctx.rpc.register(ProductivityRpc, {
      list: async () => JSON.parse(JSON.stringify(scheduler.list())),
      cancel: async (input) => JSON.parse(JSON.stringify(scheduler.cancel((input as { target: string }).target))),
      backgroundList: async () => JSON.parse(JSON.stringify(await background.list())),
      backgroundKill: async (input) => {
        const { id, sessionID } = input as { id: string; sessionID: string }
        const result = await background.kill(id, sessionID)
        changed()
        return JSON.parse(JSON.stringify(result))
      },
    })
    changed = () => { void rpc.events.emit("changed", {}) }
    const shellHook = await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "shell" || event.status !== "completed") return
      background.observe(event.result.metadata)
      changed()
    })
    const contextHook = await ctx.session.hook("context", async (event) => {
      try {
        const commands = await background.list(event.sessionID)
        if (commands.length) event.system.push({ type: "text", text: `Running background shell commands in this session (use ListBackgroundCommands to refresh, KillBackgroundCommand to stop):\n${JSON.stringify(commands)}` })
      } catch { /* ListBackgroundCommands reports connection errors explicitly. */ }
    })
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "ListBackgroundCommands",
        description: "List this session's running builtin shell commands moved to the background, including their shell IDs, PIDs, commands, and output files.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => text({ commands: await background.list(context.sessionID) }),
      })
      editor.add({
        name: "KillBackgroundCommand",
        description: "Stop a background builtin shell command and its process tree in this session by shell ID. OpenCode removes its captured output file when stopped.",
        input: { type: "object", properties: { id: string }, required: ["id"], additionalProperties: false },
        execute: async (input, context) => {
          const command = await background.kill((input as { id: string }).id, context.sessionID)
          changed()
          return text({ command })
        },
      })
      editor.add({
        name: "ScheduleWakeup",
        description: "Schedule a one-shot or repeated wakeup in this OpenCode session. Supply exactly one of runAt or delaySeconds.",
        input: {
          type: "object",
          properties: {
            name: string, message: string, runAt: string, delaySeconds: number,
            repeatSeconds: number, label: string,
          },
          required: ["name", "message"], additionalProperties: false,
        },
        execute: async (input, context) => {
          const wakeup = scheduler.schedule(input as Parameters<WakeupScheduler["schedule"]>[0], context.sessionID)
          return text({ currentLocalTime: localTimeContext(), wakeup })
        },
      })
      editor.add({
        name: "ListWakeups",
        description: "List scheduled, fired, cancelled, and failed wakeups with current local time.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => text({ currentLocalTime: localTimeContext(), wakeups: scheduler.list() }),
      })
      editor.add({
        name: "CancelWakeup",
        description: "Cancel a wakeup by ID or name.",
        input: { type: "object", properties: { id: string, name: string }, additionalProperties: false },
        execute: async (input) => {
          const args = input as { id?: string; name?: string }
          return text({ wakeup: scheduler.cancel(args.id ?? args.name ?? "") })
        },
      })
    })
    return async () => {
      scheduler.dispose()
      await shellHook.dispose()
      await contextHook.dispose()
      await tools.dispose()
      await rpc.dispose()
    }
  },
})
