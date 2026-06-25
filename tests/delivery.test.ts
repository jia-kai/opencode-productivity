import test from "node:test"
import assert from "node:assert/strict"
import { postSessionNote } from "../src/delivery.js"

test("postSessionNote sends a prompt that triggers a model reply", async () => {
  const calls: unknown[] = []
  const result = await postSessionNote({
    session: {
      async prompt(input) {
        calls.push(input)
      },
    },
  }, "session-1", "wake up")

  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{
    path: { id: "session-1" },
    body: {
      parts: [{ type: "text", text: "wake up" }],
    },
  }])
})

test("postSessionNote prefers async prompts when available", async () => {
  const promptCalls: unknown[] = []
  const promptAsyncCalls: unknown[] = []
  const result = await postSessionNote({
    session: {
      async prompt(input) {
        promptCalls.push(input)
      },
      async promptAsync(input) {
        promptAsyncCalls.push(input)
      },
    },
  }, "session-1", "wake up")

  assert.equal(result.ok, true)
  assert.equal(promptCalls.length, 0)
  assert.equal(promptAsyncCalls.length, 1)
  assert.deepEqual(promptAsyncCalls[0], {
    path: { id: "session-1" },
    body: {
      parts: [{ type: "text", text: "wake up" }],
    },
  })
})
