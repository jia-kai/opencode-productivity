import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { dedupePrompts, fuzzyScore, rankPromptHistory, resolveHistoryDbPath, searchPromptHistory } from "../src/history.js"

test("fuzzyScore prefers exact and substring matches", () => {
  assert.ok(fuzzyScore("hello", "hello") > fuzzyScore("hello", "say hello"))
  assert.ok(fuzzyScore("hlo", "hello") > 0)
  assert.equal(fuzzyScore("xyz", "hello"), 0)
})

test("dedupePrompts keeps most recent normalized prompt", () => {
  const result = dedupePrompts([
    { id: "old", prompt: "run   tests", createdAt: 1 },
    { id: "new", prompt: "run tests", createdAt: 2 },
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "new")
})

test("rankPromptHistory orders by score then recency and truncates", () => {
  const result = rankPromptHistory(
    [
      { id: "1", prompt: "deploy app", createdAt: 1 },
      { id: "2", prompt: "deploy api", createdAt: 2 },
      { id: "3", prompt: "unrelated", createdAt: 3 },
    ],
    "deploy",
    1,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "2")
})

test("resolveHistoryDbPath honors explicit env override", () => {
  assert.equal(resolveHistoryDbPath({ OPENCODE_HISTORY_DB: "/tmp/history.db" }), "/tmp/history.db")
})

test("resolveHistoryDbPath uses OpenCode data directory by default", () => {
  assert.equal(
    resolveHistoryDbPath({ XDG_DATA_HOME: "/tmp/xdg-data" }),
    path.join("/tmp/xdg-data", "opencode", "opencode.db"),
  )
})

test("searchPromptHistory reads current OpenCode message/part schema", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-history-"))
  const dbPath = path.join(dir, "opencode.db")
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
      create table part (
        id text primary key,
        message_id text not null,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
    `)
    db.prepare("insert into message values (?, ?, ?, ?, ?)").run(
      "msg-user",
      "ses",
      20,
      20,
      JSON.stringify({ role: "user" }),
    )
    db.prepare("insert into part values (?, ?, ?, ?, ?, ?)").run(
      "part-user",
      "msg-user",
      "ses",
      21,
      21,
      JSON.stringify({ type: "text", text: "searchable current schema prompt" }),
    )
    db.prepare("insert into message values (?, ?, ?, ?, ?)").run(
      "msg-assistant",
      "ses",
      30,
      30,
      JSON.stringify({ role: "assistant" }),
    )
    db.prepare("insert into part values (?, ?, ?, ?, ?, ?)").run(
      "part-assistant",
      "msg-assistant",
      "ses",
      31,
      31,
      JSON.stringify({ type: "text", text: "assistant text should not appear" }),
    )
  } finally {
    db.close()
  }

  try {
    const result = searchPromptHistory("current schema", { dbPath, limit: 10 })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, "msg-user")
    assert.equal(result[0].prompt, "searchable current schema prompt")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("searchPromptHistory ignores synthetic attachment expansion parts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-history-"))
  const dbPath = path.join(dir, "opencode.db")
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
      create table part (
        id text primary key,
        message_id text not null,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
    `)
    db.prepare("insert into message values (?, ?, ?, ?, ?)").run(
      "msg-attachment",
      "ses",
      20,
      20,
      JSON.stringify({ role: "user" }),
    )
    db.prepare("insert into part values (?, ?, ?, ?, ?, ?)").run(
      "part-prompt",
      "msg-attachment",
      "ses",
      21,
      21,
      JSON.stringify({ type: "text", text: "Implement @task_plan.md " }),
    )
    db.prepare("insert into part values (?, ?, ?, ?, ?, ?)").run(
      "part-read",
      "msg-attachment",
      "ses",
      22,
      22,
      JSON.stringify({ type: "text", synthetic: true, text: "Called the Read tool with task_plan.md" }),
    )
    db.prepare("insert into part values (?, ?, ?, ?, ?, ?)").run(
      "part-file",
      "msg-attachment",
      "ses",
      23,
      23,
      JSON.stringify({ type: "text", synthetic: true, text: "<content>\nfile body should not be history prompt\n</content>" }),
    )
    db.prepare("insert into part values (?, ?, ?, ?, ?, ?)").run(
      "part-attachment",
      "msg-attachment",
      "ses",
      24,
      24,
      JSON.stringify({
        type: "file",
        filename: "task_plan.md",
        source: { type: "file", path: "task_plan.md", text: { value: "@task_plan.md", start: 10, end: 23 } },
      }),
    )
  } finally {
    db.close()
  }

  try {
    const result = searchPromptHistory("task_plan", { dbPath, limit: 10 })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, "msg-attachment")
    assert.equal(result[0].prompt, "Implement @task_plan.md ")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
