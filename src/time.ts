export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString()
}

export function localTimeContext(now = Date.now()): {
  now: string
  timezone: string
  epochMs: number
} {
  const date = new Date(now)
  return {
    now: date.toLocaleString(undefined, { timeZoneName: "short" }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    epochMs: now,
  }
}

export function parseRunAt(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new Error("runAt must be a valid ISO datetime")
  }
  return timestamp
}
