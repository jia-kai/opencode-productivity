import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BackgroundCommandRecord } from "./background.js"
import type { WakeupRecord } from "./scheduler.js"
import { productivityRuntimeDirectory } from "./runtime-paths.js"

export type BackgroundStatusSnapshot = Omit<BackgroundCommandRecord, "stdout" | "stderr">

export interface ProductivityStatusSnapshot {
  updatedAt: string
  ipc?: {
    instanceID?: string
    serverPid?: number
    socketPath: string
  }
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

export function writeStatusSnapshot(directory: string, wakeups: WakeupRecord[], commands: BackgroundCommandRecord[], ipc?: ProductivityStatusSnapshot["ipc"]): void {
  const file = statusSnapshotPath(directory)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), ipc, wakeups, commands: commands.map(stripOutput) }, null, 2))
}

export function deleteStatusSnapshot(directory: string): void {
  rmSync(statusSnapshotPath(directory), { force: true })
  removeEmptyRuntimeDirectory(directory)
}

export function readStatusSnapshot(directory: string): ProductivityStatusSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(statusSnapshotPath(directory), "utf8")) as Partial<ProductivityStatusSnapshot>
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      ipc: isIpcSnapshot(parsed.ipc) ? parsed.ipc : undefined,
      wakeups: Array.isArray(parsed.wakeups) ? parsed.wakeups as WakeupRecord[] : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands as BackgroundStatusSnapshot[] : [],
    }
  } catch {
    return { updatedAt: "", wakeups: [], commands: [] }
  }
}

function isIpcSnapshot(value: unknown): value is { socketPath: string } {
  return typeof value === "object" && value !== null && typeof (value as { socketPath?: unknown }).socketPath === "string"
}

function stripOutput(command: BackgroundCommandRecord): BackgroundStatusSnapshot {
  const { stdout: _stdout, stderr: _stderr, ...status } = command
  return status
}

export function statusSnapshotPath(directory: string): string {
  return path.join(productivityRuntimeDirectory(directory), "productivity-state.json")
}

export function legacyStatusSnapshotPath(directory: string): string {
  return path.join(directory, ".opencode", "productivity-state.json")
}

export function deleteLegacyStatusSnapshot(directory: string): void {
  rmSync(legacyStatusSnapshotPath(directory), { force: true })
}

function removeEmptyRuntimeDirectory(directory: string): void {
  try {
    rmSync(productivityRuntimeDirectory(directory), { recursive: false })
  } catch {
    // The directory may still contain the registry or another live file.
  }
}
