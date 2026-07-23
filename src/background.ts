import { spawn } from "node:child_process"
import { DEFAULTS } from "./config.js"
import { postSessionNote, type DeliveryResult } from "./delivery.js"
import { OutputBuffer, type OutputBufferSnapshot, type OutputLineRange } from "./output-buffer.js"
import { nowIso } from "./time.js"
import type { OpenCodeClient } from "./types.js"

export interface RunInBackgroundArgs {
  name: string
  command: string
  cwd?: string
  timeoutSeconds?: number
  maxOutputBytes?: number
}

export interface PullBackgroundOutputArgs {
  id?: string
  name?: string
  stream?: "stdout" | "stderr" | "both"
  lineOffset?: number
  limit?: number
  tail?: number
}

export type BackgroundStatusValue = "running" | "exited" | "failed" | "timeout" | "cancelled"

export interface BackgroundCommandRecord {
  id: string
  name: string
  sessionID?: string
  command: string
  cwd: string
  pid?: number
  status: BackgroundStatusValue
  exitCode?: number | null
  signal?: string | null
  startedAt: string
  endedAt?: string
  runtimeMs: number
  runtimeSeconds: number
  processStatus: string
  stdout: string
  stderr: string
  outputRetention: {
    stdout: OutputRetention
    stderr: OutputRetention
  }
  outputRanges: {
    stdout: OutputLineRange[]
    stderr: OutputLineRange[]
  }
  lastDelivery?: DeliveryResult
}

export interface OutputRetention {
  maxBytes: number
  totalBytes: number
  retainedBytes: number
  omittedBytes: number
  truncated: boolean
  headBytes: number
  tailBytes: number
}

interface InternalCommand extends Omit<BackgroundCommandRecord, "stdout" | "stderr" | "runtimeMs" | "runtimeSeconds" | "processStatus" | "outputRetention" | "outputRanges"> {
  proc?: BackgroundProcess
  maxOutputBytes: number
  stdoutBuffer: OutputBuffer
  stderrBuffer: OutputBuffer
  timeout?: NodeJS.Timeout
  killedByUser?: boolean
}

interface BackgroundProcess {
  pid?: number
  killed: boolean
  exitCode: number | null
  kill(signal?: string): boolean
}

export class BackgroundManager {
  private commands = new Map<string, InternalCommand>()
  private nextID = 1

  constructor(
    private readonly client: OpenCodeClient | undefined,
    private readonly defaultCwd: string,
  ) {}

  run(args: RunInBackgroundArgs, sessionID?: string): BackgroundCommandRecord {
    if (!args.command?.trim()) throw new Error("command is required")
    const name = normalizeName(args.name)
    if (this.findByName(name)) throw new Error(`duplicate background command name: ${name}`)
    if (this.activeCount() >= DEFAULTS.maxActiveBackgroundCommands) {
      throw new Error(`maximum active background commands reached (${DEFAULTS.maxActiveBackgroundCommands})`)
    }
    const timeoutSeconds = args.timeoutSeconds === 0 ? undefined : args.timeoutSeconds
    if (timeoutSeconds !== undefined && timeoutSeconds < 0) {
      throw new Error("timeoutSeconds must be positive")
    }
    const maxOutputBytes =
      args.maxOutputBytes === undefined ? DEFAULTS.defaultOutputBytesPerStream : validateMaxOutputBytes(args.maxOutputBytes)
    const id = `bg-${this.nextID++}`
    const record: InternalCommand = {
      id,
      name,
      sessionID,
      command: args.command,
      cwd: args.cwd ?? this.defaultCwd,
      status: "running",
      startedAt: nowIso(),
      maxOutputBytes,
      stdoutBuffer: new OutputBuffer(maxOutputBytes),
      stderrBuffer: new OutputBuffer(maxOutputBytes),
    }
    this.commands.set(id, record)

    try {
      const proc = spawn(args.command, {
        cwd: record.cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
      record.proc = proc
      record.pid = proc.pid
      proc.stdout.on("data", (chunk) => this.captureOutput(record, "stdout", chunk))
      proc.stderr.on("data", (chunk) => this.captureOutput(record, "stderr", chunk))
      proc.on("error", (error) => void this.finish(id, "failed", undefined, undefined, error.message))
      proc.on("close", (code, signal) => void this.finish(id, record.status === "timeout" ? "timeout" : record.status === "cancelled" ? "cancelled" : "exited", code, signal))
      if (timeoutSeconds) {
        record.timeout = setTimeout(() => {
          record.status = "timeout"
          this.terminate(record)
        }, timeoutSeconds * 1_000)
        record.timeout.unref?.()
      }
    } catch (error) {
      record.stderrBuffer.append(error instanceof Error ? error.message : String(error))
      record.status = "failed"
      record.endedAt = nowIso()
    }

    return this.snapshot(record)
  }

  get(idOrName: string): BackgroundCommandRecord {
    return this.snapshot(this.resolve(idOrName))
  }

  list(): BackgroundCommandRecord[] {
    return [...this.commands.values()].map((record) => this.snapshot(record))
  }

  pull(args: PullBackgroundOutputArgs): {
    id: string
    name: string
    status: BackgroundStatusValue
    processStatus: string
    runtimeMs: number
    runtimeSeconds: number
    stream: "stdout" | "stderr" | "both"
    lineOffset: number
    limit: number
    tail?: number
    stdout?: OutputRead
    stderr?: OutputRead
  } {
    const record = this.resolve(args.id ?? args.name)
    const stream = args.stream ?? "both"
    if (!["stdout", "stderr", "both"].includes(stream)) throw new Error("stream must be stdout, stderr, or both")
    const limit = clampLineLimit(args.limit)
    const rawTail = args.tail === undefined ? undefined : validateNonNegativeInteger(args.tail, "tail")
    const explicitLineOffset = args.lineOffset
    if (rawTail !== undefined && rawTail > 0) {
      if (explicitLineOffset !== undefined && explicitLineOffset !== 0 && explicitLineOffset !== -1) {
        throw new Error("provide either tail or lineOffset, not both")
      }
      const tail = rawTail
      const lineOffset = 0

      return {
        id: record.id,
        name: record.name,
        status: record.status,
        processStatus: processStatus(record),
        runtimeMs: runtimeMs(record),
        runtimeSeconds: runtimeSeconds(record),
        stream,
        lineOffset,
        limit,
        tail,
        stdout: stream === "stdout" || stream === "both" ? readOutputBuffer(record.stdoutBuffer, { lineOffset, limit, tail }) : undefined,
        stderr: stream === "stderr" || stream === "both" ? readOutputBuffer(record.stderrBuffer, { lineOffset, limit, tail }) : undefined,
      }
    }

    const lineOffset = explicitLineOffset === undefined ? 0 : validateNonNegativeInteger(explicitLineOffset, "lineOffset")

    return {
      id: record.id,
      name: record.name,
      status: record.status,
      processStatus: processStatus(record),
      runtimeMs: runtimeMs(record),
      runtimeSeconds: runtimeSeconds(record),
      stream,
      lineOffset,
      limit,
      stdout: stream === "stdout" || stream === "both" ? readOutputBuffer(record.stdoutBuffer, { lineOffset, limit }) : undefined,
      stderr: stream === "stderr" || stream === "both" ? readOutputBuffer(record.stderrBuffer, { lineOffset, limit }) : undefined,
    }
  }

  cancel(idOrName: string): BackgroundCommandRecord {
    const record = this.resolve(idOrName)
    if (record.status !== "running") return this.snapshot(record)
    record.status = "cancelled"
    this.terminate(record)
    return this.snapshot(record)
  }

  cancelByUser(idOrName: string): BackgroundCommandRecord {
    const record = this.resolve(idOrName)
    if (record.status !== "running") return this.snapshot(record)
    record.killedByUser = true
    record.status = "cancelled"
    this.terminate(record)
    return this.snapshot(record)
  }

  clear(): { cleared: number; killed: number } {
    let killed = 0
    const cleared = this.commands.size
    for (const record of this.commands.values()) {
      if (record.status === "running") {
        killed += 1
        record.status = "cancelled"
        this.terminate(record)
      }
      if (record.timeout) clearTimeout(record.timeout)
    }
    this.commands.clear()
    return { cleared, killed }
  }

  dispose(): void {
    for (const record of this.commands.values()) {
      if (record.status === "running") {
        record.status = "cancelled"
        this.terminate(record)
      }
      if (record.timeout) clearTimeout(record.timeout)
    }
    this.commands.clear()
  }

  private activeCount(): number {
    return [...this.commands.values()].filter((record) => record.status === "running").length
  }

  private resolve(idOrName: string | undefined): InternalCommand {
    if (!idOrName?.trim()) throw new Error("provide id or name")
    const record = this.commands.get(idOrName) ?? this.findByName(idOrName)
    if (!record) throw new Error(`unknown background command: ${idOrName}`)
    return record
  }

  private findByName(name: string): InternalCommand | undefined {
    const normalized = normalizeName(name)
    return [...this.commands.values()].find((record) => record.name === normalized)
  }

  private terminate(record: InternalCommand, graceMs: number = DEFAULTS.cancelGraceMs): void {
    const proc = record.proc
    if (!proc || proc.killed) return
    killProcess(proc, "SIGTERM")
    if (graceMs > 0) {
      setTimeout(() => {
        if (!proc.killed && proc.exitCode === null) killProcess(proc, "SIGKILL")
      }, graceMs).unref?.()
    }
  }

  private async finish(
    id: string,
    status: BackgroundStatusValue,
    code?: number | null,
    signal?: NodeJS.Signals | string | null,
    error?: string,
  ): Promise<void> {
    const record = this.commands.get(id)
    if (!record || record.endedAt) return
    if (record.timeout) clearTimeout(record.timeout)
    if (error) record.stderrBuffer.append(error)
    record.status = status
    record.exitCode = code
    record.signal = signal
    record.endedAt = nowIso()
    record.lastDelivery = await postSessionNote(this.client, record.sessionID, this.completionSummary(record))
  }

  private completionSummary(record: InternalCommand): string {
    if (record.killedByUser) {
      return `Background command ${record.name} was killed by user: ${record.command}`
    }
    const stdout = record.stdoutBuffer.snapshot()
    const inlineStdout = stdout.totalBytes > 0 && stdout.totalBytes < 32 && !stdout.truncated
      ? `\nstdout (${stdout.totalBytes} bytes):\n${stdout.text}`
      : ""
    return `Background command ${record.name} finished with status ${record.status} (exit ${record.exitCode ?? "n/a"}): ${record.command}${inlineStdout}`
  }

  private captureOutput(record: InternalCommand, stream: "stdout" | "stderr", chunk: Buffer | string): void {
    if (stream === "stdout") {
      record.stdoutBuffer.append(chunk)
    } else {
      record.stderrBuffer.append(chunk)
    }
  }

  private snapshot(record: InternalCommand): BackgroundCommandRecord {
    const { proc: _proc, timeout: _timeout, stdoutBuffer, stderrBuffer, maxOutputBytes, ...rest } = record
    const stdout = stdoutBuffer.snapshot()
    const stderr = stderrBuffer.snapshot()
    return {
      ...rest,
      runtimeMs: runtimeMs(record),
      runtimeSeconds: runtimeSeconds(record),
      processStatus: processStatus(record),
      stdout: stdout.text,
      stderr: stderr.text,
      outputRetention: {
        stdout: retention(maxOutputBytes, stdout),
        stderr: retention(maxOutputBytes, stderr),
      },
      outputRanges: {
        stdout: stdout.availableLineRanges,
        stderr: stderr.availableLineRanges,
      },
    }
  }
}

export interface OutputRead {
  totalLines: number
  startLine: number
  nextLineOffset: number
  returnedLines: number
  available: boolean
  message?: string
  availableLineRanges: OutputLineRange[]
  truncated: boolean
  retention: OutputRetention
  text: string
}

function readOutputBuffer(
  buffer: OutputBuffer,
  options: { lineOffset: number; limit: number; tail?: number },
): OutputRead {
  const snapshot = buffer.snapshot()
  const totalLines = snapshot.totalLines
  const read = selectAvailableLines(snapshot, options)
  return {
    totalLines,
    startLine: read.startLine,
    nextLineOffset: read.nextLineOffset,
    returnedLines: read.lines.length,
    available: read.available,
    message: read.message,
    availableLineRanges: snapshot.availableLineRanges,
    truncated: snapshot.truncated || read.nextLineOffset < totalLines,
    retention: retention(snapshot.maxBytes, snapshot),
    text: read.lines.join("\n"),
  }
}

function selectAvailableLines(
  snapshot: OutputBufferSnapshot,
  options: { lineOffset: number; limit: number; tail?: number },
): { startLine: number; nextLineOffset: number; lines: string[]; available: boolean; message?: string } {
  if (options.tail !== undefined) {
    const tailLines = splitLines(snapshot.truncated ? snapshot.tailText : snapshot.text)
    const requestedStartLine = Math.max(0, snapshot.totalLines - options.tail)
    if (tailLines.length === 0) {
      if (!snapshot.truncated) {
        return {
          startLine: snapshot.totalLines,
          nextLineOffset: snapshot.totalLines,
          lines: [],
          available: true,
        }
      }
      return {
        startLine: snapshot.totalLines,
        nextLineOffset: snapshot.totalLines,
        lines: [],
        available: false,
        message: unavailableMessage(requestedStartLine, snapshot.availableLineRanges),
      }
    }
    const unavailableTailLines = snapshot.truncated && options.tail > tailLines.length
    const returned = tailLines.slice(Math.max(0, tailLines.length - options.tail), Math.max(0, tailLines.length - options.tail) + options.limit)
    const startLine = Math.max(0, snapshot.totalLines - tailLines.length + Math.max(0, tailLines.length - options.tail))
    return {
      startLine,
      nextLineOffset: startLine + returned.length,
      lines: returned,
      available: !unavailableTailLines,
      message: unavailableTailLines ? unavailableMessage(requestedStartLine, snapshot.availableLineRanges) : undefined,
    }
  }

  const range = snapshot.availableLineRanges.find(
    (candidate) => options.lineOffset >= candidate.startLine && options.lineOffset < candidate.endLine,
  )
  if (!range) {
    if (options.lineOffset === snapshot.totalLines) {
      return {
        startLine: options.lineOffset,
        nextLineOffset: options.lineOffset,
        lines: [],
        available: true,
      }
    }
    if (options.lineOffset > snapshot.totalLines) {
      return {
        startLine: options.lineOffset,
        nextLineOffset: options.lineOffset,
        lines: [],
        available: false,
        message: `Requested output line offset ${options.lineOffset} is beyond the end of the stream; total lines: ${snapshot.totalLines}.`,
      }
    }
    return {
      startLine: options.lineOffset,
      nextLineOffset: options.lineOffset,
      lines: [],
      available: false,
      message: unavailableMessage(options.lineOffset, snapshot.availableLineRanges),
    }
  }

  const source = snapshot.truncated && range.startLine > 0 ? snapshot.tailText : snapshot.truncated ? snapshot.headText : snapshot.text
  const sourceLines = splitLines(source)
  const offsetInSource = options.lineOffset - range.startLine
  const maxFromRange = Math.max(0, range.endLine - options.lineOffset)
  const selected = sourceLines.slice(offsetInSource, offsetInSource + Math.min(options.limit, maxFromRange))
  const nextLineOffset = options.lineOffset + selected.length
  return {
    startLine: options.lineOffset,
    nextLineOffset,
    lines: selected,
    available: true,
    message:
      snapshot.truncated && selected.length < options.limit && nextLineOffset < snapshot.totalLines
        ? unavailableMessage(nextLineOffset, snapshot.availableLineRanges)
        : undefined,
  }
}

function unavailableMessage(lineOffset: number, ranges: OutputLineRange[]): string {
  const rendered = ranges.length
    ? ranges.map((range) => `${range.startLine}-${Math.max(range.startLine, range.endLine - 1)}`).join(", ")
    : "none"
  return `Requested output line offset ${lineOffset} is unavailable because middle output was omitted from memory; available line ranges: ${rendered}.`
}

function splitLines(text: string): string[] {
  if (!text) return []
  if (text.endsWith("\n")) {
    const normalized = text.slice(0, -1)
    return normalized ? normalized.split(/\r?\n/) : [""]
  }
  return text.split(/\r?\n/)
}

function clampLineLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULTS.defaultPullLineLimit
  const validated = validateNonNegativeInteger(limit, "limit")
  if (validated === 0) return 0
  return Math.min(validated, DEFAULTS.maxPullLineLimit)
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function validateMaxOutputBytes(value: number): number {
  const validated = validateNonNegativeInteger(value, "maxOutputBytes")
  if (validated > DEFAULTS.maxOutputBytesPerStream) {
    throw new Error(`maxOutputBytes must be ${DEFAULTS.maxOutputBytesPerStream} bytes or fewer`)
  }
  return validated
}

function retention(maxBytes: number, snapshot: OutputBufferSnapshot): OutputRetention {
  return {
    maxBytes,
    totalBytes: snapshot.totalBytes,
    retainedBytes: snapshot.retainedBytes,
    omittedBytes: snapshot.omittedBytes,
    truncated: snapshot.truncated,
    headBytes: snapshot.headBytes,
    tailBytes: snapshot.tailBytes,
  }
}

function runtimeMs(record: { startedAt: string; endedAt?: string }): number {
  const start = Date.parse(record.startedAt)
  const end = record.endedAt ? Date.parse(record.endedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, end - start)
}

function runtimeSeconds(record: { startedAt: string; endedAt?: string }): number {
  return Math.round(runtimeMs(record) / 100) / 10
}

function processStatus(record: { status: BackgroundStatusValue; pid?: number; exitCode?: number | null; signal?: string | null; endedAt?: string }): string {
  if (record.status === "running") return `running${record.pid ? ` pid ${record.pid}` : ""}`
  const exit = record.exitCode === undefined || record.exitCode === null ? "n/a" : String(record.exitCode)
  return `${record.status} exit ${exit}${record.signal ? ` signal ${record.signal}` : ""}`
}

function normalizeName(value: string | undefined): string {
  const name = value?.trim()
  if (!name) throw new Error("name is required")
  if (name.length > 40) throw new Error("name must be 40 characters or fewer")
  return name
}

function killProcess(proc: BackgroundProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && proc.pid) {
      process.kill(-proc.pid, signal)
      return
    }
  } catch {
    // Fall back to killing the direct child below.
  }
  proc.kill(signal)
}
