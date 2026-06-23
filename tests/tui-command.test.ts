import test from "node:test"
import assert from "node:assert/strict"
import { BackgroundManager } from "../src/background.js"
import { WakeupScheduler } from "../src/scheduler.js"
import { handleTuiCommand } from "../src/tui-command.js"
import type { OpenCodeClient } from "../src/types.js"

test("session.new TUI command clears wakeups and background history", async () => {
  const toasts: Array<{ message: string; variant?: string }> = []
  const client: OpenCodeClient = {
    tui: {
      async showToast(input) {
        toasts.push(input.body)
      },
    },
  }
  const scheduler = new WakeupScheduler(client)
  const background = new BackgroundManager(client, process.cwd())

  scheduler.schedule({ name: "new-reset", message: "wake", delaySeconds: 60 })
  background.run({ name: "new-bg", command: "node -e \"setTimeout(()=>{}, 10000)\"" })

  try {
    const handled = await handleTuiCommand(
      { type: "tui.command.execute", properties: { command: "session.new" } },
      { client, scheduler, background },
    )

    assert.equal(handled, true)
    assert.deepEqual(scheduler.list(), [])
    assert.deepEqual(background.list(), [])
    assert.match(toasts.at(-1)?.message ?? "", /Cleared 1 wakeup and 1 background command; killed 1 running process/)
  } finally {
    scheduler.dispose()
    background.dispose()
  }
})
