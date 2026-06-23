import test from "node:test"
import assert from "node:assert/strict"
import { BackgroundManager } from "../src/background.js"

test("runs a background command and captures output", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({ name: "ok-command", command: "printf ok" }, "session-1")
  assert.equal(started.name, "ok-command")
  assert.equal(started.status, "running")
  await waitForStatus(manager, started.name, "exited")
  const done = manager.get(started.name)
  assert.equal(done.exitCode, 0)
  assert.match(done.stdout, /ok/)
  assert.match(done.processStatus, /exited/)
  assert.ok(done.runtimeMs >= 0)
  manager.dispose()
})

test("cancels a running command", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({ name: "sleepy", command: "node -e \"setTimeout(()=>{}, 10000)\"" })
  const cancelled = manager.cancel(started.name)
  assert.equal(cancelled.status, "cancelled")
  await waitForStatus(manager, started.id, "cancelled")
  manager.dispose()
})

test("pulls stdout by line offset and tail after command exits", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({ name: "lines", command: "printf 'one\\ntwo\\nthree\\n'" })
  await waitForStatus(manager, started.id, "exited")

  const fromOffset = manager.pull({ name: started.name, stream: "stdout", lineOffset: 1, limit: 1 })
  assert.equal(fromOffset.name, started.name)
  assert.equal(fromOffset.stdout?.text, "two")
  assert.equal(fromOffset.stdout?.nextLineOffset, 2)
  assert.equal(fromOffset.stdout?.truncated, true)

  const tail = manager.pull({ id: started.id, stream: "stdout", tail: 2, limit: 10 })
  assert.equal(tail.stdout?.text, "two\nthree")
  assert.equal(tail.stdout?.startLine, 1)
  manager.dispose()
})

test("pulls stderr from memory after command exits", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({ name: "stderr", command: "printf 'bad\\n' >&2" })
  await waitForStatus(manager, started.id, "exited")
  const stderr = manager.pull({ id: started.id, stream: "stderr" })
  assert.equal(stderr.stderr?.text, "bad")
  assert.equal(stderr.stderr?.retention.maxBytes, 1024 * 1024)
  manager.dispose()
})

test("requires unique background command names", () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  manager.run({ name: "dup-bg", command: "printf one" })
  assert.throws(() => manager.run({ name: "dup-bg", command: "printf two" }), /duplicate/)
  assert.throws(() => manager.run({ command: "printf missing" } as never), /name is required/)
  assert.throws(() => manager.run({ name: "bad-tail", command: "printf bad", maxOutputBytes: -1 }), /maxOutputBytes/)
  assert.throws(() => manager.run({ name: "huge-tail", command: "printf bad", maxOutputBytes: 1024 * 1024 + 1 }), /1048576/)
  manager.dispose()
})

test("clear kills running commands and removes background history", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({ name: "clear-me", command: "node -e \"setTimeout(()=>{}, 10000)\"" })

  const cleared = manager.clear()
  assert.deepEqual(cleared, { cleared: 1, killed: 1 })
  assert.deepEqual(manager.list(), [])
  assert.throws(() => manager.get(started.id), /unknown background command/)

  const next = manager.run({ name: "clear-me", command: "printf ok" })
  await waitForStatus(manager, next.id, "exited")
  assert.match(manager.get(next.id).stdout, /ok/)
  manager.dispose()
})

test("clear removes completed command output from memory", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({ name: "clear-output", command: "printf 'gone\\n'" })
  await waitForStatus(manager, started.id, "exited")

  assert.deepEqual(manager.clear(), { cleared: 1, killed: 0 })
  assert.deepEqual(manager.list(), [])
  manager.dispose()
})

test("retains bounded head and tail output per stream", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({
    name: "head-tail",
    command: "printf 'head\\n'; printf 'middle-line-that-will-be-omitted\\n'; printf 'tail\\n'",
    maxOutputBytes: 12,
  })
  await waitForStatus(manager, started.id, "exited")

  const head = manager.pull({ id: started.id, stream: "stdout", lineOffset: 0, limit: 20 }).stdout
  if (!head) assert.fail("expected stdout output")
  assert.match(head.text, /head/)
  assert.match(head.message ?? "", /available line ranges/)
  assert.equal(head.retention.maxBytes, 12)
  assert.equal(head.retention.truncated, true)
  assert.ok(head.retention.omittedBytes > 0)

  const tail = manager.pull({ id: started.id, stream: "stdout", tail: 2, limit: 20 }).stdout
  if (!tail) assert.fail("expected stdout tail output")
  assert.match(tail.text, /tail/)
  manager.dispose()
})

test("retains full output until the per-stream limit is exceeded", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({
    name: "under-limit",
    command: "printf '1234567890'",
    maxOutputBytes: 12,
  })
  await waitForStatus(manager, started.id, "exited")

  const output = manager.pull({ id: started.id, stream: "stdout", lineOffset: 0, limit: 5 }).stdout
  if (!output) assert.fail("expected stdout output")
  assert.equal(output.text, "1234567890")
  assert.equal(output.retention.truncated, false)
  assert.equal(output.retention.totalBytes, 10)
  manager.dispose()
})

test("reports unavailable line offsets with retained line ranges", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({
    name: "missing-lines",
    command: "printf 'head-a\\nhead-b\\nmiddle-a\\nmiddle-b\\ntail-a\\ntail-b\\n'",
    maxOutputBytes: 24,
  })
  await waitForStatus(manager, started.id, "exited")

  const output = manager.pull({ id: started.id, stream: "stdout", lineOffset: 2, limit: 2 }).stdout
  if (!output) assert.fail("expected stdout output")
  assert.equal(output.available, false)
  assert.equal(output.text, "")
  assert.match(output.message ?? "", /available line ranges/)
  assert.ok(output.availableLineRanges.length >= 2)
  assert.ok(output.retention.totalBytes > output.retention.retainedBytes)
  manager.dispose()
})

test("does not expose partial retained lines as available output", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({
    name: "partial-line",
    command: "printf 'head\\nmiddle-line-is-cut\\ntail\\n'",
    maxOutputBytes: 12,
  })
  await waitForStatus(manager, started.id, "exited")

  const output = manager.pull({ id: started.id, stream: "stdout", lineOffset: 1, limit: 1 }).stdout
  if (!output) assert.fail("expected stdout output")
  assert.equal(output.available, false)
  assert.equal(output.text, "")
  assert.match(output.message ?? "", /available line ranges/)
  manager.dispose()
})

test("tail reports unavailable when no complete retained lines exist", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({
    name: "single-line-tail",
    command: "printf 'this-single-line-is-too-long-to-retain-completely'",
    maxOutputBytes: 12,
  })
  await waitForStatus(manager, started.id, "exited")

  const output = manager.pull({ id: started.id, stream: "stdout", tail: 1, limit: 1 }).stdout
  if (!output) assert.fail("expected stdout output")
  assert.equal(output.available, false)
  assert.equal(output.text, "")
  assert.match(output.message ?? "", /available line ranges/)
  manager.dispose()
})

test("tail preserves complete lines when trimming lands on a line boundary", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({
    name: "tail-boundary",
    command: "printf 'a\\nb\\nc\\nd\\ne\\nf\\ng\\n'",
    maxOutputBytes: 12,
  })
  await waitForStatus(manager, started.id, "exited")

  const output = manager.pull({ id: started.id, stream: "stdout", tail: 3, limit: 3 }).stdout
  if (!output) assert.fail("expected stdout output")
  assert.equal(output.available, true)
  assert.equal(output.text, "e\nf\ng")
  assert.deepEqual(output.availableLineRanges, [
    { startLine: 0, endLine: 3 },
    { startLine: 4, endLine: 7 },
  ])
  assert.equal(output.retention.retainedBytes, 12)
  manager.dispose()
})

test("tail reports a message when requested tail lines include omitted output", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({
    name: "tail-partial",
    command: "printf 'a\\nb\\nc\\nd\\ne\\nf\\ng\\n'",
    maxOutputBytes: 12,
  })
  await waitForStatus(manager, started.id, "exited")

  const output = manager.pull({ id: started.id, stream: "stdout", tail: 4, limit: 4 }).stdout
  if (!output) assert.fail("expected stdout output")
  assert.equal(output.available, false)
  assert.equal(output.text, "e\nf\ng")
  assert.match(output.message ?? "", /available line ranges/)
  manager.dispose()
})

test("completion delivery does not include captured stdout or stderr", async () => {
  const prompts: string[] = []
  const manager = new BackgroundManager({
    session: {
      async prompt(input) {
        prompts.push(input.body.parts.map((part) => part.text).join("\n"))
      },
    },
  }, process.cwd())
  const started = manager.run({
    name: "delivery-no-output",
    command: "node -e \"console.log('secret-' + 'output'); console.error('secret-' + 'error')\"",
  }, "session-1")
  await waitForStatus(manager, started.id, "exited")

  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Background command bg-/)
  assert.equal(prompts[0].includes("secret-output"), false)
  assert.equal(prompts[0].includes("secret-error"), false)
  manager.dispose()
})

test("line offset at EOF and empty streams are not reported as omitted output", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const empty = manager.run({ name: "empty-stream", command: "true" })
  await waitForStatus(manager, empty.id, "exited")

  const emptyRead = manager.pull({ id: empty.id, stream: "stdout", lineOffset: 0, limit: 5 }).stdout
  if (!emptyRead) assert.fail("expected stdout output")
  assert.equal(emptyRead.available, true)
  assert.equal(emptyRead.text, "")
  assert.equal(emptyRead.message, undefined)

  const oneLine = manager.run({ name: "one-line", command: "printf 'done\\n'" })
  await waitForStatus(manager, oneLine.id, "exited")
  const eofRead = manager.pull({ id: oneLine.id, stream: "stdout", lineOffset: 1, limit: 5 }).stdout
  if (!eofRead) assert.fail("expected stdout output")
  assert.equal(eofRead.available, true)
  assert.equal(eofRead.text, "")
  assert.equal(eofRead.message, undefined)
  manager.dispose()
})

test("blank-line-only output advances line offsets", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({ name: "blank-line", command: "printf '\\n'" })
  await waitForStatus(manager, started.id, "exited")

  const output = manager.pull({ id: started.id, stream: "stdout", lineOffset: 0, limit: 5 }).stdout
  if (!output) assert.fail("expected stdout output")
  assert.equal(output.available, true)
  assert.equal(output.text, "")
  assert.equal(output.totalLines, 1)
  assert.equal(output.returnedLines, 1)
  assert.equal(output.nextLineOffset, 1)
  assert.equal(output.truncated, false)
  manager.dispose()
})

test("long single-line output has no complete pullable ranges", async () => {
  const manager = new BackgroundManager(undefined, process.cwd())
  const started = manager.run({
    name: "single-line-ranges",
    command: "printf 'this-single-line-is-too-long-to-retain-completely'",
    maxOutputBytes: 12,
  })
  await waitForStatus(manager, started.id, "exited")

  const done = manager.get(started.id)
  assert.equal(done.outputRanges.stdout.length, 0)
  assert.equal(done.outputRetention.stdout.truncated, true)
  manager.dispose()
})

async function waitForStatus(manager: BackgroundManager, id: string, status: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (manager.get(id).status === status) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(manager.get(id).status, status)
}
