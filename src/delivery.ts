import type { OpenCodeClient } from "./types.js"

export interface DeliveryResult {
  ok: boolean
  error?: string
}

export async function postSessionNote(
  client: OpenCodeClient | undefined,
  sessionID: string | undefined,
  text: string,
): Promise<DeliveryResult> {
  if (!client?.session?.prompt || !sessionID) {
    return { ok: false, error: "session prompt API or sessionID unavailable" }
  }
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text }],
      },
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function showToast(
  client: OpenCodeClient | undefined,
  message: string,
  variant: "success" | "error" | "warning" | "info" = "info",
): Promise<void> {
  try {
    await client?.tui?.showToast?.({ body: { message, variant } })
  } catch {
    // TUI notifications are best-effort.
  }
}
