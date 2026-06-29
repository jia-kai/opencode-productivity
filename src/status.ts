import type { BackgroundCommandRecord } from "./background.js"
import type { WakeupRecord } from "./scheduler.js"

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

export function sidebarBackgroundStatusCommands(commands: BackgroundStatusSnapshot[], limit = 5): BackgroundStatusSnapshot[] {
  const max = Math.max(0, limit)
  if (max === 0) return []

  const recent = commands.slice().reverse()
  const exited = recent.find((command) => command.status !== "running")
  const runningLimit = exited ? max - 1 : max
  const running = recent.filter((command) => command.status === "running").slice(0, runningLimit)

  return exited && running.length < max ? [...running, exited] : running
}
