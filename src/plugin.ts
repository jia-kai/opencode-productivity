import { BackgroundManager, type BackgroundCommandRecord } from "./background.js"
import { WakeupScheduler } from "./scheduler.js"
import { startProductivityIpcServer, type ProductivityActionRequest, type ProductivityActionResponse } from "./ipc.js"
import { createProductivityRegistry } from "./registry.js"
import { writeStatusSnapshot } from "./status.js"
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
    const registry = createProductivityRegistry(ctx.directory)
    const instanceID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    let ipcSocketPath = ""
    const publish = () => {
      const wakeups = scheduler.list()
      const commands = background.list()
      const ipc = ipcSocketPath ? { instanceID, serverPid: process.pid, socketPath: ipcSocketPath } : undefined
      writeStatusSnapshot(ctx.directory, wakeups, commands, ipc)
      if (ipcSocketPath) {
        registry.write({
          instanceID,
          serverPid: process.pid,
          socketPath: ipcSocketPath,
          ipc,
          sessions: knownSessions(wakeups, commands),
          wakeups,
          commands,
        })
      }
    }
    const publishInterval = setInterval(publish, 1_000)
    publishInterval.unref?.()
    const ipc = await startProductivityIpcServer(ctx.directory, (request) => handleActionRequest(request, { scheduler, background, publish }))
    ipcSocketPath = ipc.socketPath
    publish()

    return {
      tool: {
        ScheduleWakeup: tool({
          description: "Schedule a one-shot or repeated wakeup for the current OpenCode session. Requires a short unique name.",
          args: {
            name: schema.string().describe("Short unique name for this wakeup, 40 characters or fewer"),
            message: schema.string().describe("Message to deliver when the wakeup fires"),
            runAt: schema.string().optional().describe("ISO datetime for the wakeup"),
            delaySeconds: schema.number().optional().describe("Delay in seconds from now"),
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
          description: "List scheduled, fired, cancelled, and failed wakeups for this OpenCode process.",
          args: {},
          async execute() {
            publish()
            return toolJson({ currentLocalTime: localTimeContext(), wakeups: scheduler.list() })
          },
        }),
        CancelWakeup: tool({
          description: "Cancel a scheduled wakeup by ID or name.",
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
          description: "Run a non-interactive shell command in the background for the current session. Requires a short unique name.",
          args: {
            name: schema.string().describe("Short unique name for this background command, 40 characters or fewer"),
            command: schema.string().describe("Shell command to run"),
            cwd: schema.string().optional().describe("Working directory"),
            timeoutSeconds: schema.number().optional().describe("Optional timeout in seconds"),
            maxOutputBytes: schema.number().optional().describe("Maximum in-memory stdout/stderr bytes per stream; capped at 1048576 and split between head and tail"),
          },
          async execute(args: Record<string, unknown>, context: ToolContext) {
            const result = background.run(args as never, context.sessionID)
            publish()
            return toolJson({ command: result })
          },
        }),
        BackgroundStatus: tool({
          description: "Get process metadata for a background command, including running/exited status and runtime. Use PullBackgroundOutput to read stdout/stderr.",
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
          description: "Pull retained in-memory stdout/stderr from a running or completed background command by line offset, line limit, or tail count. If requested lines were omitted, the response explains the error and available ranges.",
          args: {
            id: schema.string().optional().describe("Background command ID"),
            name: schema.string().optional().describe("Background command name"),
            stream: schema.string().optional().describe("stdout, stderr, or both; defaults to both"),
            lineOffset: schema.number().optional().describe("Zero-based line offset to start reading from"),
            limit: schema.number().optional().describe("Maximum number of lines to return; default 200, max 5000"),
            tail: schema.number().optional().describe("Return the last N lines instead of reading from lineOffset"),
          },
          async execute(args: Record<string, unknown>) {
            publish()
            return toolJson(background.pull(args as never))
          },
        }),
        ListBackgroundCommands: tool({
          description: "List background commands for this OpenCode process.",
          args: {},
          async execute() {
            publish()
            return toolJson({ commands: background.list().map(backgroundStatusView) })
          },
        }),
        CancelBackgroundCommand: tool({
          description: "Terminate a running background command by ID or name.",
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
        if (event.type === "tui.command.execute" || event.type === "command.executed") {
          if (await handleTuiCommand(event, { client: ctx.client, scheduler, background })) publish()
        }
      },
      "tui.command.execute": async (input: unknown) => {
        if (await handleTuiCommand(input, { client: ctx.client, scheduler, background })) publish()
      },
      dispose: async () => {
        clearInterval(publishInterval)
        await ipc.close()
        ipcSocketPath = ""
        scheduler.dispose()
        background.dispose()
        registry.remove(instanceID)
        publish()
      },
    }
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
