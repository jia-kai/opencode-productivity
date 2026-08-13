export interface OpenCodeClient {
  app?: {
    log?: (input: { body: { service: string; level: string; message: string; extra?: unknown } }) => Promise<unknown>
  }
  session?: {
    prompt?: (input: {
      path: { id: string }
      body: { noReply?: boolean; parts: Array<{ type: "text"; text: string; synthetic?: boolean; metadata?: Record<string, unknown> }> }
    }) => Promise<unknown>
    promptAsync?: (input: {
      path: { id: string }
      body: { noReply?: boolean; parts: Array<{ type: "text"; text: string; synthetic?: boolean; metadata?: Record<string, unknown> }> }
    }) => Promise<unknown>
  }
  tui?: {
    appendPrompt?: (input: { body: { text: string } }) => Promise<unknown>
    showToast?: (input: { body: { message: string; variant?: "success" | "error" | "warning" | "info" } }) => Promise<unknown>
  }
}

export interface ToolContext {
  agent?: string
  sessionID?: string
  messageID?: string
  directory: string
  worktree: string
}

export interface PluginContext {
  client?: OpenCodeClient
  directory: string
  worktree: string
}
