import { BackgroundManager, type BackgroundCommandRecord } from "./background.js"
import { WakeupScheduler } from "./scheduler.js"
import {
  connectProductivityServerToTui,
  decodeProductivityTuiCommand,
  productivityProjectID,
  type ProductivityActionRequest,
  type ProductivityActionResponse,
  type ProductivityServerIpcClient,
} from "./ipc.js"
import { deleteStatusSnapshot, writeStatusSnapshot } from "./status.js"
import { handleTuiCommand } from "./tui-command.js"
import { localTimeContext } from "./time.js"
import type { PluginContext, ToolContext } from "./types.js"

interface SchemaBuilder {
  string(): SchemaValue
  number(): SchemaValue
}

interface SchemaValue {
  optional(): SchemaValue
  describe(text: string): SchemaValue
}

type ToolFactory = ((definition: unknown) => unknown) & { schema?: SchemaBuilder }

export function createProductivityPlugin(tool: ToolFactory) {
  const schema = tool.schema
  if (!schema) throw new Error("@opencode-ai/plugin tool.schema is required")

  return async function ProductivityPlugin(ctx: PluginContext) {
    const scheduler = new WakeupScheduler(ctx.client)
    const background = new BackgroundManager(ctx.client, ctx.directory)
    const instanceID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const tuiConnections = new Map<string, ProductivityServerIpcClient>()
    const actionHandler = (request: ProductivityActionRequest) => handleActionRequest(request, { scheduler, background, publish })
    const snapshot = () => ({
      instanceID,
      serverPid: process.pid,
      sessions: knownSessions(scheduler.list(), background.list()),
      wakeups: scheduler.list(),
      commands: background.list().map(backgroundStatusView),
    })
    const publish = () => {
      const current = snapshot()
      writeStatusSnapshot(ctx.directory, scheduler.list(), background.list())
      for (const connection of tuiConnections.values()) connection.sendSnapshot(current)
    }
    const publishInterval = setInterval(publish, 1_000)
    publishInterval.unref?.()
    publish()

    return {
      tool: {
        ScheduleWakeup: tool({
          description: "Schedule a one-shot or repeated wakeup for the current OpenCode session. Requires a short unique name, a message, and exactly one of runAt or delaySeconds. Omit delaySeconds when using runAt.",
          args: {
            name: schema.string().describe("Short unique name for this wakeup, 40 characters or fewer"),
            message: schema.string().describe("Message to deliver when the wakeup fires"),
            runAt: schema.string().optional().describe("ISO datetime for the wakeup. Omit delaySeconds when using this."),
            delaySeconds: schema.number().optional().describe("Non-negative delay in seconds from now. Omit this when runAt is provided."),
            repeatSeconds: schema.number().optional().describe("Optional repeat interval in seconds. Omit or use 0 for one-shot; positive repeat intervals must be at least 60."),
            label: schema.string().optional().describe("Optional short label"),
          },
          async execute(args: Record<string, unknown>, context: ToolContext) {
            const result = scheduler.schedule(args as never, context.sessionID)
            publish()
            return toolJson({ currentLocalTime: localTimeContext(), wakeup: result })
          },
        }),
        ListWakeups: tool({
          description: "List scheduled, fired, cancelled, and failed wakeups for this OpenCode process, including current local time for schedule reasoning.",
          args: {},
          async execute() {
            publish()
            return toolJson({ currentLocalTime: localTimeContext(), wakeups: scheduler.list() })
          },
        }),
        CancelWakeup: tool({
          description: "Cancel a wakeup by ID or name. Provide one identifier; name is the short unique name used when scheduling.",
          args: {
            id: schema.string().optional().describe("Wakeup ID"),
            name: schema.string().optional().describe("Wakeup name"),
          },
          async execute(args: { id?: string; name?: string }) {
            const result = scheduler.cancel(args.id ?? args.name ?? "")
            publish()
            return toolJson({ currentLocalTime: localTimeContext(), wakeup: result })
          },
        }),
        RunInBackground: tool({
          description: "Run a non-interactive shell command in the background for the current session. Requires a short unique name and command; stdout/stderr are retained in memory and read with PullBackgroundOutput.",
          args: {
            name: schema.string().describe("Short unique name for this background command, 40 characters or fewer"),
            command: schema.string().describe("Non-empty shell command to run"),
            cwd: schema.string().optional().describe("Working directory; defaults to the current OpenCode project directory"),
            timeoutSeconds: schema.number().optional().describe("Optional positive timeout in seconds; omit or use 0 for no timeout"),
            maxOutputBytes: schema.number().optional().describe("Maximum in-memory stdout/stderr bytes per stream; defaults to and is capped at 1048576, split between head and tail when exceeded"),
          },
          async execute(args: Record<string, unknown>, context: ToolContext) {
            const result = background.run(args as never, context.sessionID)
            publish()
            return toolJson({ command: result })
          },
        }),
        BackgroundStatus: tool({
          description: "Get process metadata for a background command by ID or name, including running/exited status and runtime. Use PullBackgroundOutput to read stdout/stderr text.",
          args: {
            id: schema.string().optional().describe("Background command ID"),
            name: schema.string().optional().describe("Background command name"),
          },
          async execute(args: { id?: string; name?: string }) {
            publish()
            return toolJson({ command: backgroundStatusView(background.get(args.id ?? args.name ?? "")) })
          },
        }),
        PullBackgroundOutput: tool({
          description: "Pull retained in-memory stdout/stderr from a running or completed background command by ID or name. Use lineOffset for forward reads, or tail for the last N lines. When using tail, omit lineOffset. If requested lines were omitted, the response explains the error and available ranges.",
          args: {
            id: schema.string().optional().describe("Background command ID"),
            name: schema.string().optional().describe("Background command name"),
            stream: schema.string().optional().describe("stdout, stderr, or both; defaults to both"),
            lineOffset: schema.number().optional().describe("Non-negative zero-based line offset to start reading from; defaults to 0. Omit this when tail is provided."),
            limit: schema.number().optional().describe("Maximum number of lines to return; defaults to 200 and is capped at 5000"),
            tail: schema.number().optional().describe("Return the last N lines instead of reading from lineOffset; must be non-negative"),
          },
          async execute(args: Record<string, unknown>) {
            publish()
            return toolJson(background.pull(args as never))
          },
        }),
        ListBackgroundCommands: tool({
          description: "List background commands for this OpenCode process, including status, runtime, output availability, and retention metadata but not stdout/stderr text.",
          args: {},
          async execute() {
            publish()
            return toolJson({ commands: background.list().map(backgroundStatusView) })
          },
        }),
        CancelBackgroundCommand: tool({
          description: "Terminate a running background command by ID or name. If the command already finished, this returns its current status unchanged.",
          args: {
            id: schema.string().optional().describe("Background command ID"),
            name: schema.string().optional().describe("Background command name"),
          },
          async execute(args: { id?: string; name?: string }) {
            const result = background.cancel(args.id ?? args.name ?? "")
            publish()
            return toolJson({ command: backgroundStatusView(result) })
          },
        }),
      },
      event: async ({ event }: { event: { type?: string } & Record<string, unknown> }) => {
        if (event.type === "tui.command.execute") {
          const command = extractCommand(event)
          const request = decodeProductivityTuiCommand(command)
          if (request && request.projectID === productivityProjectID(ctx.directory)) {
            connectToTui(request.socketPath)
            return
          }
        }
        if (event.type === "tui.command.execute" || event.type === "command.executed") {
          if (await handleTuiCommand(event, { client: ctx.client, scheduler, background })) publish()
        }
      },
      "tui.command.execute": async (input: unknown) => {
        const request = decodeProductivityTuiCommand(extractCommand(input))
        if (request && request.projectID === productivityProjectID(ctx.directory)) {
          connectToTui(request.socketPath)
          return
        }
        if (await handleTuiCommand(input, { client: ctx.client, scheduler, background })) publish()
      },
      dispose: async () => {
        clearInterval(publishInterval)
        for (const connection of tuiConnections.values()) connection.close()
        tuiConnections.clear()
        scheduler.dispose()
        background.dispose()
        deleteStatusSnapshot(ctx.directory)
      },
    }

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
  }
}

function knownSessions(wakeups: Array<{ sessionID?: string }>, commands: Array<{ sessionID?: string }>): string[] {
  return [...new Set([...wakeups, ...commands].map((item) => item.sessionID).filter((value): value is string => typeof value === "string" && value.length > 0))]
}

function extractCommand(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return undefined
  const item = input as { command?: unknown; properties?: { command?: unknown } }
  return item.command ?? item.properties?.command
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
        message: `Cleared wakeups and background commands for ${request.target || "the current session"}.`,
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

function backgroundStatusView(command: BackgroundCommandRecord): Omit<BackgroundCommandRecord, "stdout" | "stderr"> & {
  outputAvailable: {
    stdout: boolean
    stderr: boolean
  }
} {
  const { stdout, stderr, ...rest } = command
  return {
    ...rest,
    outputAvailable: {
      stdout: rest.outputRanges.stdout.length > 0,
      stderr: rest.outputRanges.stderr.length > 0,
    },
  }
}
