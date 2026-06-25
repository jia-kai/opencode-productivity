import { lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs"
import net, { type Socket } from "node:net"
import path from "node:path"
import { hashProjectPath, productivityRuntimeRoot } from "./runtime-paths.js"
import type { BackgroundStatusSnapshot, ProductivityStatusSnapshot } from "./status.js"
import type { WakeupRecord } from "./scheduler.js"

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

export type ProductivityActionHandler = (request: ProductivityActionRequest) => Promise<ProductivityActionResponse>

export interface ProductivityPeerSnapshot extends ProductivityStatusSnapshot {
  instanceID: string
  serverPid: number
  socketPath?: string
  sessions: string[]
}

export interface ProductivityTuiIpcServer {
  socketPath: string
  peers(): ProductivityPeerSnapshot[]
  send(peer: ProductivityPeerSnapshot, request: Omit<ProductivityActionRequest, "requestedAt">): Promise<ProductivityActionResponse>
  close(): Promise<void>
}

export interface ProductivityServerIpcClient {
  close(): void
  isClosed(): boolean
  sendSnapshot(snapshot: ProductivityServerSnapshot): void
}

export interface ProductivityServerSnapshot {
  instanceID: string
  serverPid: number
  sessions: string[]
  wakeups: WakeupRecord[]
  commands: BackgroundStatusSnapshot[]
}

type ProductivityIpcMessage =
  | { type: "hello"; snapshot: ProductivityServerSnapshot }
  | { type: "snapshot"; snapshot: ProductivityServerSnapshot }
  | { type: "request"; request: ProductivityActionRequest }
  | { type: "response"; response: ProductivityActionResponse }

export const PRODUCTIVITY_TUI_COMMAND_PREFIX = "opencode-productivity.ipc:"

const DEFAULT_TIMEOUT_MS = 4_000
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024

export async function startProductivityTuiIpcServer(directory: string, onUpdate?: () => void): Promise<ProductivityTuiIpcServer> {
  assertUnixSocketSupport()
  cleanupStaleProductivitySockets()
  const socketPath = productivityTuiSocketPath(directory, process.pid, Date.now().toString(36))
  mkdirSync(path.dirname(socketPath), { recursive: true })
  unlinkStaleSocket(socketPath)

  type Peer = {
    socket: Socket
    closed: boolean
    snapshot?: ProductivityPeerSnapshot
    pending: Map<string, (response: ProductivityActionResponse) => void>
  }
  const peers = new Set<Peer>()

  const updatePeer = (peer: Peer, snapshot: ProductivityServerSnapshot) => {
    peer.snapshot = {
      updatedAt: new Date().toISOString(),
      instanceID: snapshot.instanceID,
      serverPid: snapshot.serverPid,
      sessions: snapshot.sessions,
      wakeups: snapshot.wakeups,
      commands: snapshot.commands,
    }
    onUpdate?.()
  }

  const server = net.createServer((socket) => {
    const peer: Peer = { socket, closed: false, pending: new Map() }
    peers.add(peer)
    let data = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      data += chunk
      if (data.length > MAX_MESSAGE_BYTES) {
        socket.destroy()
        return
      }
      while (true) {
        const newline = data.indexOf("\n")
        if (newline === -1) return
        const line = data.slice(0, newline)
        data = data.slice(newline + 1)
        const message = parseMessage(line)
        if (!message) continue
        if (message.type === "hello" || message.type === "snapshot") updatePeer(peer, message.snapshot)
        if (message.type === "response") {
          const resolve = peer.pending.get(message.response.id)
          if (resolve) {
            peer.pending.delete(message.response.id)
            resolve(message.response)
          }
        }
      }
    })
    socket.on("error", () => undefined)
    socket.on("close", () => {
      peer.closed = true
      peers.delete(peer)
      for (const [id, resolve] of peer.pending) {
        resolve(errorResponse(id, "Productivity Action Unavailable", "The productivity server disconnected."))
      }
      peer.pending.clear()
      onUpdate?.()
    })
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
    peers() {
      return [...peers].flatMap((peer) => peer.snapshot ? [peer.snapshot] : [])
    },
    async send(snapshot, request) {
      const peer = [...peers].find((item) => item.snapshot?.instanceID === snapshot.instanceID)
      if (!peer || peer.closed) return errorResponse(request.id, "Productivity Action Unavailable", "The selected productivity server is not connected.")
      const payload: ProductivityActionRequest = { ...request, requestedAt: new Date().toISOString() }
      return await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          peer.pending.delete(payload.id)
          resolve(errorResponse(payload.id, "Productivity Action Timed Out", "The server plugin did not respond to the TUI request."))
        }, DEFAULT_TIMEOUT_MS)
        peer.pending.set(payload.id, (response) => {
          clearTimeout(timeout)
          resolve(response)
        })
        peer.socket.write(serializeMessage({ type: "request", request: payload }))
      })
    },
    close: () => new Promise((resolve) => {
      for (const peer of peers) peer.socket.destroy()
      server.close(() => {
        unlinkStaleSocket(socketPath)
        resolve()
      })
    }),
  }
}

export function connectProductivityServerToTui(socketPath: string, snapshot: ProductivityServerSnapshot, handler: ProductivityActionHandler, onClose?: () => void): ProductivityServerIpcClient {
  assertUnixSocketSupport()
  const socket = net.createConnection(socketPath)
  let connected = false
  let closed = false
  let data = ""
  let latest = snapshot
  const send = (message: ProductivityIpcMessage) => {
    if (!connected || closed) return
    socket.write(serializeMessage(message))
  }
  socket.setEncoding("utf8")
  socket.on("connect", () => {
    connected = true
    send({ type: "hello", snapshot: latest })
  })
  socket.on("data", (chunk: string) => {
    data += chunk
    if (data.length > MAX_MESSAGE_BYTES) {
      socket.destroy()
      return
    }
    while (true) {
      const newline = data.indexOf("\n")
      if (newline === -1) return
      const line = data.slice(0, newline)
      data = data.slice(newline + 1)
      const message = parseMessage(line)
      if (message?.type === "request") {
        void handler(message.request).then((response) => send({ type: "response", response }))
      }
    }
  })
  socket.on("error", () => undefined)
  socket.on("close", () => {
    closed = true
    onClose?.()
  })

  return {
    close() {
      closed = true
      socket.destroy()
    },
    isClosed() {
      return closed
    },
    sendSnapshot(snapshot) {
      latest = snapshot
      send({ type: "snapshot", snapshot })
    },
  }
}

export function productivityTuiSocketPath(directory: string, pid = process.pid, nonce = "tui"): string {
  return path.join(productivityRuntimeRoot(), `${hashProjectPath(directory)}-tui-${pid}-${nonce}.sock`)
}

export function productivityProjectID(directory: string): string {
  return hashProjectPath(directory)
}

export function encodeProductivityTuiCommand(payload: { op: "connect"; projectID: string; socketPath: string; sessionID?: string }): string {
  return `${PRODUCTIVITY_TUI_COMMAND_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`
}

export function decodeProductivityTuiCommand(command: unknown): { op: "connect"; projectID: string; socketPath: string; sessionID?: string } | undefined {
  if (typeof command !== "string" || !command.startsWith(PRODUCTIVITY_TUI_COMMAND_PREFIX)) return undefined
  try {
    const parsed = JSON.parse(decodeURIComponent(command.slice(PRODUCTIVITY_TUI_COMMAND_PREFIX.length))) as Partial<{ op: string; projectID: string; socketPath: string; sessionID: string }>
    if (parsed.op !== "connect" || typeof parsed.projectID !== "string" || typeof parsed.socketPath !== "string") return undefined
    return {
      op: "connect",
      projectID: parsed.projectID,
      socketPath: parsed.socketPath,
      sessionID: typeof parsed.sessionID === "string" ? parsed.sessionID : undefined,
    }
  } catch {
    return undefined
  }
}

export function cleanupStaleProductivitySockets(): void {
  try {
    for (const entry of readdirSync(productivityRuntimeRoot(), { withFileTypes: true })) {
      if (!entry.isSocket() && !entry.isFile()) continue
      const match = /^.+-tui-(\d+)-.+\.sock$/.exec(entry.name)
      if (!match) continue
      const pid = Number(match[1])
      const socketPath = path.join(productivityRuntimeRoot(), entry.name)
      if (!Number.isSafeInteger(pid) || !processExists(pid)) unlinkStaleSocket(socketPath)
    }
  } catch {
    // Missing or unreadable runtime directories are harmless.
  }
}

function assertUnixSocketSupport(): void {
  if (process.platform === "win32") throw new Error("opencode-productivity only supports Unix platforms.")
}

function serializeMessage(message: ProductivityIpcMessage): string {
  return `${JSON.stringify(message)}\n`
}

function parseMessage(line: string): ProductivityIpcMessage | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<ProductivityIpcMessage>
    if ((parsed.type === "hello" || parsed.type === "snapshot") && isServerSnapshot(parsed.snapshot)) return parsed as ProductivityIpcMessage
    if (parsed.type === "request" && isActionRequest(parsed.request)) return parsed as ProductivityIpcMessage
    if (parsed.type === "response" && isActionResponse(parsed.response)) return parsed as ProductivityIpcMessage
    return undefined
  } catch {
    return undefined
  }
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EPERM"
  }
}

function isAction(value: unknown): value is ProductivityActionType {
  return value === "cancel-wakeup" || value === "cancel-background" || value === "pull-background-output" || value === "reset"
}

function isActionRequest(value: unknown): value is ProductivityActionRequest {
  if (typeof value !== "object" || value === null) return false
  const item = value as Partial<ProductivityActionRequest>
  return typeof item.id === "string" && typeof item.target === "string" && isAction(item.action)
}

function isActionResponse(value: unknown): value is ProductivityActionResponse {
  if (typeof value !== "object" || value === null) return false
  const item = value as Partial<ProductivityActionResponse>
  return typeof item.id === "string" && typeof item.title === "string" && typeof item.message === "string" && typeof item.ok === "boolean"
}

function isServerSnapshot(value: unknown): value is ProductivityServerSnapshot {
  if (typeof value !== "object" || value === null) return false
  const item = value as Partial<ProductivityServerSnapshot>
  return typeof item.instanceID === "string"
    && typeof item.serverPid === "number"
    && Array.isArray(item.sessions)
    && Array.isArray(item.wakeups)
    && Array.isArray(item.commands)
}
