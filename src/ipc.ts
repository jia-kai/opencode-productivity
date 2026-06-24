import { lstatSync, mkdirSync, unlinkSync } from "node:fs"
import net, { type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

export type ProductivityActionType = "cancel-wakeup" | "cancel-background" | "pull-background-output" | "reset"

export interface ProductivityActionRequest {
  id: string
  requestedAt: string
  action: ProductivityActionType
  target: string
  stream?: "stdout" | "stderr" | "both"
  tail?: number
  limit?: number
}

export interface ProductivityActionResponse {
  id: string
  respondedAt: string
  ok: boolean
  title: string
  message: string
}

export interface ProductivityIpcServer {
  socketPath: string
  close(): Promise<void>
}

export type ProductivityActionHandler = (request: ProductivityActionRequest) => Promise<ProductivityActionResponse>

const MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 4_000
const IDLE_SOCKET_TIMEOUT_MS = 5_000

export async function startProductivityIpcServer(directory: string, handler: ProductivityActionHandler): Promise<ProductivityIpcServer> {
  assertUnixSocketSupport()
  const socketPath = productivitySocketPath(directory, process.pid)
  mkdirSync(path.dirname(socketPath), { recursive: true })
  unlinkStaleSocket(socketPath)

  const sockets = new Set<Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let data = ""
    socket.setTimeout(IDLE_SOCKET_TIMEOUT_MS, () => socket.destroy())
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      data += chunk
      if (data.length > MAX_REQUEST_BYTES) {
        socket.end(serializeResponse(errorResponse("", "Productivity Action Too Large", "The TUI action request exceeded the IPC size limit.")))
        return
      }
      const newline = data.indexOf("\n")
      if (newline === -1) return
      const line = data.slice(0, newline)
      void respondToLine(line, socket, handler)
    })
    socket.on("error", () => undefined)
    socket.on("close", () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(socketPath)
  })

  return {
    socketPath,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => {
        unlinkStaleSocket(socketPath)
        resolve()
      })
    }),
  }
}

export async function sendProductivityAction(
  directoryOrSocketPath: string,
  request: Omit<ProductivityActionRequest, "requestedAt">,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProductivityActionResponse> {
  assertUnixSocketSupport()
  const payload: ProductivityActionRequest = { ...request, requestedAt: new Date().toISOString() }
  const socketPath = directoryOrSocketPath.endsWith(".sock") ? directoryOrSocketPath : productivitySocketPath(directoryOrSocketPath)
  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    let response = ""
    let settled = false
    const timeout = setTimeout(() => {
      settle(errorResponse(payload.id, "Productivity Action Timed Out", "The server plugin did not respond to the TUI request."))
    }, timeoutMs)

    const settle = (value: ProductivityActionResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolve(value)
    }

    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on("data", (chunk: string) => {
      response += chunk
      const newline = response.indexOf("\n")
      if (newline === -1) return
      settle(parseResponse(response.slice(0, newline), payload.id))
    })
    socket.on("error", (error: Error) => {
      settle(errorResponse(payload.id, "Productivity Action Unavailable", error.message))
    })
    socket.on("end", () => {
      if (!settled && response.trim()) settle(parseResponse(response.trim(), payload.id))
    })
  })
}

export function productivitySocketPath(directory: string, pid = process.pid): string {
  return path.join(tmpdir(), "opencode-productivity", `${hashPath(directory)}-${pid}.sock`)
}

function assertUnixSocketSupport(): void {
  if (process.platform === "win32") throw new Error("opencode-productivity only supports Unix platforms.")
}

async function respondToLine(line: string, socket: Socket, handler: ProductivityActionHandler): Promise<void> {
  const parsed = parseRequest(line)
  if (!parsed.ok) {
    socket.end(serializeResponse(errorResponse(parsed.id, "Productivity Action Failed", parsed.message)))
    return
  }
  try {
    socket.end(serializeResponse(await handler(parsed.request)))
  } catch (error) {
    socket.end(serializeResponse(errorResponse(parsed.request.id, "Productivity Action Failed", error instanceof Error ? error.message : String(error))))
  }
}

function parseRequest(line: string): { ok: true; request: ProductivityActionRequest } | { ok: false; id: string; message: string } {
  try {
    const parsed = JSON.parse(line) as Partial<ProductivityActionRequest>
    const id = typeof parsed.id === "string" ? parsed.id : ""
    if (!isAction(parsed.action)) return { ok: false, id, message: "Unknown productivity action." }
    if (typeof parsed.id !== "string" || typeof parsed.target !== "string") return { ok: false, id, message: "Malformed productivity action request." }
    return {
      ok: true,
      request: {
        id: parsed.id,
        requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : "",
        action: parsed.action,
        target: parsed.target,
        stream: isStream(parsed.stream) ? parsed.stream : undefined,
        tail: typeof parsed.tail === "number" ? parsed.tail : undefined,
        limit: typeof parsed.limit === "number" ? parsed.limit : undefined,
      },
    }
  } catch (error) {
    return { ok: false, id: "", message: error instanceof Error ? error.message : String(error) }
  }
}

function parseResponse(line: string, fallbackID: string): ProductivityActionResponse {
  try {
    const parsed = JSON.parse(line) as Partial<ProductivityActionResponse>
    if (typeof parsed.title !== "string" || typeof parsed.message !== "string") {
      return errorResponse(fallbackID, "Productivity Action Failed", "Malformed productivity action response.")
    }
    return {
      id: typeof parsed.id === "string" ? parsed.id : fallbackID,
      respondedAt: typeof parsed.respondedAt === "string" ? parsed.respondedAt : "",
      ok: parsed.ok === true,
      title: parsed.title,
      message: parsed.message,
    }
  } catch (error) {
    return errorResponse(fallbackID, "Productivity Action Failed", error instanceof Error ? error.message : String(error))
  }
}

function serializeResponse(response: ProductivityActionResponse): string {
  return `${JSON.stringify(response)}\n`
}

function errorResponse(id: string, title: string, message: string): ProductivityActionResponse {
  return { id, respondedAt: new Date().toISOString(), ok: false, title, message }
}

function unlinkStaleSocket(socketPath: string): void {
  try {
    if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath)
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code !== "ENOENT") throw error
    // Missing sockets are expected during first startup and after clean shutdown.
  }
}

function isAction(value: unknown): value is ProductivityActionType {
  return value === "cancel-wakeup" || value === "cancel-background" || value === "pull-background-output" || value === "reset"
}

function isStream(value: unknown): value is "stdout" | "stderr" | "both" {
  return value === "stdout" || value === "stderr" || value === "both"
}

function hashPath(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
