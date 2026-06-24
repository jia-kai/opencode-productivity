import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { BackgroundManager } from "../src/background.js"
import { productivitySocketPath, sendProductivityAction, startProductivityIpcServer } from "../src/ipc.js"
import { handleActionRequest } from "../src/plugin.js"
import {
  createProductivityRegistry,
  productivityRegistryPath,
  readProductivityRegistry,
  selectProductivityInstance,
} from "../src/registry.js"
import { WakeupScheduler } from "../src/scheduler.js"
import {
  deleteStatusSnapshot,
  detailedStatus,
  readStatusSnapshot,
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

test("productivity IPC sends action requests over a Unix socket", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  let server: Awaited<ReturnType<typeof startProductivityIpcServer>> | undefined
  try {
    try {
      server = await startProductivityIpcServer(dir, async (request) => ({
        id: request.id,
        respondedAt: "2026-06-23T12:00:00.000Z",
        ok: true,
        title: `Handled ${request.action}`,
        message: `${request.target} ${request.stream ?? ""} ${request.tail ?? ""} ${request.limit ?? ""}`.trim(),
      }))
    } catch (error) {
      if (isSocketPermissionError(error)) return
      throw error
    }
    assert.equal(existsSync(productivitySocketPath(dir)), true)
    assert.equal(server.socketPath, productivitySocketPath(dir))
    assert.equal(server.socketPath.startsWith(path.join(tmpdir(), "opencode-productivity")), true)

    const response = await sendProductivityAction(server.socketPath, {
      id: "action-1",
      action: "pull-background-output",
      target: "bg-1",
      stream: "stdout",
      tail: 5,
      limit: 10,
    })
    assert.equal(response.ok, true)
    assert.equal(response.id, "action-1")
    assert.equal(response.title, "Handled pull-background-output")
    assert.equal(response.message, "bg-1 stdout 5 10")
  } finally {
    await server?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("productivity IPC socket path stays short for deep project paths", () => {
  const deepDirectory = path.join(tmpdir(), ...Array.from({ length: 40 }, (_, index) => `deep-${index}`))
  const socketPath = productivitySocketPath(deepDirectory, 12345)
  assert.equal(socketPath.startsWith(path.join(tmpdir(), "opencode-productivity")), true)
  assert.ok(socketPath.length < 104, socketPath)
})

test("productivity IPC can close with an idle connected client", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  let server: Awaited<ReturnType<typeof startProductivityIpcServer>> | undefined
  try {
    try {
      server = await startProductivityIpcServer(dir, async (request) => ({
        id: request.id,
        respondedAt: "",
        ok: true,
        title: "ok",
        message: "ok",
      }))
    } catch (error) {
      if (isSocketPermissionError(error)) return
      throw error
    }
    const socket = net.createConnection(server.socketPath)
    await new Promise<void>((resolve) => socket.on("connect", resolve))
    await Promise.race([
      server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("IPC close timed out with idle client")), 1_000)),
    ])
    server = undefined
    socket.destroy()
  } finally {
    await server?.close()
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

test("productivity IPC reports unavailable server", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    const response = await sendProductivityAction(dir, {
      id: "action-1",
      action: "cancel-background",
      target: "bg-1",
    }, 50)
    assert.equal(response.ok, false)
    assert.equal(response.title, "Productivity Action Unavailable")
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

test("status and registry files are kept outside the project .opencode directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  try {
    writeStatusSnapshot(dir, [], [], { socketPath: "/tmp/opencode-productivity/test.sock" })
    createProductivityRegistry(dir).write({
      instanceID: "instance-runtime-path",
      serverPid: process.pid,
      socketPath: "/tmp/opencode-productivity/runtime.sock",
      ipc: { instanceID: "instance-runtime-path", serverPid: process.pid, socketPath: "/tmp/opencode-productivity/runtime.sock" },
      sessions: [],
      wakeups: [],
      commands: [],
    })

    assert.equal(existsSync(path.join(dir, ".opencode")), false)
    assert.equal(statusSnapshotPath(dir).startsWith(path.join(tmpdir(), "opencode-productivity", "state")), true)
    assert.equal(productivityRegistryPath(dir).startsWith(path.join(tmpdir(), "opencode-productivity", "state")), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status and registry cleanup removes empty temp runtime files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  const registry = createProductivityRegistry(dir)
  try {
    writeStatusSnapshot(dir, [], [], { socketPath: "/tmp/opencode-productivity/test.sock" })
    registry.write({
      instanceID: "instance-cleanup",
      serverPid: process.pid,
      socketPath: "/tmp/opencode-productivity/cleanup.sock",
      ipc: { instanceID: "instance-cleanup", serverPid: process.pid, socketPath: "/tmp/opencode-productivity/cleanup.sock" },
      sessions: [],
      wakeups: [],
      commands: [],
    })

    assert.equal(existsSync(statusSnapshotPath(dir)), true)
    assert.equal(existsSync(productivityRegistryPath(dir)), true)

    registry.remove("instance-cleanup")
    deleteStatusSnapshot(dir)

    assert.equal(existsSync(statusSnapshotPath(dir)), false)
    assert.equal(existsSync(productivityRegistryPath(dir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("productivity registry tracks multiple instances and selects by session", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  const registry = createProductivityRegistry(dir)
  try {
    registry.write({
      instanceID: "instance-a",
      serverPid: process.pid,
      socketPath: "/tmp/opencode-productivity/a.sock",
      ipc: { instanceID: "instance-a", serverPid: process.pid, socketPath: "/tmp/opencode-productivity/a.sock" },
      sessions: ["session-a"],
      wakeups: [],
      commands: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 2))
    registry.write({
      instanceID: "instance-b",
      serverPid: process.pid,
      socketPath: "/tmp/opencode-productivity/b.sock",
      ipc: { instanceID: "instance-b", serverPid: process.pid, socketPath: "/tmp/opencode-productivity/b.sock" },
      sessions: ["session-b"],
      wakeups: [],
      commands: [],
    })

    const stored = readProductivityRegistry(dir)
    assert.equal(stored.instances.length, 2)
    assert.equal(selectProductivityInstance(stored, "session-a")?.instanceID, "instance-a")
    assert.equal(selectProductivityInstance(stored, "session-b")?.instanceID, "instance-b")
    assert.equal(selectProductivityInstance(stored, "unknown-session"), undefined)
    assert.equal(selectProductivityInstance(stored)?.instanceID, "instance-b")

    const connected = registry.select("session-a")
    assert.equal(connected?.instanceID, "instance-a")
    const afterConnect = readProductivityRegistry(dir)
    assert.equal(afterConnect.instances.find((instance) => instance.instanceID === "instance-a")?.connected, true)
    assert.equal(afterConnect.instances.find((instance) => instance.instanceID === "instance-a")?.connectedSessionID, "session-a")
    assert.equal(selectProductivityInstance(afterConnect, "session-a")?.instanceID, "instance-a")

    registry.remove("instance-b")
    const afterRemove = readProductivityRegistry(dir)
    assert.deepEqual(afterRemove.instances.map((instance) => instance.instanceID), ["instance-a"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("productivity registry prunes entries whose PID no longer exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-status-"))
  const registry = createProductivityRegistry(dir)
  try {
    registry.write({
      instanceID: "dead-instance",
      serverPid: 999_999_999,
      socketPath: "/tmp/opencode-productivity/dead.sock",
      ipc: { instanceID: "dead-instance", serverPid: 999_999_999, socketPath: "/tmp/opencode-productivity/dead.sock" },
      sessions: ["dead-session"],
      wakeups: [],
      commands: [],
    })
    registry.write({
      instanceID: "live-instance",
      serverPid: process.pid,
      socketPath: "/tmp/opencode-productivity/live.sock",
      ipc: { instanceID: "live-instance", serverPid: process.pid, socketPath: "/tmp/opencode-productivity/live.sock" },
      sessions: ["live-session"],
      wakeups: [],
      commands: [],
    })

    assert.deepEqual(readProductivityRegistry(dir).instances.map((instance) => instance.instanceID), ["live-instance"])
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

function isSocketPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EPERM"
}
