import test from "node:test"
import assert from "node:assert/strict"
import { BackgroundCommands } from "../src/background.js"
import type { ShellInfo } from "@opencode/client"

const shell = (id: string, sessionID = "session-1", started = 1): ShellInfo => ({
  id, status: "running", command: "sleep 60", cwd: "/tmp", shell: "/bin/sh",
  file: "/tmp/output", pid: 123, metadata: { sessionID }, time: { started },
})

test("lists only observed background shells, newest first, scoped to the session", async () => {
  const commands = new BackgroundCommands({
    list: async () => [shell("old"), shell("new", "session-1", 2), shell("other", "session-2"), shell("foreground")],
    remove: async () => {},
  })
  for (const shellID of ["old", "new", "other"]) commands.observe({ shellID, status: "running" })
  commands.observe({ shellID: "foreground", status: "completed" })
  assert.deepEqual((await commands.list("session-1")).map((shell) => shell.id), ["new", "old"])
  assert.equal((await commands.list()).length, 3)
})

test("kills only a live background shell owned by the requesting session", async () => {
  const removed: string[] = []
  const commands = new BackgroundCommands({ list: async () => [shell("owned"), shell("other", "session-2"), shell("foreground")], remove: async (id) => { removed.push(id) } })
  commands.observe({ shellID: "owned", status: "running" })
  commands.observe({ shellID: "other", status: "running" })
  await assert.rejects(commands.kill("other", "session-1"), /in this session/)
  await assert.rejects(commands.kill("foreground", "session-1"), /in this session/)
  assert.equal((await commands.kill("owned", "session-1")).status, "killed")
  assert.deepEqual(removed, ["owned"])
  await assert.rejects(commands.kill("owned", "session-1"), /in this session/)
})

test("drops exited shells and retains tracking when the native API fails", async () => {
  let failed = true
  let active = [shell("active")]
  const commands = new BackgroundCommands({ list: async () => { if (failed) throw new Error("offline"); return active }, remove: async () => {} })
  commands.observe({ shellID: "active", status: "running" })
  await assert.rejects(commands.list(), /offline/)
  failed = false
  assert.equal((await commands.list()).length, 1)
  active = []
  assert.deepEqual(await commands.list(), [])
  active = [shell("active")]
  assert.deepEqual(await commands.list(), [])
})
