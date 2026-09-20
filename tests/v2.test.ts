import assert from "node:assert/strict"
import { test } from "node:test"
import { setup, createV2ClientAdapter } from "../src/v2.js"
import v2Plugin from "../src/index.js"
import serverPlugin from "../src/server.js"
import tuiPlugin from "../src/tui.js"
import { productivityToolJsonSchema } from "../src/plugin.js"
import type { ToolContext } from "../src/types.js"

interface AddedTool {
  name: string
  description: string
  input: unknown
  options: unknown
  execute(input: Record<string, unknown>, context: ToolContext): Promise<{ content: string }>
}

const TOOL_NAMES = [
  "ScheduleWakeup",
  "ListWakeups",
  "CancelWakeup",
  "RunInBackground",
  "BackgroundStatus",
  "PullBackgroundOutput",
  "ListBackgroundCommands",
  "CancelBackgroundCommand",
]

test("v2 server setup registers all productivity tools via tool.transform", async () => {
  const added: AddedTool[] = []
  const cleanup = await setup(createFakeV2Context(added))
  assert.equal(added.length, TOOL_NAMES.length)
  assert.deepEqual(added.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort())
  assert.equal(typeof cleanup, "function")
  await (cleanup as () => Promise<void>)()
})

test("v2 tool definitions expose JSON Schema inputs", () => {
  const schedule = productivityToolJsonSchema("ScheduleWakeup") as {
    type: string
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
  assert.equal(schedule.type, "object")
  assert.equal(schedule.properties.name.type, "string")
  assert.deepEqual(schedule.required, ["name", "message"])
  const cancel = productivityToolJsonSchema("CancelWakeup") as { required: string[] }
  assert.deepEqual(cancel.required, [])
})

test("v2 ScheduleWakeup execute uses the tool context session", async () => {
  const added: AddedTool[] = []
  const cleanup = await setup(createFakeV2Context(added))
  const schedule = added.find((tool) => tool.name === "ScheduleWakeup")
  assert.ok(schedule)
  const result = await schedule.execute(
    { name: "demo", message: "hello", delaySeconds: 3600 },
    { sessionID: "ses_demo", agent: "build", messageID: "msg_demo", directory: "/tmp", worktree: "/tmp" },
  )
  const parsed = JSON.parse(result.content) as { wakeup: { name: string; sessionID: string } }
  assert.equal(parsed.wakeup.name, "demo")
  assert.equal(parsed.wakeup.sessionID, "ses_demo")
  await (cleanup as () => Promise<void>)()
})

test("v2 client adapter maps session prompts to synthetic messages", async () => {
  const synthetic: Array<{ sessionID: string; text: string }> = []
  const client = createV2ClientAdapter({
    session: {
      synthetic: async (input) => {
        synthetic.push(input)
      },
    },
  })
  await client.session!.prompt!({
    path: { id: "ses_target" },
    body: { parts: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] },
  } as never)
  assert.deepEqual(synthetic, [{ sessionID: "ses_target", text: "line one\nline two" }])
})

test("hybrid default exports expose both v1 and v2 loader entrypoints", () => {
  assert.equal(typeof v2Plugin, "object")
  assert.equal((v2Plugin as { id: string }).id, "opencode-productivity")
  assert.equal(typeof (v2Plugin as { setup: unknown }).setup, "function")
  assert.equal(typeof serverPlugin, "function")
  assert.equal(typeof tuiPlugin, "object")
  assert.equal((tuiPlugin as { id: string }).id, "opencode-productivity-history")
  assert.equal(typeof (tuiPlugin as { setup: unknown }).setup, "function")
  assert.equal(typeof (tuiPlugin as { tui: unknown }).tui, "function")
})

function createFakeV2Context(added: AddedTool[]) {
  return {
    location: { directory: "/tmp/opencode-productivity-v2-test" },
    tool: {
      transform: async (editorFactory: (editor: { add(definition: AddedTool): void }) => void) => {
        editorFactory({ add: (definition) => added.push(definition) })
      },
    },
    session: {
      synthetic: async () => {},
    },
  } as never
}
