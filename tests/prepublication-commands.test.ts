import assert from "node:assert/strict";
import { test } from "node:test";

import { openQueryDatabase } from "../src/query-db.ts";
import { searchCommands } from "../src/queries/commands.ts";
import { type FixtureEntry, usage } from "./fixtures.ts";
import { createArchive, userSession } from "./prepublication-support.ts";

function commandSession(count: number): FixtureEntry[] {
  const entries = userSession("fixture-command-contract", []);
  const id = (value: number) => value.toString(16).padStart(8, "0");
  const timestamp = (value: number) => new Date(Date.UTC(2026, 8, 8, 12, 0, value)).toISOString();
  for (let index = 0; index < count; index++) {
    const call = 2 * index + 1;
    entries.push({
      type: "message", id: id(call), parentId: index === 0 ? null : id(call - 1), timestamp: timestamp(call),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command: `printf task-${index}` } }],
        provider: "test-provider", model: "test-model", usage: usage(), stopReason: "toolUse", timestamp: call,
      },
    }, {
      type: "message", id: id(call + 1), parentId: id(call), timestamp: timestamp(call + 1),
      message: {
        role: "toolResult", toolCallId: `call-${index}`, toolName: "bash",
        content: [{ type: "text", text: index === 0 ? `output-0 ${"x".repeat(800)}` : `output-${index}` }],
        isError: index % 2 === 1, timestamp: call + 1,
      },
    });
  }
  entries.push({
    type: "message", id: id(2 * count + 1), parentId: id(2 * count), timestamp: timestamp(2 * count + 1),
    message: {
      role: "assistant", content: [{ type: "toolCall", id: "pending-call", name: "bash", arguments: { command: "pending command" } }],
      provider: "test-provider", model: "test-model", usage: usage(), stopReason: "toolUse", timestamp: 2 * count + 1,
    },
  });
  return entries;
}

test("command matching preserves ordering, GLOB/substring behavior, linked heads and failure states", async (t) => {
  const archive = await createArchive(t, { files: { "commands.jsonl": commandSession(12) } });
  const database = openQueryDatabase(archive.databasePath);
  try {
    const recent = searchCommands(database, { pattern: "TASK-", limit: 3 });
    assert.deepEqual(recent.map((row) => row.command), ["printf task-11", "printf task-10", "printf task-9"]);
    assert.deepEqual(recent.map((row) => row.outputHead), ["output-11", "output-10", "output-9"]);
    assert.deepEqual(recent.map((row) => row.failed), [true, false, true]);
    assert.ok(recent.every((row) => row.citation.includes(row.entryId)));
    assert.deepEqual(searchCommands(database, { pattern: "printf task-[024]", limit: 10 }).map((row) => row.command), ["printf task-4", "printf task-2", "printf task-0"]);
    assert.deepEqual(searchCommands(database, { pattern: "task-", failed: true, limit: 3 }).map((row) => row.command), ["printf task-11", "printf task-9", "printf task-7"]);
    assert.deepEqual(searchCommands(database, { pattern: "task-", cwdGlob: "/not-this-project/*", limit: 3 }), []);
    assert.deepEqual(searchCommands(database, { pattern: "' OR 1=1 --", limit: 3 }), []);
    const long = searchCommands(database, { pattern: "printf task-0", limit: 1 })[0];
    assert.ok(long?.outputHead && long.outputHead.length <= 500);
    assert.ok(long.outputHead.endsWith("…"));
    const missing = searchCommands(database, { pattern: "pending command", limit: 1 })[0];
    assert.ok(missing);
    assert.equal(missing.outputHead, null);
    assert.equal(missing.failed, null);
  } finally {
    database.close();
  }
});

test("command output expansion happens after candidate limiting", async (t) => {
  const archive = await createArchive(t, { files: { "commands.jsonl": commandSession(64) } });
  const database = openQueryDatabase(archive.databasePath);
  try {
    let expanded = 0;
    // A connection-local view observes content evaluation without modifying
    // Atlas SQL or on-disk data. Ascending inserts force a meaningful top-N
    // replacement workload when the requested order is newest-first.
    database.function("observe_output", (content) => {
      expanded++;
      return content;
    });
    database.exec(`CREATE TEMP VIEW text_fts AS
      SELECT observe_output(content) AS content, kind, session_uuid, entry_id, ts
      FROM main.text_fts`);
    const result = searchCommands(database, { pattern: "task-", limit: 3 });
    assert.deepEqual(result.map((row) => row.outputHead), ["output-63", "output-62", "output-61"]);
    assert.equal(expanded, 3, "only the three returned result heads should be materialized");
  } finally {
    database.close();
  }
});
