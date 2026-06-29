import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveHistoryDbPath, searchPromptHistory } from "../src/history.js"

const enabled = process.env.OPENCODE_REAL_MODEL_TESTS === "1"
const realModelTest = enabled ? test : test.skip
const tuiEnabled = process.env.OPENCODE_TUI_TESTS === "1" || enabled
const realTuiTest = tuiEnabled ? test : test.skip
const timeoutMs = Number(process.env.OPENCODE_REAL_MODEL_TIMEOUT_MS ?? 180_000)
const wakeupTools = ["ListWakeups", "ScheduleWakeup", "CancelWakeup"] as const
const backgroundTools = [
  "RunInBackground",
  "PullBackgroundOutput",
  "BackgroundStatus",
  "ListBackgroundCommands",
  "CancelBackgroundCommand",
] as const

interface ToolUse {
  tool: string
  input: unknown
  output: string
}

interface OpencodeRun {
  stdout: string
  stderr: string
  tools: ToolUse[]
}

interface OpencodeServer {
  url: string
  dispose: () => void
}

realModelTest("real OpenCode model can call wakeup tools", async () => {
  const run = await runOpencodeRequiringTools(
    [
      "This is an integration test. Use only the named tools below.",
      "Do not stop after scheduling. The test is incomplete until CancelWakeup has completed.",
      "Call these tools in exact order:",
      "1. ListWakeups with no arguments.",
      '2. ScheduleWakeup with name "itest-wakeup-a", message "integration wakeup", delaySeconds 120, repeatSeconds 0, and label "integration-test".',
      "3. ListWakeups with no arguments.",
      '4. CancelWakeup using name "itest-wakeup-a".',
      'Only after CancelWakeup completes, answer exactly "done".',
    ].join("\n"),
    wakeupTools,
  )

  const schedule = requiredTool(run, "ScheduleWakeup")
  const scheduledOutput = parseToolOutput<{
    currentLocalTime: { now: string; timezone: string; epochMs: number }
    wakeup: { id: string; name: string; status: string; message: string; label?: string; dueInMs: number }
  }>(schedule)
  assert.ok(scheduledOutput.currentLocalTime.now)
  assert.ok(scheduledOutput.currentLocalTime.timezone)
  const scheduled = scheduledOutput.wakeup
  assert.equal(scheduled.name, "itest-wakeup-a")
  assert.equal(scheduled.status, "scheduled")
  assert.equal(scheduled.message, "integration wakeup")
  assert.equal(scheduled.label, "integration-test")

  const cancel = requiredTool(run, "CancelWakeup")
  assert.ok(isRecord(cancel.input))
  const cancelInput = cancel.input as Record<string, unknown>
  assert.equal(cancelInput.name, "itest-wakeup-a")
  const cancelled = parseToolOutput<{ wakeup: { id: string; status: string } }>(cancel).wakeup
  assert.equal(cancelled.id, scheduled.id)
  assert.equal(cancelled.status, "cancelled")

  for (const listCall of toolCalls(run, "ListWakeups")) {
    const list = parseToolOutput<{ currentLocalTime: { now: string; timezone: string; epochMs: number }; wakeups: Array<{ id: string; name: string; runAt: string; dueInMs: number }> }>(listCall)
    assert.ok(list.currentLocalTime.now)
    assert.ok(Array.isArray(list.wakeups))
    for (const wakeup of list.wakeups) {
      assert.ok(wakeup.id)
      assert.ok(wakeup.name)
      assert.ok(wakeup.runAt)
      assert.ok(wakeup.dueInMs >= 0)
    }
  }
  assert.ok(toolCalls(run, "ListWakeups").length >= 2, "expected at least two ListWakeups calls")
  assertToolsCalled(run, wakeupTools)
})

realModelTest("real OpenCode model can pull intermediate output from a long-running script", async () => {
  const fixture = createShellFixture({
    name: "opencode-bg-output",
    body: [
      "#!/bin/sh",
      "printf 'stdout-start\\n'",
      "printf 'stderr-start\\n' >&2",
      "sleep 120",
      "printf 'stdout-end\\n'",
      "printf 'stderr-end\\n' >&2",
    ].join("\n"),
  })

  let run: OpencodeRun
  try {
    run = await runOpencode(
      [
        "This is an integration test. Use only the named tools below.",
        "Do not skip any numbered step. Do not substitute one tool for another.",
        "BackgroundStatus does not return stdout or stderr text. The only way to read stdout/stderr is PullBackgroundOutput.",
        "Call these tools in order:",
        `1. RunInBackground with name "itest-bg-stream" and command: ${fixture.command}`,
        "   Include maxOutputBytes 4096.",
        '2. PullBackgroundOutput with name "itest-bg-stream", stream stdout, lineOffset 0, limit 5. It must return stdout-start.',
        '3. PullBackgroundOutput with name "itest-bg-stream", stream stderr, lineOffset 0, limit 5. It must return stderr-start.',
        '4. BackgroundStatus with name "itest-bg-stream".',
        "5. ListBackgroundCommands with no arguments.",
        '6. CancelBackgroundCommand with name "itest-bg-stream".',
        '7. BackgroundStatus with name "itest-bg-stream".',
        'After the final tool call, answer exactly "done".',
      ].join("\n"),
    )
  } finally {
    fixture.dispose()
  }

  const started = parseToolOutput<{ command: { id: string; name: string; status: string; command: string; processStatus: string; runtimeMs: number } }>(
    requiredTool(run, "RunInBackground"),
  ).command
  assert.equal(started.name, "itest-bg-stream")
  assert.equal(started.status, "running")
  assert.match(started.command, /opencode-bg-output/)
  assert.match(started.processStatus, /running/)
  assert.ok(started.runtimeMs >= 0)

  const stdoutPull = requiredPullOutput(run, (output) => output.stdout?.text.includes("stdout-start") === true)
  assert.match(stdoutPull.stdout?.text ?? "", /stdout-start/)

  const stderrPull = requiredPullOutput(run, (output) => output.stderr?.text.includes("stderr-start") === true)
  assert.match(stderrPull.stderr?.text ?? "", /stderr-start/)

  const listed = parseToolOutput<{ commands: Array<{ id: string; name: string; startedAt: string; processStatus: string; runtimeMs: number }> }>(requiredTool(run, "ListBackgroundCommands")).commands
  assert.ok(listed.some((item) => item.id === started.id), "expected command in ListBackgroundCommands output")
  assert.ok(listed.some((item) => item.name === "itest-bg-stream" && item.startedAt))
  assert.ok(listed.some((item) => item.id === started.id && item.processStatus.includes("running")))

  const statusCalls = toolCalls(run, "BackgroundStatus").map((call) => {
    return parseToolOutput<{ command: { id: string; name: string; status: string; processStatus: string; runtimeMs: number; outputAvailable: { stdout: boolean; stderr: boolean } } }>(call).command
  })
  assert.ok(statusCalls.some((status) => status.id === started.id && status.runtimeMs >= 0))
  assert.ok(statusCalls.some((status) => status.id === started.id && status.outputAvailable.stdout))
  assert.ok(statusCalls.some((status) => status.id === started.id && status.outputAvailable.stderr))

  const cancelled = parseToolOutput<{ command: { id: string; name: string; status: string; processStatus: string; runtimeMs: number } }>(requiredTool(run, "CancelBackgroundCommand")).command
  assert.equal(cancelled.id, started.id)
  assert.equal(cancelled.name, "itest-bg-stream")
  assert.equal(cancelled.status, "cancelled")
  assert.match(cancelled.processStatus, /cancelled/)

  assert.ok(statusCalls.some((status) => status.id === started.id && status.status === "cancelled"))
  assertToolsCalled(run, backgroundTools)
})

realTuiTest("OpenCode TUI prompt history search filters visible candidates as the user types", async () => {
  const systemDbPath = resolveHistoryDbPath()
  const systemPrompts = searchPromptHistory("", { dbPath: systemDbPath, limit: 500 })
  assert.ok(Array.isArray(systemPrompts), "expected current OpenCode prompt history lookup to complete")

  const fixture = createHistoryDbFixture()
  const prompts = searchPromptHistory("", { dbPath: fixture.dbPath, limit: 500 })
  assert.ok(prompts.length > 0, "expected fixture prompt history")
  assert.ok(prompts.some((prompt) => prompt.prompt.includes("tui-history-zebra")), "expected buried target fixture prompt")
  const probe = {
    query: "tui-history-zebra",
    expected: "live-filter",
  }

  try {
    const result = await runTuiHistorySearch({
      query: probe.query,
      expected: probe.expected,
      absentBeforeQuery: true,
      env: { OPENCODE_HISTORY_DB: fixture.dbPath },
    })
    assert.equal(result.ok, true, result.output)
    assert.match(result.output, new RegExp(escapeRegExp(probe.expected)))
  } finally {
    fixture.dispose()
  }
})

async function runOpencode(prompt: string, options: { attach?: string } = {}): Promise<OpencodeRun> {
  const args = ["run", "--format", "json"]
  if (options.attach) args.push("--attach", options.attach)
  if (process.env.OPENCODE_REAL_MODEL) args.push("--model", process.env.OPENCODE_REAL_MODEL)
  args.push(prompt)

  const child = spawn("opencode", args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  const exit = await waitForExit(child, timeoutMs)
  if (exit.code !== 0) {
    assert.fail(`opencode run failed with code ${exit.code}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }

  return {
    stdout,
    stderr,
    tools: parseToolUses(`${stdout}\n${stderr}`),
  }
}

async function runOpencodeRequiringTools(prompt: string, tools: readonly string[], attempts = 3): Promise<OpencodeRun> {
  let lastRun: OpencodeRun | undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastRun = await runOpencode(prompt)
    const missing = tools.filter((tool) => toolCalls(lastRun as OpencodeRun, tool).length === 0)
    if (missing.length === 0) return lastRun
    if (attempt === attempts) break
  }
  const seen = lastRun?.tools.map((call) => call.tool).join(", ") ?? ""
  assert.fail(`missing required tools after ${attempts} attempts; required ${tools.join(", ")}; saw ${seen}`)
}

function mergeRuns(runs: OpencodeRun[]): OpencodeRun {
  return {
    stdout: runs.map((run) => run.stdout).join("\n"),
    stderr: runs.map((run) => run.stderr).join("\n"),
    tools: runs.flatMap((run) => run.tools),
  }
}

function startOpencodeServer(): Promise<OpencodeServer> {
  const port = 48_000 + Math.floor(Math.random() * 1_000)
  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const url = `http://127.0.0.1:${port}`

  return new Promise((resolve, reject) => {
    let settled = false
    let output = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      if (!settled) {
        settled = true
        reject(new Error(`opencode serve did not become ready\n${output}`))
      }
    }, 30_000)
    const onData = (chunk: unknown) => {
      output += String(chunk)
      if (!settled && output.includes(`opencode server listening on ${url}`)) {
        settled = true
        clearTimeout(timer)
        resolve({
          url,
          dispose: () => child.kill("SIGTERM"),
        })
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.on("error", (error: Error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    })
    child.on("close", (code: number | null) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`opencode serve exited before ready with code ${code}\n${output}`))
      }
    })
  })
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeout: number,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`opencode run timed out after ${timeout}ms`))
    }, timeout)
    child.on("close", (code: number | null, signal: string | null) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.on("error", (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function parseToolUses(output: string): ToolUse[] {
  const tools: ToolUse[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue
    const event = parseJsonObject(line)
    if (!isToolUseEvent(event)) continue
    assert.equal(event.part.state.status, "completed", `${event.part.tool} did not complete`)
    tools.push({
      tool: event.part.tool,
      input: event.part.state.input,
      output: event.part.state.output,
    })
  }
  return tools
}

function parseJsonObject(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function isToolUseEvent(value: unknown): value is {
  type: "tool_use"
  part: { tool: string; state: { status: string; input: unknown; output: string } }
} {
  if (!value || typeof value !== "object") return false
  const event = value as { type?: unknown; part?: unknown }
  if (event.type !== "tool_use" || !event.part || typeof event.part !== "object") return false
  const part = event.part as { tool?: unknown; state?: unknown }
  if (typeof part.tool !== "string" || !part.state || typeof part.state !== "object") return false
  const state = part.state as { status?: unknown; input?: unknown; output?: unknown }
  return typeof state.status === "string" && typeof state.output === "string"
}

function requiredTool(run: OpencodeRun, tool: string): ToolUse {
  const calls = toolCalls(run, tool)
  assert.ok(calls.length > 0, `missing ${tool}; saw ${run.tools.map((call) => call.tool).join(", ")}`)
  const call = calls[0]
  if (!call) assert.fail(`missing ${tool}`)
  return call
}

function requiredMatchingTool(run: OpencodeRun, tool: string, predicate: (input: Record<string, unknown>) => boolean): ToolUse {
  const call = toolCalls(run, tool).find((item) => {
    return isRecord(item.input) && predicate(item.input)
  })
  if (!call) assert.fail(`missing matching ${tool}`)
  return call
}

function requiredPullOutput(
  run: OpencodeRun,
  predicate: (output: { stdout?: { text: string; startLine: number }; stderr?: { text: string; startLine: number } }) => boolean,
): { stdout?: { text: string; startLine: number }; stderr?: { text: string; startLine: number } } {
  for (const call of toolCalls(run, "PullBackgroundOutput")) {
    const output = parseToolOutput<{ stdout?: { text: string; startLine: number }; stderr?: { text: string; startLine: number } }>(call)
    if (predicate(output)) return output
  }
  assert.fail(
    [
      "missing matching PullBackgroundOutput",
      `tools called: ${run.tools.map((call) => call.tool).join(", ")}`,
      `pull outputs: ${toolCalls(run, "PullBackgroundOutput").map((call) => call.output).join("\n")}`,
    ].join("\n"),
  )
}

function toolCalls(run: OpencodeRun, tool: string): ToolUse[] {
  return run.tools.filter((call) => call.tool === tool)
}

function assertToolsCalled(run: OpencodeRun, tools: readonly string[]): void {
  for (const tool of tools) {
    assert.ok(toolCalls(run, tool).length > 0, `missing ${tool}; saw ${run.tools.map((call) => call.tool).join(", ")}`)
  }
}

function parseToolOutput<Value>(call: ToolUse): Value {
  try {
    return JSON.parse(call.output) as Value
  } catch (error) {
    assert.fail(`invalid JSON output from ${call.tool}: ${String(error)}\n${call.output}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function createShellFixture(input: { name: string; body: string }): { command: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `${input.name}-`))
  const file = path.join(dir, `${input.name}.sh`)
  writeFileSync(file, `${input.body}\n`)
  chmodSync(file, 0o755)
  return {
    command: `sh ${shellQuote(file)}`,
    dispose: () => rmSync(dir, { force: true, recursive: true }),
  }
}

function shellQuote(value: string): string {
  return `'${path.resolve(value).replace(/'/g, "'\\''")}'`
}

function createHistoryDbFixture(): { dbPath: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-history-tui-"))
  const dbPath = path.join(dir, "opencode.db")
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("create table prompt_history (id text primary key, prompt text not null, created_at integer not null)")
    const insert = db.prepare("insert into prompt_history (id, prompt, created_at) values (?, ?, ?)")
    const now = Date.now()
    for (let i = 0; i < 220; i++) {
      insert.run(`tui-history-decoy-${i}`, `recent ordinary prompt ${String(i).padStart(3, "0")} from prompt history`, now + i)
    }
    insert.run(
      "tui-history-fixture-target",
      "search for tui-history-zebra live-filter target from prompt history",
      now - 10_000,
    )
  } finally {
    db.close()
  }
  return {
    dbPath,
    dispose: () => rmSync(dir, { force: true, recursive: true }),
  }
}

async function runTuiHistorySearch(input: {
  query: string
  expected: string
  absentBeforeQuery?: boolean
  env: Record<string, string>
}): Promise<{ ok: boolean; output: string }> {
  const script = createPexpectHistoryScript()
  const xdg = createTuiXdgFixture()
  try {
    const payload = JSON.stringify({
      cwd: process.cwd(),
      query: input.query,
      expected: input.expected,
      dialogReady: "Filter 221 prompts",
      absentBeforeQuery: input.absentBeforeQuery ?? false,
      env: {
        XDG_DATA_HOME: xdg.data,
        XDG_CACHE_HOME: xdg.cache,
        XDG_STATE_HOME: xdg.state,
        ...input.env,
        TERM: process.env.TERM || "xterm-256color",
      },
      timeout: Math.min(60, Math.max(15, Math.ceil(timeoutMs / 1_000))),
    })
    const child = spawn("python3", [script.file, payload], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const exit = await waitForExit(child, timeoutMs)
    const output = `${stdout}\n${stderr}`
    if (exit.code !== 0) return { ok: false, output }
    const line = stdout.split(/\r?\n/).find((item) => item.trim().startsWith("{"))
    const parsed = line ? parseJsonObject(line) : undefined
    if (!isRecord(parsed) || parsed.ok !== true || typeof parsed.output !== "string") {
      return { ok: false, output }
    }
    return { ok: true, output: parsed.output }
  } finally {
    xdg.dispose()
    script.dispose()
  }
}

function createTuiXdgFixture(): { data: string; cache: string; state: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-tui-xdg-"))
  const data = path.join(dir, "data")
  const cache = path.join(dir, "cache")
  const state = path.join(dir, "state")
  mkdirSync(data, { recursive: true })
  mkdirSync(cache, { recursive: true })
  mkdirSync(state, { recursive: true })
  return {
    data,
    cache,
    state,
    dispose: () => rmSync(dir, { force: true, recursive: true }),
  }
}

function createPexpectHistoryScript(): { file: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-tui-pexpect-"))
  const file = path.join(dir, "history_search.py")
  writeFileSync(file, [
    "import json, os, sys, time",
    "import pexpect",
    "",
    "cfg = json.loads(sys.argv[1])",
    "env = os.environ.copy()",
    "env.update(cfg.get('env', {}))",
    "child = pexpect.spawn('opencode', cwd=cfg['cwd'], env=env, dimensions=(40, 120), encoding='utf-8', timeout=cfg.get('timeout', 30))",
    "captured = []",
    "ok = False",
    "try:",
    "    child.expect(['Session', 'Continue', 'opencode', 'OpenCode', pexpect.TIMEOUT], timeout=20)",
    "    captured.append(str(child.before) + str(child.after))",
    "    child.send('/oc-history')",
    "    child.expect_exact('/oc-history', timeout=20)",
    "    captured.append(str(child.before) + '/oc-history')",
    "    child.send('\\r')",
    "    child.expect_exact('Prompt History', timeout=20)",
    "    captured.append(str(child.before) + 'Prompt History')",
    "    child.expect_exact(cfg['dialogReady'], timeout=20)",
    "    captured.append(str(child.before) + cfg['dialogReady'])",
    "    time.sleep(0.2)",
    "    if cfg.get('absentBeforeQuery'):",
    "        try:",
    "            child.expect_exact(cfg['expected'], timeout=1)",
    "            captured.append(str(child.before) + cfg['expected'])",
    "            raise AssertionError('expected candidate was visible before typing')",
    "        except pexpect.TIMEOUT:",
    "            captured.append('candidate was absent before typing')",
    "    child.sendcontrol('u')",
    "    for ch in cfg['query']:",
    "        child.send(ch)",
    "        time.sleep(0.01)",
    "    child.expect_exact(cfg['expected'], timeout=20)",
    "    captured.append(str(child.before) + cfg['expected'])",
    "    ok = True",
    "except Exception as error:",
    "    captured.append(str(getattr(error, 'value', error)))",
    "    captured.append(str(child.before))",
    "finally:",
    "    try:",
    "        child.sendcontrol('c')",
    "        time.sleep(0.2)",
    "        child.sendcontrol('c')",
    "    except Exception:",
    "        pass",
    "    child.close(force=True)",
    "print(json.dumps({'ok': ok, 'output': '\\n'.join(captured)[-6000:]}))",
    "",
  ].join("\n"))
  chmodSync(file, 0o755)
  return {
    file,
    dispose: () => rmSync(dir, { force: true, recursive: true }),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
