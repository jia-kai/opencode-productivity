export interface DeliveryResult {
  ok: boolean
  error?: string
}

export interface SessionDelivery {
  synthetic(input: { sessionID: string; text: string; metadata?: Record<string, string> }): Promise<unknown>
}

export async function postSessionNote(client: SessionDelivery | undefined, sessionID: string | undefined, text: string): Promise<DeliveryResult> {
  if (!client || !sessionID) return { ok: false, error: "session unavailable" }
  try {
    await client.synthetic({ sessionID, text, metadata: { source: "opencode-productivity" } })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
