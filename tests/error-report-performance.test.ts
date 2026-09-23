import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { errorReport } from "../src/queries/reports.ts";
import { writeFixture } from "./fixtures.ts";

// Synthetic corpus: many sessions, each with failing and passing tool calls.
function session(n: number) {
  const ts = (s: number) => `2026-09-01T10:${String(n % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
  const rows: Record<string, unknown>[] = [{ type: "session", version: 3, id: `perf-${n}`, timestamp: ts(0), cwd: "/synthetic" }];
  let parent: string | null = null;
  for (let i = 0; i < 4; i++) {
    const call = `c${i}`, a = `a${i}`, r = `r${i}`;
    rows.push({ type: "message", id: a, parentId: parent, timestamp: ts(i * 2 + 1), message: { role: "assistant",
      content: [{ type: "toolCall", id: call, name: i % 2 ? "bash" : "read", arguments: { command: `run ${n}-${i}` } }],
      provider: "p", model: "m", stopReason: "toolUse", timestamp: 1 } });
    rows.push({ type: "message", id: r, parentId: a, timestamp: ts(i * 2 + 2), message: { role: "toolResult", toolCallId: call,
      toolName: i % 2 ? "bash" : "read", content: [{ type: "text", text: `SIG-${n}-${i}\nsecond line` }], isError: i % 2 === 1, timestamp: 2 } });
    parent = r;
  }
  return rows;
}

// The former correlated form, retained only as an equivalence oracle.
const ORACLE = `SELECT tc.rowid AS r, (SELECT group_concat(content, char(10)) FROM text_fts
  WHERE session_uuid = tc.session_uuid AND entry_id = tc.result_entry_id AND kind = 'tool_head') AS signature
  FROM tool_calls AS tc WHERE tc.exit_error = 1 ORDER BY tc.rowid`;

test("error report aggregates tool heads once and matches the correlated oracle", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-error-perf-"));
  try {
    const sessionsDirectory = join(root, "sessions"), databasePath = join(root, "atlas", "atlas.db");
    for (let n = 0; n < 150; n++) writeFixture(sessionsDirectory, `s${n}.jsonl`, session(n));
    await indexSessions({ databasePath, sessionsDirectory }, (await resolvePiParser()).api);
    const database = openQueryDatabase(databasePath);
    try {
      const oracle = database.prepare(ORACLE).all() as Array<{ signature: string | null }>;
      assert.equal(oracle.length, 300);
      const report = errorReport(database, { by: "signature", limit: 10_000 });
      assert.equal(report.toolFailures, 300);
      const expected = oracle.map(r => (r.signature ?? "").split(/\r?\n/, 1)[0]).sort();
      const actual = report.recent.filter(f => f.kind === "tool").map(f => f.signature).sort();
      assert.deepEqual(actual, expected);
      assert.ok(actual.every(s => /^SIG-\d+-[13]$/.test(s)));

      // Structural guard: text_fts must be scanned once, not once per failure.
      const plan = (database.prepare(`EXPLAIN QUERY PLAN WITH heads AS (SELECT session_uuid, entry_id,
        group_concat(content, char(10)) AS signature FROM text_fts WHERE kind = 'tool_head' GROUP BY session_uuid, entry_id)
        SELECT tc.entry_id, h.signature FROM tool_calls AS tc LEFT JOIN heads AS h
        ON h.session_uuid = tc.session_uuid AND h.entry_id = tc.result_entry_id WHERE tc.exit_error = 1`).all() as Array<{ detail: string }>)
        .map(r => r.detail).join("\n");
      assert.doesNotMatch(plan, /CORRELATED/);
      const { readFileSync } = await import("node:fs");
      const source = readFileSync(new URL("../src/queries/reports.ts", import.meta.url), "utf8");
      assert.doesNotMatch(source, /\(SELECT group_concat\(content, char\(10\)\) FROM text_fts\s+WHERE session_uuid = tc\.session_uuid/);
    } finally { database.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
