import type { OpenCodeClient } from "./types.js"

export interface DeliveryResult {
  ok: boolean
  error?: string
}

type SessionPromptInput = {
  path: { id: string }
  body: { parts: Array<{ type: "text"; text: string; synthetic: true; metadata: { source: string } }> }
}

export async function postSessionNote(
  client: OpenCodeClient | undefined,
  sessionID: string | undefined,
  text: string,
): Promise<DeliveryResult> {
  const session = client?.session
  if ((!session?.promptAsync && !session?.prompt) || !sessionID) {
    return { ok: false, error: "session prompt API or sessionID unavailable" }
  }
  try {
    const input: SessionPromptInput = {
      path: { id: sessionID },
      body: {
        parts: [{
          type: "text",
          text,
          synthetic: true,
          metadata: { source: "opencode-productivity" },
        }],
      },
    }
    if (session.promptAsync) {
      await session.promptAsync(input)
    } else {
      await session.prompt?.(input)
    }
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
