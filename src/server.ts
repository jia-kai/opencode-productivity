import { Plugin } from "@opencode/plugin"
import { WakeupScheduler } from "./scheduler.js"
import { ProductivityRpc } from "./rpc.js"
import { localTimeContext } from "./time.js"

const text = (value: unknown) => ({ content: JSON.stringify(value) })
const string = { type: "string" } as const
const number = { type: "number" } as const

export default Plugin.define({
  id: "opencode.productivity",
  async setup(ctx) {
    let changed = () => {}
    const scheduler = new WakeupScheduler(ctx.session, () => changed())
    const rpc = await ctx.rpc.register(ProductivityRpc, {
      list: async () => JSON.parse(JSON.stringify(scheduler.list())),
      cancel: async (input) => JSON.parse(JSON.stringify(scheduler.cancel((input as { target: string }).target))),
    })
    changed = () => { void rpc.events.emit("changed", {}) }
    const tools = await ctx.tool.transform((editor) => {
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
      await tools.dispose()
      await rpc.dispose()
    }
  },
})
