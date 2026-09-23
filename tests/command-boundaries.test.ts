import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { citationFor, openQueryDatabase, truncateDisplay } from "../src/query-db.ts";
import { searchCommands, type CommandSearchOptions } from "../src/queries/commands.ts";
import { sessionFromRow } from "../src/queries/helpers.ts";
import { type FixtureEntry, usage } from "./fixtures.ts";
import { createArchive, envelope, errorEnvelope, fingerprint, userSession } from "./prepublication-support.ts";

function fixture(uuid: string, tied = false): FixtureEntry[] {
  const entries = userSession(uuid, []);
  // Reverse insertion order deliberately differs from the new final ID tie-break.
  for (const [index, id] of ["bbbbbbbb", "aaaaaaaa", "cccccccc"].entries()) {
    const timestamp = tied ? "2026-09-08T12:00:00.000Z" : `2026-09-0${index + 7}T12:00:00.000Z`;
    entries.push({ type: "message", id, parentId: null, timestamp, message: {
      role: "assistant", content: [0, 1].map((seq) => ({ type: "toolCall", id: `${id}-${seq}`, name: "bash", arguments: { command: `printf task-${index}-${seq}` } })),
      provider: "test-provider", model: "test-model", usage: usage(), stopReason: "toolUse",
    } });
    for (const seq of [0, 1]) {
      if (index === 2 && seq === 1) continue;
      entries.push({ type: "message", id: `${id}-${seq}-result`, parentId: id,
        // Result time is deliberately outside the invocation's date window.
        timestamp: "2026-09-10T23:59:59.999Z", message: { role: "toolResult", toolCallId: `${id}-${seq}`, toolName: "bash", isError: seq === 1,
          content: [{ type: "text", text: `head-${index}-${seq}` }, { type: "text", text: `second-${index}-${seq} ${"x".repeat(800)}` }],
        },
      });
    }
  }
  entries.push({ type: "message", id: "dddddddd", parentId: null, timestamp: "2026-09-08T23:59:59.999Z",
    message: { role: "bashExecution", command: "printf bash-session-task", output: "standalone output", exitCode: 0 },
  });
  return entries;
}

// Deliberately expansion-first reference query: the old query shape, with
// the approved date predicates and total-order suffix made explicit.
function reference(database: DatabaseSync, options: CommandSearchOptions) {
  const conditions = ["tc.command IS NOT NULL", /[*?\[]/.test(options.pattern) ? "tc.command GLOB ?" : "instr(lower(tc.command), lower(?)) > 0"];
  const parameters: (string | number)[] = [options.pattern];
  if (options.failed) conditions.push("tc.exit_error = 1");
  if (options.cwdGlob) { conditions.push("s.cwd GLOB ?"); parameters.push(options.cwdGlob); }
  if (options.since) { conditions.push("e.ts >= ?"); parameters.push(options.since); }
  if (options.until) { conditions.push("e.ts <= ?"); parameters.push(options.until); }
  parameters.push(options.limit);
  const rows = database.prepare(`SELECT tc.entry_id, tc.command, tc.exit_error, e.ts,
      s.uuid, s.file, s.cwd, s.name, s.first_user_text, s.created, s.last_activity,
      (SELECT group_concat(content, char(10)) FROM text_fts WHERE session_uuid = tc.session_uuid
       AND entry_id = tc.result_entry_id AND kind = 'tool_head') AS output_head
    FROM tool_calls tc JOIN entries e ON e.session_uuid = tc.session_uuid AND e.id = tc.entry_id
    JOIN sessions s ON s.uuid = tc.session_uuid WHERE ${conditions.join(" AND ")}
    ORDER BY e.ts DESC, s.uuid, tc.seq, tc.entry_id, tc.source LIMIT ?`).all(...parameters) as Array<Record<string, string | number | null>>;
  return rows.map((row) => ({ sessionUuid: String(row.uuid), sessionName: row.name === null ? null : String(row.name), cwd: String(row.cwd),
    entryId: String(row.entry_id), timestamp: String(row.ts), command: String(row.command), failed: row.exit_error === null ? null : Number(row.exit_error) === 1,
    outputHead: row.output_head === null ? null : truncateDisplay(String(row.output_head), 500), citation: citationFor(sessionFromRow(row), String(row.entry_id)),
  }));
}

test("command date filters use inclusive invocation time, not result time, and compose with existing filters", async (t) => {
  const archive = await createArchive(t, { files: { "commands.jsonl": fixture("fixture-dates") } });
  for (const [flags, commands] of [
    [["--since", "2026-09-08", "--until", "2026-09-08"], ["printf bash-session-task", "printf task-1-0", "printf task-1-1"]],
    [["--since", "2026-09-08", "--until", "2026-09-08", "--failed"], ["printf task-1-1"]],
    [["--since", "2026-09-08T14:00:00+02:00", "--until", "2026-09-08T14:00:00+02:00"], ["printf task-1-0", "printf task-1-1"]],
    [["--since", "2026-09-10"], []],
    [["--since", "2026-09-08", "--cwd", "/absent/*"], []],
  ] as const) {
    const result = archive.cli(["cmd", "TASK", ...flags, "--json", "--limit", "100"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(envelope(result.stdout, "cmd", true).results.map((row) => row.command), commands);
  }
  for (const flags of [["--since", "2026-02-30"], ["--since", "2026-09-09", "--until", "2026-09-08"]]) {
    const result = archive.cli(["cmd", "task", ...flags, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(errorEnvelope(result.stdout, "cmd").error?.code, "USAGE_ERROR");
  }
});

test("equal command timestamps retain session/sequence precedence and use entry/source as final tie-breaks", async (t) => {
  const archive = await createArchive(t, { files: { "b.jsonl": fixture("fixture-tie-b", true), "a.jsonl": fixture("fixture-tie-a", true) } });
  const db = openQueryDatabase(archive.databasePath);
  try {
    const rows = searchCommands(db, { pattern: "printf task-*", limit: 5 });
    assert.deepEqual(rows.map((row) => [row.sessionUuid, row.entryId, row.command]), [
      ["fixture-tie-a", "aaaaaaaa", "printf task-1-0"], ["fixture-tie-a", "bbbbbbbb", "printf task-0-0"],
      ["fixture-tie-a", "cccccccc", "printf task-2-0"], ["fixture-tie-a", "aaaaaaaa", "printf task-1-1"],
      ["fixture-tie-a", "bbbbbbbb", "printf task-0-1"],
    ]);
    // Exercise the final primary-key component directly in the synthetic store;
    // ordinary Pi records do not normally mix these sources on one entry.
    const writer = new DatabaseSync(archive.databasePath);
    try {
      writer.exec(`INSERT INTO tool_calls SELECT session_uuid, entry_id, seq, tool, path_raw,
        path_resolved, 'printf task-direct', 'bashExecution', result_entry_id, exit_error
        FROM tool_calls WHERE session_uuid = 'fixture-tie-a' AND entry_id = 'aaaaaaaa' AND seq = 0`);
    } finally { writer.close(); }
    assert.deepEqual(searchCommands(db, { pattern: "printf task-*", limit: 2 }).map((row) => row.command), ["printf task-direct", "printf task-1-0"]);
  } finally { db.close(); }
});

test("limited command results match expansion-first reference across patterns, dates, limits and failures", async (t) => {
  const archive = await createArchive(t, { files: { "commands.jsonl": fixture("fixture-equivalence") } });
  const db = openQueryDatabase(archive.databasePath);
  try {
    for (const pattern of ["TASK", "printf task-*", "printf task-[01]-?", "missing", "' OR 1=1 --", "printf bash-session-task"])
    for (const limit of [1, 3, 100])
    for (const failed of [false, true])
    for (const cwdGlob of [undefined, "/workspace/*", "/absent/*"])
    for (const dates of [{}, { since: "2026-09-08T00:00:00.000Z" }, { until: "2026-09-08T23:59:59.999Z" }]) {
      const options = { pattern, limit, failed, cwdGlob, ...dates };
      assert.deepEqual(searchCommands(db, options), reference(db, options), JSON.stringify(options));
    }
    const pending = searchCommands(db, { pattern: "printf task-2-1", limit: 1 })[0]!;
    assert.equal(pending.failed, null); assert.equal(pending.outputHead, null);
    const combined = searchCommands(db, { pattern: "printf task-0-0", limit: 1 })[0]!;
    assert.ok(combined.outputHead?.startsWith("head-0-0 second-0-0 "));
    assert.equal(combined.outputHead?.length, 500);
  } finally { db.close(); }
});

test("result-block expansion follows the filtered limit and does not modify the synthetic database", async (t) => {
  const archive = await createArchive(t, { files: { "commands.jsonl": fixture("fixture-expansion") } });
  const before = fingerprint(archive.databasePath);
  const db = openQueryDatabase(archive.databasePath);
  try {
    let blocks = 0;
    db.function("observe_output", (text) => { blocks++; return text; });
    db.exec(`CREATE TEMP VIEW text_fts AS SELECT observe_output(content) AS content, kind, session_uuid, entry_id, ts FROM main.text_fts`);
    const result = searchCommands(db, { pattern: "task", failed: true, since: "2026-09-08T00:00:00.000Z", limit: 1 });
    assert.equal(result[0]?.command, "printf task-1-1");
    assert.equal(blocks, 2, "only the two blocks for the selected call should be expanded");
  } finally { db.close(); }
  assert.deepEqual(fingerprint(archive.databasePath), before);
});
