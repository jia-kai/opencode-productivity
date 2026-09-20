import { BackgroundManager, type BackgroundCommandRecord } from "./background.js"
import { WakeupScheduler, type WakeupRecord } from "./scheduler.js"
import {
  connectProductivityServerToTui,
  discoverProductivityTuiSockets,
  type ProductivityActionHandler,
  type ProductivityActionRequest,
  type ProductivityActionResponse,
  type ProductivityServerIpcClient,
} from "./ipc.js"
import { localTimeContext } from "./time.js"
import type { OpenCodeClient, PluginContext, ToolContext } from "./types.js"

interface SchemaBuilder {
  string(): SchemaValue
  number(): SchemaValue
  boolean(): SchemaValue
}

interface SchemaValue {
  optional(): SchemaValue
  describe(text: string): SchemaValue
}

type ToolFactory = ((definition: unknown) => unknown) & { schema?: SchemaBuilder }

export type BackgroundStatusView = Omit<BackgroundCommandRecord, "stdout" | "stderr"> & {
  outputAvailable: {
    stdout: boolean
    stderr: boolean
  }
}

export interface ProductivityToolDefinition {
  description: string
  args: Record<string, SchemaValue>
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>
}

export interface ToolArgSpec {
  type: "string" | "number" | "boolean"
  description: string
  optional?: boolean
}

/**
 * Single source of truth for tool arguments. The v1 plugin converts these to
 * the host schema builder; the v2 plugin converts them to JSON Schema.
 */
const TOOL_ARG_SPECS: Record<string, Record<string, ToolArgSpec>> = {
  ScheduleWakeup: {
    name: { type: "string", description: "Short unique name for this wakeup, 40 characters or fewer" },
    message: { type: "string", description: "Message to deliver when the wakeup fires" },
    runAt: { type: "string", description: "ISO datetime for the wakeup. Omit delaySeconds when using this.", optional: true },
    delaySeconds: { type: "number", description: "Non-negative delay in seconds from now. Omit this when runAt is provided.", optional: true },
    repeatSeconds: { type: "number", description: "Optional repeat interval in seconds. Omit or use 0 for one-shot; positive repeat intervals must be at least 60.", optional: true },
    label: { type: "string", description: "Optional short label", optional: true },
  },
  ListWakeups: {},
  CancelWakeup: {
    id: { type: "string", description: "Wakeup ID", optional: true },
    name: { type: "string", description: "Wakeup name", optional: true },
  },
  RunInBackground: {
    name: { type: "string", description: "Short unique name for this background command, 40 characters or fewer" },
    command: { type: "string", description: "Non-empty shell command to run" },
    cwd: { type: "string", description: "Working directory; defaults to the current OpenCode project directory", optional: true },
    timeoutSeconds: { type: "number", description: "Optional positive timeout in seconds; omit or use 0 for no timeout", optional: true },
    maxOutputBytes: { type: "number", description: "Maximum in-memory stdout/stderr bytes per stream; defaults to and is capped at 1048576, split between head and tail when exceeded", optional: true },
  },
  BackgroundStatus: {
    id: { type: "string", description: "Background command ID", optional: true },
    name: { type: "string", description: "Background command name", optional: true },
  },
  PullBackgroundOutput: {
    id: { type: "string", description: "Background command ID", optional: true },
    name: { type: "string", description: "Background command name", optional: true },
    stream: { type: "string", description: "stdout, stderr, or both; defaults to both", optional: true },
    lineOffset: { type: "number", description: "Non-negative zero-based line offset to start reading from; defaults to 0. Omit this when tail is provided.", optional: true },
    limit: { type: "number", description: "Maximum number of lines to return; defaults to 200 and is capped at 5000", optional: true },
    tail: { type: "number", description: "Return the last N lines instead of reading from lineOffset; must be non-negative", optional: true },
  },
  ListBackgroundCommands: {},
  CancelBackgroundCommand: {
    id: { type: "string", description: "Background command ID", optional: true },
    name: { type: "string", description: "Background command name", optional: true },
  },
}

export function productivityToolArgSpecs(name: string): Record<string, ToolArgSpec> {
  return TOOL_ARG_SPECS[name] ?? {}
}

export function productivityToolJsonSchema(name: string) {
  const properties: Record<string, { type: string; description: string }> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(productivityToolArgSpecs(name))) {
    properties[key] = { type: spec.type, description: spec.description }
    if (!spec.optional) required.push(key)
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }
}

function buildToolArgs(schema: SchemaBuilder | undefined, name: string): Record<string, SchemaValue> {
  const args: Record<string, SchemaValue> = {}
  if (!schema) return args
  for (const [key, spec] of Object.entries(productivityToolArgSpecs(name))) {
    let value: SchemaValue = schema[spec.type]()
    if (spec.optional) value = value.optional()
    args[key] = value.describe(spec.description)
  }
  return args
}

export interface ProductivityState {
  scheduler: WakeupScheduler
  background: BackgroundManager
  snapshot(): {
    instanceID: string
    serverPid: number
    sessions: string[]
    wakeups: WakeupRecord[]
    commands: BackgroundStatusView[]
  }
  publish(): void
  actionHandler: ProductivityActionHandler
  dispose(): Promise<void>
}

export function createProductivityState(client: OpenCodeClient | undefined, directory: string): ProductivityState {
  const scheduler = new WakeupScheduler(client)
  const background = new BackgroundManager(client, directory)
  const instanceID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const tuiConnections = new Map<string, ProductivityServerIpcClient>()
  const actionHandler: ProductivityActionHandler = (request) => handleActionRequest(request, { scheduler, background, publish })
  const snapshot = () => ({
    instanceID,
    serverPid: process.pid,
    sessions: knownSessions(scheduler.list(), background.list()),
    wakeups: scheduler.list(),
    commands: background.list().map(backgroundStatusView),
  })
  const publish = () => {
    discoverTuiConnections()
    const current = snapshot()
    for (const connection of tuiConnections.values()) connection.sendSnapshot(current)
  }
  const publishInterval = setInterval(publish, 1_000)
  publishInterval.unref?.()
  publish()

  function connectToTui(socketPath: string) {
    const existing = tuiConnections.get(socketPath)
    if (existing && !existing.isClosed()) {
      existing.sendSnapshot(snapshot())
      return
    }
    existing?.close()
    const connection = connectProductivityServerToTui(socketPath, snapshot(), actionHandler, () => {
      if (tuiConnections.get(socketPath) === connection) tuiConnections.delete(socketPath)
    })
    tuiConnections.set(socketPath, connection)
    publish()
  }

  function discoverTuiConnections() {
    for (const socketPath of discoverProductivityTuiSockets(directory)) {
      const existing = tuiConnections.get(socketPath)
      if (!existing || existing.isClosed()) connectToTui(socketPath)
    }
  }

  return {
    scheduler,
    background,
    snapshot,
    publish,
    actionHandler,
    dispose: async () => {
      clearInterval(publishInterval)
      for (const connection of tuiConnections.values()) connection.close()
      tuiConnections.clear()
      scheduler.dispose()
      background.dispose()
    },
  }
}

export function createProductivityToolDefinitions(
  schema: SchemaBuilder | undefined,
  state: Pick<ProductivityState, "scheduler" | "background" | "publish">,
): Record<string, ProductivityToolDefinition> {
  const { scheduler, background, publish } = state
  return {
    ScheduleWakeup: {
      description: "Schedule a one-shot or repeated wakeup for the current OpenCode session. Requires a short unique name, a message, and exactly one of runAt or delaySeconds. Omit delaySeconds when using runAt.",
      args: buildToolArgs(schema, "ScheduleWakeup"),
      async execute(args: Record<string, unknown>, context: ToolContext) {
        const result = scheduler.schedule(args as never, context.sessionID)
        publish()
        return toolJson({ currentLocalTime: localTimeContext(), wakeup: result })
      },
    },
    ListWakeups: {
      description: "List scheduled, fired, cancelled, and failed wakeups for this OpenCode process, including current local time for schedule reasoning.",
      args: buildToolArgs(schema, "ListWakeups"),
      async execute() {
        publish()
        return toolJson({ currentLocalTime: localTimeContext(), wakeups: scheduler.list() })
      },
    },
    CancelWakeup: {
      description: "Cancel a wakeup by ID or name. Provide one identifier; name is the short unique name used when scheduling.",
      args: buildToolArgs(schema, "CancelWakeup"),
      async execute(args: { id?: string; name?: string }) {
        const result = scheduler.cancel(args.id ?? args.name ?? "")
        publish()
        return toolJson({ currentLocalTime: localTimeContext(), wakeup: result })
      },
    },
    RunInBackground: {
      description: "Run a non-interactive shell command in the background for this conversation. Requires a short unique name and command; stdout/stderr are retained in memory and read with PullBackgroundOutput.",
      args: buildToolArgs(schema, "RunInBackground"),
      async execute(args: Record<string, unknown>, context: ToolContext) {
        const result = background.run(args as never, context.sessionID)
        publish()
        return toolJson({
          command: result,
          nextAction: result.status === "running"
            ? "The command is running in the background. You will receive a completion message in this conversation when it exits. Do not poll for completion unless the user explicitly asked for live progress or immediate output. Do not call sleep or otherwise block before checking status. Do not schedule a wakeup just to check completion."
            : "The command did not remain running. Inspect the command status and retained output if needed.",
        })
      },
    },
    BackgroundStatus: {
      description: "Get process metadata for a background command by ID or name, including running/exited status and runtime. Use PullBackgroundOutput to read stdout/stderr text.",
      args: buildToolArgs(schema, "BackgroundStatus"),
      async execute(args: { id?: string; name?: string }) {
        publish()
        return toolJson({ command: backgroundStatusView(background.get(args.id ?? args.name ?? "")) })
      },
    },
    PullBackgroundOutput: {
      description: "Pull retained in-memory stdout/stderr from a running or completed background command by ID or name. Use lineOffset for forward reads, or tail for the last N lines. When using tail, omit lineOffset. If requested lines were omitted, the response explains the error and available ranges.",
      args: buildToolArgs(schema, "PullBackgroundOutput"),
      async execute(args: Record<string, unknown>) {
        publish()
        return toolJson(background.pull(args as never))
      },
    },
    ListBackgroundCommands: {
      description: "List background commands for this OpenCode process, including status, runtime, output availability, and retention metadata but not stdout/stderr text.",
      args: buildToolArgs(schema, "ListBackgroundCommands"),
      async execute() {
        publish()
        return toolJson({ commands: background.list().map(backgroundStatusView) })
      },
    },
    CancelBackgroundCommand: {
      description: "Terminate a running background command by ID or name. If the command already finished, this returns its current status unchanged.",
      args: buildToolArgs(schema, "CancelBackgroundCommand"),
      async execute(args: { id?: string; name?: string }) {
        const result = background.cancel(args.id ?? args.name ?? "")
        publish()
        return toolJson({ command: backgroundStatusView(result) })
      },
    },
  }
}

export function createProductivityPlugin(tool: ToolFactory) {
  const schema = tool.schema
  if (!schema) throw new Error("@opencode-ai/plugin tool.schema is required")

  return async function ProductivityPlugin(ctx: PluginContext) {
    const state = createProductivityState(ctx.client, ctx.directory)
    const definitions = createProductivityToolDefinitions(schema, state)
    const tools: Record<string, unknown> = {}
    for (const [name, definition] of Object.entries(definitions)) {
      tools[name] = tool(definition)
    }
    return { tool: tools, dispose: state.dispose }
  }
}

function knownSessions(wakeups: Array<{ sessionID?: string }>, commands: Array<{ sessionID?: string }>): string[] {
  return [...new Set([...wakeups, ...commands].map((item) => item.sessionID).filter((value): value is string => typeof value === "string" && value.length > 0))]
}

export async function handleActionRequest(request: ProductivityActionRequest, state: {
  scheduler: WakeupScheduler
  background: BackgroundManager
  publish: () => void
}): Promise<ProductivityActionResponse> {
  try {
    if (request.action === "cancel-wakeup") {
      const wakeup = await state.scheduler.cancelByUser(request.target)
      state.publish()
      return {
        id: request.id,
        respondedAt: new Date().toISOString(),
        ok: true,
        title: "Wakeup Cancelled",
        message: `${wakeup.id} / ${wakeup.name} was cancelled.`,
      }
    }
    if (request.action === "cancel-background") {
      const command = state.background.cancelByUser(request.target)
      state.publish()
      return {
        id: request.id,
        respondedAt: new Date().toISOString(),
        ok: true,
        title: "Background Cancelled",
        message: `${command.id} / ${command.name} was killed by user.`,
      }
    }
    if (request.action === "pull-background-output") {
      const output = state.background.pull({
        id: request.target,
        stream: request.stream ?? "both",
        tail: request.tail ?? 80,
        limit: request.limit ?? 200,
      })
      return {
        id: request.id,
        respondedAt: new Date().toISOString(),
        ok: true,
        title: `Output ${output.id} / ${output.name}`,
        message: formatPulledOutput(output),
      }
    }
    if (request.action === "reset") {
      state.scheduler.clear()
      state.background.clear()
      state.publish()
      return {
        id: request.id,
        respondedAt: new Date().toISOString(),
        ok: true,
        title: "Productivity State Reset",
        message: `Cleared wakeups and background commands for ${request.target || "the current conversation"}.`,
      }
    }
    return {
      id: request.id,
      respondedAt: new Date().toISOString(),
      ok: false,
      title: "Productivity Action Failed",
      message: "Unknown productivity action.",
    }
  } catch (error) {
    return {
      id: request.id,
      respondedAt: new Date().toISOString(),
      ok: false,
      title: "Productivity Action Failed",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function formatPulledOutput(output: ReturnType<BackgroundManager["pull"]>): string {
  const sections = [
    output.stdout ? formatOutputSection("stdout", output.stdout) : "",
    output.stderr ? formatOutputSection("stderr", output.stderr) : "",
  ].filter(Boolean)
  return sections.join("\n\n") || "No output retained."
}

function formatOutputSection(name: string, output: NonNullable<ReturnType<BackgroundManager["pull"]>["stdout"]>): string {
  const header = `${name}: lines ${output.startLine}-${Math.max(output.startLine, output.nextLineOffset - 1)} of ${output.totalLines}`
  const availability = output.available ? "" : `\n${output.message ?? "Requested output is unavailable."}`
  return `${header}${availability}\n${output.text || "(no text)"}`
}

function toolJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function backgroundStatusView(command: BackgroundCommandRecord): BackgroundStatusView {
  const { stdout, stderr, ...rest } = command
  return {
    ...rest,
    outputAvailable: {
      stdout: rest.outputRanges.stdout.length > 0,
      stderr: rest.outputRanges.stderr.length > 0,
    },
  }
}
