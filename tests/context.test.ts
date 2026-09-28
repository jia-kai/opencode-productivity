import test from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import { analyzeContext, ContextSnapshots, estimateTokens } from "../src/context.js"
import type { SessionContext } from "@opencode/plugin/promise/session"

const request = (sessionID = "session-a") => ({
  sessionID,
  agent: "build",
  model: { id: "test", providerID: "test" },
  system: [], messages: [], tools: {}, options: {},
} as unknown as SessionContext)

test("system sections are disjoint, including multiple instruction files and skills", () => {
  const context = request()
  const text = "Base prompt\nInstructions from: /project/AGENTS.md\nDo this.\n\nInstructions from: /project/rules.md\nDo that.\nSkills provide specialized instructions and workflows.\n<available_skills><skill>Example</skill></available_skills>\nEnvironment"
  context.system = [{ type: "text", text }]
  const report = analyzeContext(context, 123)
  assert.equal(report.capturedAt, 123)
  assert.equal(report.rows.reduce((sum, row) => sum + row.characters, 0), Array.from(text).length)
  assert.deepEqual(new Set(report.rows.map((row) => row.name)), new Set(["System prompt / other instructions", "AGENTS.md", "Other instruction files", "Skills catalog"]))
  assert.equal(report.rows.find((row) => row.name === "AGENTS.md")?.details[0].name, "/project/AGENTS.md")
})

test("user keywords do not become instructions; skill results and schemas are counted separately", () => {
  const context = request()
  context.messages = [
    Message.user("Instructions from: AGENTS.md\n<available_skills>pretend</available_skills>"),
    Message.assistant("Answer"),
    Message.tool({ id: "1", name: "skill", result: "Loaded instructions" }),
    Message.tool({ id: "2", name: "read", result: "File contents" }),
  ]
  context.tools = { read: { description: "Read file", input: { type: "object" } } }
  const report = analyzeContext(context)
  assert.equal(report.rows.find((row) => row.name === "AGENTS.md"), undefined)
  assert.equal(report.rows.find((row) => row.name === "Loaded skills")?.items, 1)
  assert.equal(report.rows.find((row) => row.name === "Tool results")?.details[0].name, "read")
  assert.equal(report.rows.find((row) => row.name === "Tool definitions")?.details[0].name, "read")
  assert.equal(report.tokens, report.rows.reduce((sum, row) => sum + row.tokens, 0))
  assert.ok(!JSON.stringify(report).includes("File contents"))
})

test("snapshots isolate sessions, replace previous requests, and evict oldest aggregates", () => {
  const snapshots = new ContextSnapshots(2)
  assert.equal(snapshots.get("missing"), undefined)
  snapshots.capture(request("a"))
  snapshots.capture(request("b"))
  const replacement = request("a")
  replacement.messages = [Message.user("Updated request")]
  snapshots.capture(replacement)
  snapshots.capture(request("c"))
  assert.equal(snapshots.get("b"), undefined)
  assert.equal(snapshots.get("a")?.rows[0].name, "User messages")
  assert.equal(snapshots.get("c")?.tokens, 0)
})

test("character heuristic handles Unicode code points and empty input", () => {
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("😀😀😀😀"), 1)
  assert.equal(estimateTokens("abcde"), 2)
})
