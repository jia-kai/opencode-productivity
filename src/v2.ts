import type { Plugin } from "@opencode/plugin"
import {
  createProductivityState,
  createProductivityToolDefinitions,
  productivityToolJsonSchema,
} from "./plugin.js"
import type { OpenCodeClient, ToolContext } from "./types.js"

/**
 * Adapts the OpenCode v2 plugin context to the version-agnostic OpenCodeClient
 * surface used by the scheduler and background manager. Wakeup and completion
 * notes become v2 synthetic session messages; TUI toasts do not exist in v2 and
 * are omitted (the v2 TUI plugin renders live state instead).
 */
export function createV2ClientAdapter(ctx: {
  session: { synthetic(input: { sessionID: string; text: string }): Promise<unknown> }
}): OpenCodeClient {
  return {
    session: {
      prompt: async (input: { path: { id: string }; body: { parts: Array<{ text?: string }> } }) => {
        const sessionID = input.path.id
        const text = input.body.parts
          .map((part) => part.text)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .join("\n")
        await ctx.session.synthetic({ sessionID, text })
      },
    },
  }
}

export const setup: Plugin.Plugin["setup"] = async (ctx) => {
  const directory = ctx.location.directory
  const client = createV2ClientAdapter(ctx)
  const state = createProductivityState(client, directory)
  const definitions = createProductivityToolDefinitions(undefined, state)

  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(definitions)) {
      editor.add({
        name,
        description: definition.description,
        input: productivityToolJsonSchema(name),
        options: { codemode: false },
        execute: async (input, toolContext) => {
          const result = await definition.execute(input as Record<string, unknown>, {
            sessionID: toolContext.sessionID,
            agent: toolContext.agent,
            messageID: toolContext.messageID,
            directory,
            worktree: directory,
          })
          return { content: result }
        },
      })
    }
  })

  return () => state.dispose()
}
