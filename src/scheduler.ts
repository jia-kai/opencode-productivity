import { DEFAULTS } from "./config.js"
import { postSessionNote, type DeliveryResult } from "./delivery.js"
import { nowIso, parseRunAt } from "./time.js"
import type { OpenCodeClient } from "./types.js"

export interface ScheduleWakeupArgs {
  name: string
  message: string
  runAt?: string
  delaySeconds?: number
  repeatSeconds?: number
  label?: string
}

export type WakeupStatus = "scheduled" | "fired" | "cancelled" | "failed"

export interface WakeupRecord {
  id: string
  name: string
  sessionID?: string
  message: string
  label?: string
  status: WakeupStatus
  runAt: string
  repeatSeconds?: number
  dueInMs: number
  dueInSeconds: number
  firedCount: number
  createdAt: string
  lastFiredAt?: string
  lastDelivery?: DeliveryResult
}

interface InternalWakeup extends Omit<WakeupRecord, "dueInMs" | "dueInSeconds"> {
  timer?: NodeJS.Timeout
}

export class WakeupScheduler {
  private wakeups = new Map<string, InternalWakeup>()
  private nextID = 1

  constructor(private readonly client?: OpenCodeClient) {}

  schedule(args: ScheduleWakeupArgs, sessionID?: string, now = Date.now()): WakeupRecord {
    if (this.activeCount() >= DEFAULTS.maxActiveWakeups) {
      throw new Error(`maximum active wakeups reached (${DEFAULTS.maxActiveWakeups})`)
    }
    const name = normalizeName(args.name)
    if (this.findByName(name)) throw new Error(`duplicate wakeup name: ${name}`)
    if (!args.message?.trim()) throw new Error("message is required")
    const delaySeconds = args.delaySeconds === 0 && args.runAt ? undefined : args.delaySeconds
    if ((args.runAt ? 1 : 0) + (delaySeconds === undefined ? 0 : 1) !== 1) {
      throw new Error("provide exactly one of runAt or delaySeconds")
    }
    if (delaySeconds !== undefined && delaySeconds < 0) {
      throw new Error("delaySeconds must be non-negative")
    }
    const repeatSeconds = normalizeRepeatSeconds(args.repeatSeconds)
    if (repeatSeconds !== undefined && repeatSeconds < DEFAULTS.minRepeatSeconds) {
      throw new Error(`repeatSeconds must be at least ${DEFAULTS.minRepeatSeconds}`)
    }

    const fireAt = args.runAt ? parseRunAt(args.runAt) : now + Math.round(delaySeconds ?? 0) * 1_000
    const record: InternalWakeup = {
      id: `wakeup-${this.nextID++}`,
      name,
      sessionID,
      message: args.message,
      label: args.label,
      status: "scheduled",
      runAt: nowIso(fireAt),
      repeatSeconds,
      firedCount: 0,
      createdAt: nowIso(now),
    }
    this.arm(record, fireAt)
    this.wakeups.set(record.id, record)
    return this.snapshot(record)
  }

  list(): WakeupRecord[] {
    return [...this.wakeups.values()].map((record) => this.snapshot(record))
  }

  cancel(idOrName: string): WakeupRecord {
    const record = this.resolve(idOrName)
    if (record.timer) clearTimeout(record.timer)
    record.timer = undefined
    record.status = "cancelled"
    return this.snapshot(record)
  }

  async cancelByUser(idOrName: string): Promise<WakeupRecord> {
    const record = this.resolve(idOrName)
    if (record.timer) clearTimeout(record.timer)
    record.timer = undefined
    record.status = "cancelled"
    record.lastDelivery = await postSessionNote(
      this.client,
      record.sessionID,
      `Scheduled wakeup ${record.id} / ${record.name} was cancelled by user: ${record.message}`,
    )
    return this.snapshot(record)
  }

  clear(): number {
    const count = this.wakeups.size
    for (const record of this.wakeups.values()) {
      if (record.timer) clearTimeout(record.timer)
      record.timer = undefined
      if (record.status === "scheduled") record.status = "cancelled"
    }
    this.wakeups.clear()
    return count
  }

  dispose(): void {
    this.clear()
  }

  private activeCount(): number {
    return [...this.wakeups.values()].filter((record) => record.status === "scheduled").length
  }

  private resolve(idOrName: string): InternalWakeup {
    if (!idOrName?.trim()) throw new Error("provide id or name")
    const record = this.wakeups.get(idOrName) ?? this.findByName(idOrName)
    if (!record) throw new Error(`unknown wakeup: ${idOrName}`)
    return record
  }

  private findByName(name: string): InternalWakeup | undefined {
    const normalized = normalizeName(name)
    return [...this.wakeups.values()].find((record) => record.name === normalized)
  }

  private arm(record: InternalWakeup, fireAt: number): void {
    const delay = Math.max(0, fireAt - Date.now())
    record.timer = setTimeout(() => void this.fire(record.id), delay)
    record.timer.unref?.()
  }

  private async fire(id: string): Promise<void> {
    const record = this.wakeups.get(id)
    if (!record || record.status !== "scheduled") return
    record.firedCount += 1
    record.lastFiredAt = nowIso()
    record.lastDelivery = await postSessionNote(
      this.client,
      record.sessionID,
      `Scheduled wakeup${record.label ? ` (${record.label})` : ""}: ${record.message}`,
    )
    if (record.repeatSeconds) {
      const next = Date.now() + record.repeatSeconds * 1_000
      record.runAt = nowIso(next)
      this.arm(record, next)
    } else {
      record.status = record.lastDelivery.ok ? "fired" : "failed"
      record.timer = undefined
    }
  }

  private snapshot(record: InternalWakeup): WakeupRecord {
    const { timer: _timer, ...snapshot } = record
    const dueInMs = record.status === "scheduled" ? Math.max(0, Date.parse(record.runAt) - Date.now()) : 0
    return { ...snapshot, dueInMs, dueInSeconds: Math.round(dueInMs / 100) / 10 }
  }
}

function normalizeName(value: string | undefined): string {
  const name = value?.trim()
  if (!name) throw new Error("name is required")
  if (name.length > 40) throw new Error("name must be 40 characters or fewer")
  return name
}

function normalizeRepeatSeconds(value: number | undefined): number | undefined {
  if (value === undefined || value === 0) return undefined
  return value
}
