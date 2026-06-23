import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BackgroundCommandRecord } from "./background.js"
import type { WakeupRecord } from "./scheduler.js"

export type BackgroundStatusSnapshot = Omit<BackgroundCommandRecord, "stdout" | "stderr">

export interface ProductivityStatusSnapshot {
  updatedAt: string
  wakeups: WakeupRecord[]
  commands: BackgroundStatusSnapshot[]
}

export function detailedStatus(wakeups: WakeupRecord[], commands: BackgroundStatusSnapshot[]): string {
  const wakeupLines = wakeups
    .filter((wakeup) => wakeup.status === "scheduled")
    .slice(0, 5)
    .map((wakeup) => `- ${wakeup.id} ${wakeup.label ?? wakeup.message}: ${wakeup.runAt}`)
  const commandLines = commands
    .slice(-5)
    .reverse()
    .map((command) => `- ${command.id} ${command.status}: ${command.command}`)
  return [
    ...(wakeupLines.length ? [`Wakeup status`, ...wakeupLines] : []),
    ...(commandLines.length ? [`Background status`, ...commandLines] : []),
  ].join("\n")
}

export function writeStatusSnapshot(directory: string, wakeups: WakeupRecord[], commands: BackgroundCommandRecord[]): void {
  const file = statusSnapshotPath(directory)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), wakeups, commands: commands.map(stripOutput) }, null, 2))
}

export function readStatusSnapshot(directory: string): ProductivityStatusSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(statusSnapshotPath(directory), "utf8")) as Partial<ProductivityStatusSnapshot>
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      wakeups: Array.isArray(parsed.wakeups) ? parsed.wakeups as WakeupRecord[] : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands as BackgroundStatusSnapshot[] : [],
    }
  } catch {
    return { updatedAt: "", wakeups: [], commands: [] }
  }
}

function stripOutput(command: BackgroundCommandRecord): BackgroundStatusSnapshot {
  const { stdout: _stdout, stderr: _stderr, ...status } = command
  return status
}

export function statusSnapshotPath(directory: string): string {
  return path.join(directory, ".opencode", "productivity-state.json")
}

export interface ResetRequest {
  requestedAt: string
  reason: string
}

export function writeResetRequest(directory: string, reason: string): void {
  const file = resetRequestPath(directory)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ requestedAt: new Date().toISOString(), reason }, null, 2))
}

export function consumeResetRequest(directory: string): ResetRequest | undefined {
  const file = resetRequestPath(directory)
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ResetRequest>
    unlinkSync(file)
    return {
      requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : "",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    }
  } catch {
    return undefined
  }
}

export function resetRequestPath(directory: string): string {
  return path.join(directory, ".opencode", "productivity-reset.json")
}

export type ProductivityActionType = "cancel-wakeup" | "cancel-background" | "pull-background-output"

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

export function writeActionRequest(directory: string, request: Omit<ProductivityActionRequest, "requestedAt">): void {
  const file = actionRequestPath(directory)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...request, requestedAt: new Date().toISOString() }, null, 2))
}

export function consumeActionRequest(directory: string): ProductivityActionRequest | undefined {
  const file = actionRequestPath(directory)
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProductivityActionRequest>
    unlinkSync(file)
    if (!isAction(parsed.action) || typeof parsed.id !== "string" || typeof parsed.target !== "string") return undefined
    return {
      id: parsed.id,
      requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : "",
      action: parsed.action,
      target: parsed.target,
      stream: isStream(parsed.stream) ? parsed.stream : undefined,
      tail: typeof parsed.tail === "number" ? parsed.tail : undefined,
      limit: typeof parsed.limit === "number" ? parsed.limit : undefined,
    }
  } catch {
    return undefined
  }
}

export function writeActionResponse(directory: string, response: Omit<ProductivityActionResponse, "respondedAt">): void {
  const file = actionResponsePath(directory)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...response, respondedAt: new Date().toISOString() }, null, 2))
}

export function consumeActionResponse(directory: string, id: string): ProductivityActionResponse | undefined {
  const file = actionResponsePath(directory)
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProductivityActionResponse>
    if (parsed.id !== id) return undefined
    unlinkSync(file)
    if (typeof parsed.title !== "string" || typeof parsed.message !== "string") return undefined
    return {
      id,
      respondedAt: typeof parsed.respondedAt === "string" ? parsed.respondedAt : "",
      ok: parsed.ok === true,
      title: parsed.title,
      message: parsed.message,
    }
  } catch {
    return undefined
  }
}

export function actionRequestPath(directory: string): string {
  return path.join(directory, ".opencode", "productivity-action.json")
}

export function actionResponsePath(directory: string): string {
  return path.join(directory, ".opencode", "productivity-action-response.json")
}

function isAction(value: unknown): value is ProductivityActionType {
  return value === "cancel-wakeup" || value === "cancel-background" || value === "pull-background-output"
}

function isStream(value: unknown): value is "stdout" | "stderr" | "both" {
  return value === "stdout" || value === "stderr" || value === "both"
}
