import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BackgroundManager, type BackgroundStatusValue } from "../src/background.js"
import {
  connectProductivityServerToTui,
  decodeProductivityTuiCommand,
  encodeProductivityTuiCommand,
  productivityProjectID,
  productivityTuiSocketPath,
  startProductivityTuiIpcServer,
} from "../src/ipc.js"
import { handleActionRequest } from "../src/plugin.js"
import { WakeupScheduler } from "../src/scheduler.js"
import {
  type BackgroundStatusSnapshot,
  deleteStatusSnapshot,
  detailedStatus,
  readStatusSnapshot,
  sidebarBackgroundStatusCommands,
  statusSnapshotPath,
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

test("sidebar background status caps rows and includes at most one exited command", () => {
  const commands = [
    backgroundStatus("bg-1", "exited"),
    backgroundStatus("bg-2", "failed"),
    backgroundStatus("bg-3", "running"),
    backgroundStatus("bg-4", "running"),
    backgroundStatus("bg-5", "running"),
    backgroundStatus("bg-6", "running"),
    backgroundStatus("bg-7", "running"),
    backgroundStatus("bg-8", "running"),
  ]

  assert.deepEqual(
    sidebarBackgroundStatusCommands(commands).map((command) => `${command.id}:${command.status}`),
    ["bg-8:running", "bg-7:running", "bg-6:running", "bg-5:running", "bg-2:failed"],
  )
})

test("compiled TUI does not import the OpenTUI JSX runtime", () => {
  const compiled = readFileSync(path.join(process.cwd(), "dist", "src", "tui.js"), "utf8")
  assert.equal(/@opentui\/solid\/jsx-runtime/.test(compiled), false)
})

test("productivity TUI IPC socket path stays short for deep project paths", () => {
  const deepDirectory = path.join(tmpdir(), ...Array.from({ length: 40 }, (_, index) => `deep-${index}`))
  const socketPath = productivityTuiSocketPath(deepDirectory, 12345, "nonce")
  assert.equal(socketPath.startsWith(path.join(tmpdir(), "opencode-productivity")), true)
  assert.ok(socketPath.length < 104, socketPath)
})

test("productivity TUI command encoding round trips socket discovery payloads", () => {
  const command = encodeProductivityTuiCommand({
    op: "connect",
    projectID: productivityProjectID("/tmp/project"),
    socketPath: "/tmp/opencode-productivity/tui.sock",
    sessionID: "ses_123",
  })
  assert.deepEqual(decodeProductivityTuiCommand(command), {
    op: "connect",
    projectID: productivityProjectID("/tmp/project"),
    socketPath: "/tmp/opencode-productivity/tui.sock",
    sessionID: "ses_123",
  })
  assert.equal(decodeProductivityTuiCommand("session.new"), undefined)
})

test("TUI-owned IPC routes actions to the selected same-directory instance", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  let tui: Awaited<ReturnType<typeof startProductivityTuiIpcServer>> | undefined
  const handled: string[] = []
  try {
    try {
      tui = await startProductivityTuiIpcServer(dir)
    } catch (error) {
      if (isSocketPermissionError(error)) return
      throw error
    }
    const a = connectProductivityServerToTui(tui.socketPath, {
      instanceID: "instance-a",
      serverPid: process.pid,
      sessions: ["session-a"],
      wakeups: [],
      commands: [],
    }, async (request) => {
      handled.push(`a:${request.action}:${request.target}`)
      return { id: request.id, respondedAt: "", ok: true, title: "a", message: request.target }
    })
    const b = connectProductivityServerToTui(tui.socketPath, {
      instanceID: "instance-b",
      serverPid: process.pid,
      sessions: ["session-b"],
      wakeups: [],
      commands: [],
    }, async (request) => {
      handled.push(`b:${request.action}:${request.target}`)
      return { id: request.id, respondedAt: "", ok: true, title: "b", message: request.target }
    })

    await waitFor(() => tui!.peers().length === 2)
    const peer = tui.peers().find((item) => item.sessions.includes("session-b"))
    assert.equal(peer?.instanceID, "instance-b")

    const response = await tui.send(peer!, { id: "action-b", action: "cancel-background", target: "bg-b" })
    assert.equal(response.ok, true)
    assert.equal(response.title, "b")
    assert.deepEqual(handled, ["b:cancel-background:bg-b"])

    a.close()
    b.close()
  } finally {
    await tui?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TUI-owned IPC /new reset is scoped to the selected same-directory instance", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  let tui: Awaited<ReturnType<typeof startProductivityTuiIpcServer>> | undefined
  const schedulerA = new WakeupScheduler()
  const schedulerB = new WakeupScheduler()
  const backgroundA = new BackgroundManager(undefined, dir)
  const backgroundB = new BackgroundManager(undefined, dir)
  try {
    try {
      tui = await startProductivityTuiIpcServer(dir)
    } catch (error) {
      if (isSocketPermissionError(error)) return
      throw error
    }
    schedulerA.schedule({ name: "wakeup-a", message: "a", delaySeconds: 60 }, "session-a")
    schedulerB.schedule({ name: "wakeup-b", message: "b", delaySeconds: 60 }, "session-b")
    backgroundA.run({ name: "bg-a", command: "sleep 10" }, "session-a")
    backgroundB.run({ name: "bg-b", command: "sleep 10" }, "session-b")

    const publishA = () => clientA.sendSnapshot({
      instanceID: "instance-a",
      serverPid: process.pid,
      sessions: ["session-a"],
      wakeups: schedulerA.list(),
      commands: backgroundA.list().map(backgroundStatusViewForTest),
    })
    const publishB = () => clientB.sendSnapshot({
      instanceID: "instance-b",
      serverPid: process.pid,
      sessions: ["session-b"],
      wakeups: schedulerB.list(),
      commands: backgroundB.list().map(backgroundStatusViewForTest),
    })
    const clientA = connectProductivityServerToTui(tui.socketPath, {
      instanceID: "instance-a",
      serverPid: process.pid,
      sessions: ["session-a"],
      wakeups: schedulerA.list(),
      commands: backgroundA.list().map(backgroundStatusViewForTest),
    }, (request) => handleActionRequest(request, { scheduler: schedulerA, background: backgroundA, publish: publishA }))
    const clientB = connectProductivityServerToTui(tui.socketPath, {
      instanceID: "instance-b",
      serverPid: process.pid,
      sessions: ["session-b"],
      wakeups: schedulerB.list(),
      commands: backgroundB.list().map(backgroundStatusViewForTest),
    }, (request) => handleActionRequest(request, { scheduler: schedulerB, background: backgroundB, publish: publishB }))

    await waitFor(() => tui!.peers().length === 2)
    const peerA = tui.peers().find((item) => item.sessions.includes("session-a"))
    assert.equal(peerA?.instanceID, "instance-a")

    const response = await tui.send(peerA!, { id: "action-reset-a", action: "reset", target: "session.new" })
    assert.equal(response.ok, true)
    assert.equal(schedulerA.list().filter((wakeup) => wakeup.status === "scheduled").length, 0)
    assert.equal(backgroundA.list().length, 0)
    assert.equal(schedulerB.list().filter((wakeup) => wakeup.status === "scheduled").length, 1)
    assert.equal(backgroundB.list().length, 1)

    clientA.close()
    clientB.close()
  } finally {
    schedulerA.dispose()
    schedulerB.dispose()
    backgroundA.dispose()
    backgroundB.dispose()
    await tui?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("TUI action handler resets wakeups and background commands", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  const scheduler = new WakeupScheduler()
  const background = new BackgroundManager(undefined, dir)
  let published = 0
  try {
    scheduler.schedule({ name: "reset-wakeup", message: "wake", delaySeconds: 60 })
    background.run({ name: "reset-bg", command: "sleep 10" })

    const response = await handleActionRequest(
      { id: "action-reset", requestedAt: "", action: "reset", target: "session.new" },
      { scheduler, background, publish: () => published++ },
    )

    assert.equal(response.ok, true)
    assert.equal(scheduler.list().filter((wakeup) => wakeup.status === "scheduled").length, 0)
    assert.equal(background.list().length, 0)
    assert.equal(published, 1)
  } finally {
    scheduler.dispose()
    background.dispose()
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

    const response = await handleActionRequest(
      { id: "action-wakeup", requestedAt: "", action: "cancel-wakeup", target: wakeup.name },
      { scheduler, background, publish: () => published++ },
    )

    assert.equal(scheduler.list()[0]?.status, "cancelled")
    assert.equal(response.ok, true)
    assert.match(response.message, /tui-wakeup/)
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
    const response = await handleActionRequest(
      {
        id: "action-output",
        requestedAt: "",
        action: "pull-background-output",
        target: command.name,
        stream: "both",
        limit: 20,
      },
      { scheduler, background, publish: () => undefined },
    )

    assert.equal(response.ok, true)
    assert.match(response.title, /tui-output/)
    assert.match(response.message, /from-stdout/)
    assert.match(response.message, /from-stderr/)
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

test("status snapshot advertises IPC socket path without output captures", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    writeStatusSnapshot(dir, [], [], { socketPath: "/tmp/opencode-productivity/test.sock" })
    const snapshot = readStatusSnapshot(dir)
    assert.equal(snapshot.ipc?.socketPath, "/tmp/opencode-productivity/test.sock")
    assert.deepEqual(snapshot.commands, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status snapshot is kept outside the project .opencode directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    writeStatusSnapshot(dir, [], [], { socketPath: "/tmp/opencode-productivity/test.sock" })

    assert.equal(existsSync(path.join(dir, ".opencode")), false)
    assert.equal(statusSnapshotPath(dir).startsWith(path.join(tmpdir(), "opencode-productivity", "state")), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status cleanup removes empty temp runtime files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    writeStatusSnapshot(dir, [], [], { socketPath: "/tmp/opencode-productivity/test.sock" })

    assert.equal(existsSync(statusSnapshotPath(dir)), true)

    deleteStatusSnapshot(dir)

    assert.equal(existsSync(statusSnapshotPath(dir)), false)
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

function backgroundStatus(id: string, status: BackgroundStatusValue): BackgroundStatusSnapshot {
  return {
    id,
    name: id,
    command: `echo ${id}`,
    cwd: "/tmp",
    status,
    startedAt: "2026-06-23T12:00:00.000Z",
    runtimeMs: 1000,
    runtimeSeconds: 1,
    processStatus: status === "running" ? "running pid 123" : `${status} exit 0`,
    outputRetention: {
      stdout: { maxBytes: 1024 * 1024, totalBytes: 0, retainedBytes: 0, omittedBytes: 0, truncated: false, headBytes: 0, tailBytes: 0 },
      stderr: { maxBytes: 1024 * 1024, totalBytes: 0, retainedBytes: 0, omittedBytes: 0, truncated: false, headBytes: 0, tailBytes: 0 },
    },
    outputRanges: { stdout: [], stderr: [] },
  }
}

function backgroundStatusViewForTest(command: ReturnType<BackgroundManager["list"]>[number]): BackgroundStatusSnapshot {
  const { stdout: _stdout, stderr: _stderr, ...status } = command
  return status
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail("condition was not met")
}

function isSocketPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EPERM"
}
