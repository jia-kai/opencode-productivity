import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BackgroundManager } from "../src/background.js"
import { handleActionRequest } from "../src/plugin.js"
import { WakeupScheduler } from "../src/scheduler.js"
import {
  actionRequestPath,
  actionResponsePath,
  consumeActionRequest,
  consumeActionResponse,
  consumeResetRequest,
  detailedStatus,
  readStatusSnapshot,
  resetRequestPath,
  writeActionRequest,
  writeActionResponse,
  writeResetRequest,
  writeStatusSnapshot,
} from "../src/status.js"

test("detailedStatus is empty when no wakeups or background commands are present", () => {
  assert.equal(detailedStatus([], []), "")
})

test("detailedStatus only renders sections with entries", () => {
  assert.equal(
    detailedStatus([
      {
        id: "wakeup-1",
        name: "standup",
        message: "stand up",
        status: "scheduled",
        runAt: "2026-06-23T12:00:00.000Z",
        dueInMs: 1_000,
        dueInSeconds: 1,
        firedCount: 0,
        createdAt: "2026-06-23T11:59:00.000Z",
      },
    ], []),
    "Wakeup status\n- wakeup-1 stand up: 2026-06-23T12:00:00.000Z",
  )

  assert.equal(
    detailedStatus([], [
      {
        id: "bg-1",
        name: "build",
        command: "npm run build",
        cwd: "/tmp",
        status: "running",
        startedAt: "2026-06-23T12:00:00.000Z",
        runtimeMs: 1000,
        runtimeSeconds: 1,
        processStatus: "running pid 123",
        outputRetention: {
          stdout: { maxBytes: 1024 * 1024, totalBytes: 0, retainedBytes: 0, omittedBytes: 0, truncated: false, headBytes: 0, tailBytes: 0 },
          stderr: { maxBytes: 1024 * 1024, totalBytes: 0, retainedBytes: 0, omittedBytes: 0, truncated: false, headBytes: 0, tailBytes: 0 },
        },
        outputRanges: { stdout: [], stderr: [] },
      },
    ]),
    "Background status\n- bg-1 running: npm run build",
  )
})

test("reset request is consumed once from project state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    writeResetRequest(dir, "session.new")
    assert.equal(existsSync(resetRequestPath(dir)), true)

    const request = consumeResetRequest(dir)
    assert.equal(request?.reason, "session.new")
    assert.equal(existsSync(resetRequestPath(dir)), false)
    assert.equal(consumeResetRequest(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("action request is consumed once from project state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    writeActionRequest(dir, {
      id: "action-1",
      action: "pull-background-output",
      target: "bg-1",
      stream: "stdout",
      tail: 5,
      limit: 10,
    })
    assert.equal(existsSync(actionRequestPath(dir)), true)

    const request = consumeActionRequest(dir)
    assert.equal(request?.id, "action-1")
    assert.equal(request?.action, "pull-background-output")
    assert.equal(request?.target, "bg-1")
    assert.equal(request?.stream, "stdout")
    assert.equal(request?.tail, 5)
    assert.equal(request?.limit, 10)
    assert.equal(existsSync(actionRequestPath(dir)), false)
    assert.equal(consumeActionRequest(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("action response is consumed only by matching id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    writeActionResponse(dir, { id: "action-1", ok: true, title: "Done", message: "ok" })
    assert.equal(existsSync(actionResponsePath(dir)), true)
    assert.equal(consumeActionResponse(dir, "other"), undefined)
    assert.equal(existsSync(actionResponsePath(dir)), true)

    const response = consumeActionResponse(dir, "action-1")
    assert.equal(response?.ok, true)
    assert.equal(response?.title, "Done")
    assert.equal(response?.message, "ok")
    assert.equal(existsSync(actionResponsePath(dir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TUI action handler cancels wakeups and writes response", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  const scheduler = new WakeupScheduler()
  const background = new BackgroundManager(undefined, dir)
  let published = 0
  try {
    const wakeup = scheduler.schedule({ name: "tui-wakeup", message: "wake", delaySeconds: 60 })

    await handleActionRequest(
      { id: "action-wakeup", requestedAt: "", action: "cancel-wakeup", target: wakeup.name },
      { scheduler, background, directory: dir, publish: () => published++ },
    )

    assert.equal(scheduler.list()[0]?.status, "cancelled")
    const response = consumeActionResponse(dir, "action-wakeup")
    assert.equal(response?.ok, true)
    assert.match(response?.message ?? "", /tui-wakeup/)
    assert.equal(published, 1)
  } finally {
    scheduler.dispose()
    background.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TUI action handler pulls retained background output", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  const scheduler = new WakeupScheduler()
  const background = new BackgroundManager(undefined, dir)
  try {
    const command = background.run({
      name: "tui-output",
      command: "printf 'from-stdout\\n'; printf 'from-stderr\\n' >&2",
      maxOutputBytes: 4096,
    })

    await waitForBackgroundOutput(background, command.id)
    await handleActionRequest(
      {
        id: "action-output",
        requestedAt: "",
        action: "pull-background-output",
        target: command.name,
        stream: "both",
        limit: 20,
      },
      { scheduler, background, directory: dir, publish: () => undefined },
    )

    const response = consumeActionResponse(dir, "action-output")
    assert.equal(response?.ok, true)
    assert.match(response?.title ?? "", /tui-output/)
    assert.match(response?.message ?? "", /from-stdout/)
    assert.match(response?.message ?? "", /from-stderr/)
  } finally {
    scheduler.dispose()
    background.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status snapshot does not persist captured stdout or stderr", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    writeStatusSnapshot(dir, [], [
      {
        id: "bg-1",
        name: "build",
        command: "npm run build",
        cwd: "/tmp",
        status: "exited",
        startedAt: "2026-06-23T12:00:00.000Z",
        endedAt: "2026-06-23T12:00:01.000Z",
        runtimeMs: 1000,
        runtimeSeconds: 1,
        processStatus: "exited exit 0",
        stdout: "secret stdout",
        stderr: "secret stderr",
        outputRetention: {
          stdout: { maxBytes: 1024 * 1024, totalBytes: 13, retainedBytes: 13, omittedBytes: 0, truncated: false, headBytes: 13, tailBytes: 13 },
          stderr: { maxBytes: 1024 * 1024, totalBytes: 13, retainedBytes: 13, omittedBytes: 0, truncated: false, headBytes: 13, tailBytes: 13 },
        },
        outputRanges: {
          stdout: [{ startLine: 0, endLine: 1 }],
          stderr: [{ startLine: 0, endLine: 1 }],
        },
      },
    ])

    const command = readStatusSnapshot(dir).commands[0] as Record<string, unknown>
    assert.equal(command.stdout, undefined)
    assert.equal(command.stderr, undefined)
    assert.equal(command.outputRetention && typeof command.outputRetention === "object", true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function waitForBackgroundOutput(background: BackgroundManager, id: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const command = background.get(id)
    if (command.status !== "running" && command.outputRanges.stdout.length > 0 && command.outputRanges.stderr.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`background command ${id} did not exit with retained stdout/stderr`)
}
