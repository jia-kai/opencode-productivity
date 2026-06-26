import test from "node:test"
import assert from "node:assert/strict"
import { WakeupScheduler } from "../src/scheduler.js"

test("schedules and cancels wakeups", () => {
  const scheduler = new WakeupScheduler()
  const record = scheduler.schedule({ name: "standup", message: "stand up", delaySeconds: 60 }, "session-1", 0)
  assert.equal(record.name, "standup")
  assert.equal(record.status, "scheduled")
  assert.equal(record.sessionID, "session-1")
  assert.ok(record.dueInMs >= 0)
  const cancelled = scheduler.cancel(record.name)
  assert.equal(cancelled.status, "cancelled")
  scheduler.dispose()
})

test("repeatSeconds zero is a one-time wakeup", () => {
  const scheduler = new WakeupScheduler()
  const record = scheduler.schedule(
    { name: "one-time", message: "wake once", delaySeconds: 120, repeatSeconds: 0 },
    "session-1",
    0,
  )

  assert.equal(record.status, "scheduled")
  assert.equal(record.repeatSeconds, undefined)
  scheduler.dispose()
})

test("enforces repeat minimum and mutually exclusive time fields", () => {
  const scheduler = new WakeupScheduler()
  assert.throws(() => scheduler.schedule({ name: "repeat", message: "x", delaySeconds: 1, repeatSeconds: 5 }), /at least 60/)
  assert.throws(() => scheduler.schedule({ name: "both", message: "x", delaySeconds: 1, runAt: new Date().toISOString() }), /exactly one/)
  assert.throws(() => scheduler.schedule({ message: "x", delaySeconds: 1 } as never), /name is required/)
  assert.throws(() => scheduler.cancel(""), /provide id or name/)
  scheduler.schedule({ name: "dup", message: "x", delaySeconds: 1 })
  assert.throws(() => scheduler.schedule({ name: "dup", message: "y", delaySeconds: 1 }), /duplicate/)
  scheduler.dispose()
})

test("runAt schedules tolerate a zero delaySeconds default", () => {
  const scheduler = new WakeupScheduler()
  const runAt = new Date(120_000).toISOString()
  const record = scheduler.schedule({ name: "absolute", message: "x", runAt, delaySeconds: 0 }, "session-1", 0)

  assert.equal(record.runAt, runAt)
  assert.equal(record.status, "scheduled")
  scheduler.dispose()
})

test("clear removes all wakeup history", () => {
  const scheduler = new WakeupScheduler()
  scheduler.schedule({ name: "one", message: "x", delaySeconds: 60 })
  scheduler.schedule({ name: "two", message: "y", delaySeconds: 60 })

  assert.equal(scheduler.clear(), 2)
  assert.deepEqual(scheduler.list(), [])

  const next = scheduler.schedule({ name: "one", message: "x", delaySeconds: 60 })
  assert.equal(next.name, "one")
  scheduler.dispose()
})

test("user cancellation notifies originating wakeup session", async () => {
  const prompts: string[] = []
  const scheduler = new WakeupScheduler({
    session: {
      async prompt(input) {
        prompts.push(input.body.parts.map((part) => part.text).join("\n"))
      },
    },
  })
  const record = scheduler.schedule({ name: "user-cancel", message: "wake up", delaySeconds: 60 }, "session-1")

  const cancelled = await scheduler.cancelByUser(record.id)
  assert.equal(cancelled.status, "cancelled")
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /cancelled by user/)
  assert.match(prompts[0], /wake up/)
  scheduler.dispose()
})
