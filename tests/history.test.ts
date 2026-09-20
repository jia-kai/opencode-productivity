import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  dedupePrompts,
  filterPromptHistory,
  fuzzyScore,
  loadPromptHistoryEntries,
  MAX_PROMPT_HISTORY_ENTRIES,
  preparePromptHistoryEntries,
  PromptHistoryIndex,
  rankPromptHistory,
  refreshPromptHistorySnapshot,
  resolveHistoryDbPath,
  scorePromptHistoryMatch,
  searchPromptHistory,
} from "../src/history.js"

test("fuzzyScore uses fzf scoring", () => {
  assert.ok(fuzzyScore("hello", "hello") > fuzzyScore("hello", "h e l l o"))
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

test("rankPromptHistory orders by recency then score and truncates", () => {
  const result = rankPromptHistory(
    [
      { id: "1", prompt: "deploy", createdAt: 1 },
      { id: "2", prompt: "deploy api", createdAt: 2 },
      { id: "3", prompt: "unrelated", createdAt: 3 },
    ],
    "deploy",
    1,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].id, "2")
})

test("filterPromptHistory searches the full index but bounds visible matches", () => {
  const entries = Array.from({ length: 4_096 }, (_, index) => ({
    id: String(index),
    prompt: index === 3_000 ? "unique burst typing target" : `ordinary prompt ${index}`,
    createdAt: index,
  }))
  const initial = filterPromptHistory(entries, "")
  const filtered = filterPromptHistory(entries, "unique target")

  assert.equal(initial.length, 100)
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].id, "3000")
})

test("filterPromptHistory uses recency to break equal fzf scores", () => {
  const result = filterPromptHistory([
    { id: "older-exact", prompt: "deploy", createdAt: 1 },
    { id: "newer-substring", prompt: "please deploy the service", createdAt: 2 },
  ], "deploy")

  assert.deepEqual(result.map((entry) => entry.id), ["newer-substring", "older-exact"])
})

test("scorePromptHistoryMatch ranks substrings above scattered subsequences", () => {
  const text = "please deploy the service"
  const substring = scorePromptHistoryMatch("deploy", text)
  const subsequence = scorePromptHistoryMatch("dploy", text)
  const miss = scorePromptHistoryMatch("zzqq", text)

  assert.equal(substring, 1_000_000)
  assert.ok(subsequence > 0)
  assert.ok(subsequence < substring)
  assert.equal(miss, 0)
})

test("PromptHistoryIndex.fromPrepared reuses precomputed entries without reshuffling", () => {
  const prepared = preparePromptHistoryEntries([
    { id: "old", prompt: "Deploy API", createdAt: 1 },
    { id: "new", prompt: "deploy api", createdAt: 2 },
  ])

  assert.deepEqual(prepared.map((entry) => entry.id), ["new", "old"])
  assert.equal(prepared[0].searchText, "deploy api")

  const index = PromptHistoryIndex.fromPrepared(prepared)
  assert.equal(index.size, 2)
  assert.deepEqual(index.find("deploy").map((match) => match.id), ["new", "old"])
  assert.equal(index.find("")[0].id, "new")
})

test("refreshPromptHistorySnapshot incrementally picks up newer prompts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-history-snapshot-"))
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
    db.prepare("insert into message values (?, 'ses', 1, 1, ?)").run("msg-1", JSON.stringify({ role: "user" }))
    db.prepare("insert into part values (?, 'msg-1', 'ses', 2, 2, ?)").run(
      "part-1",
      JSON.stringify({ type: "text", text: "snapshot cache prompt" }),
    )
  } finally {
    db.close()
  }

  try {
    const first = await refreshPromptHistorySnapshot(dbPath)
    assert.equal(first.items.length, 1)
    assert.equal(first.items[0].prompt, "snapshot cache prompt")
    const second = await refreshPromptHistorySnapshot(dbPath)
    assert.equal(second, first)

    const write = new DatabaseSync(dbPath)
    try {
      write
        .prepare("insert into message values (?, 'ses', 3, 3, ?)")
        .run("msg-2", JSON.stringify({ role: "user" }))
      write
        .prepare("insert into part values (?, 'msg-2', 'ses', 4, 4, ?)")
        .run("part-2", JSON.stringify({ type: "text", text: "brand new follow up prompt" }))
    } finally {
      write.close()
    }
    const third = await refreshPromptHistorySnapshot(dbPath)
    assert.notEqual(third, first)
    assert.equal(third.items.length, 2)
    assert.equal(third.items[0].prompt, "brand new follow up prompt")
    const fourth = await refreshPromptHistorySnapshot(dbPath)
    assert.equal(fourth, third)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("searchPromptHistory excludes machine-generated subagent session prompts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-history-subagent-"))
  const dbPath = path.join(dir, "opencode.db")
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      create table session (id text primary key, parent_id text);
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
      insert into session values ('ses-main', null);
      insert into session values ('ses-sub', 'ses-main');
    `)
    const insertMessage = db.prepare("insert into message values (?, ?, ?, ?, ?)")
    const insertPart = db.prepare("insert into part values (?, ?, ?, ?, ?, ?)")
    insertMessage.run("msg-main", "ses-main", 10, 10, JSON.stringify({ role: "user" }))
    insertPart.run("part-main", "msg-main", "ses-main", 11, 11, JSON.stringify({ type: "text", text: "manually typed main prompt" }))
    insertMessage.run("msg-sub", "ses-sub", 20, 20, JSON.stringify({ role: "user" }))
    insertPart.run("part-sub", "msg-sub", "ses-sub", 21, 21, JSON.stringify({ type: "text", text: "subagent task description noise" }))

    const matches = searchPromptHistory("subagent task description", { dbPath, limit: 10 })
    assert.equal(matches.length, 0)
    const main = searchPromptHistory("manually typed main", { dbPath, limit: 10 })
    assert.equal(main.length, 1)
    assert.equal(main[0].prompt, "manually typed main prompt")
    assert.equal(main[0].id, "msg-main")

    const sinceNewest = loadPromptHistoryEntries(dbPath, 10, 20)
    assert.equal(sinceNewest.length, 0)
    const sinceOlder = loadPromptHistoryEntries(dbPath, 10, 15)
    assert.equal(sinceOlder.length, 1)
    assert.equal(sinceOlder[0].id, "msg-sub")
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
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

test("searchPromptHistory caps results to recent manually entered user messages", () => {
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
      create index part_message_id on part(message_id);
    `)
    const insertMessage = db.prepare("insert into message values (?, 'ses', ?, ?, ?)")
    const insertPart = db.prepare("insert into part values (?, ?, 'ses', ?, ?, ?)")
    for (let index = 0; index < MAX_PROMPT_HISTORY_ENTRIES + 2; index += 1) {
      const id = `manual-${index}`
      insertMessage.run(id, index, index, JSON.stringify({ role: "user" }))
      insertPart.run(`part-${id}`, id, index, index, JSON.stringify({ type: "text", text: `typed prompt ${index}` }))
    }
    insertMessage.run("system", MAX_PROMPT_HISTORY_ENTRIES + 3, MAX_PROMPT_HISTORY_ENTRIES + 3, JSON.stringify({ role: "system" }))
    insertPart.run("part-system", "system", MAX_PROMPT_HISTORY_ENTRIES + 3, MAX_PROMPT_HISTORY_ENTRIES + 3, JSON.stringify({ type: "text", text: "system entry" }))
    insertMessage.run("attachment", MAX_PROMPT_HISTORY_ENTRIES + 4, MAX_PROMPT_HISTORY_ENTRIES + 4, JSON.stringify({ role: "user" }))
    insertPart.run("part-attachment-only", "attachment", MAX_PROMPT_HISTORY_ENTRIES + 4, MAX_PROMPT_HISTORY_ENTRIES + 4, JSON.stringify({ type: "text", synthetic: true, text: "file attachment contents" }))
  } finally {
    db.close()
  }

  try {
    const result = searchPromptHistory("", { dbPath, limit: MAX_PROMPT_HISTORY_ENTRIES + 100 })
    assert.equal(result.length, MAX_PROMPT_HISTORY_ENTRIES)
    assert.equal(result[0].id, `manual-${MAX_PROMPT_HISTORY_ENTRIES + 1}`)
    assert.equal(result.at(-1)?.id, "manual-2")
    assert.equal(result.some((entry) => entry.id === "system" || entry.id === "attachment"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
