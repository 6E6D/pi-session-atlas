// Explicit, synthetic WU4 acceptance probe, not a hardware-sensitive unit test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { openQueryDatabase } from "../src/query-db.ts";
import { searchCommands } from "../src/queries/commands.ts";
import { AtlasStore } from "../src/store.ts";
import { ATLAS_EXTRACTION_VERSION, ATLAS_SCHEMA_VERSION, type NormalizedEntry, type NormalizedSession } from "../src/types.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { fingerprint, projectRoot } from "./prepublication-support.ts";

const totalCalls = 50_000;
const callsPerSession = 500;
const root = mkdtempSync(join(tmpdir(), "atlas command-scale "));
const databasePath = join(root, "atlas", "atlas.db");
const timestamp = (value: number) => new Date(Date.UTC(2026, 0, 1) + value).toISOString();
const zeroUsage = { cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
function sessionFixture(number: number): NormalizedSession {
  const uuid = `bench-session-${String(number).padStart(3, "0")}`;
  const first = number * callsPerSession;
  const session: NormalizedSession = {
    uuid, file: join(root, "synthetic-sessions", `${uuid}.jsonl`), sessionDir: join(root, "synthetic-sessions"),
    cwd: `/workspace/scope-${number % 2}`, name: `Synthetic commands ${number}`, firstUserText: null, parentSession: null,
    created: timestamp(first * 1000), lastActivity: timestamp((first + callsPerSession) * 1000),
    entryCount: callsPerSession * 2, userMessages: 0, assistantMessages: callsPerSession, toolResults: callsPerSession,
    models: ["test-provider/test-model"], entries: [], toolCalls: [], texts: [], warnings: [], ...zeroUsage,
  };
  for (let local = 0; local < callsPerSession; local++) {
    const index = first + local;
    const id = (2 * local + 1).toString(16).padStart(8, "0");
    const resultId = (2 * local + 2).toString(16).padStart(8, "0");
    const failed = index % 10 === 0;
    const entry: NormalizedEntry = { id, parentId: local ? (2 * local).toString(16).padStart(8, "0") : null,
      type: "message", role: "assistant", timestamp: timestamp(index * 1000), onActivePath: true, childCount: 1,
      stopReason: "toolUse", errorMessage: null, isError: false, model: "test-model", provider: "test-provider", ...zeroUsage };
    session.entries.push(entry, { ...entry, id: resultId, parentId: id, role: "toolResult", timestamp: timestamp(index * 1000 + 1),
      stopReason: null, isError: failed, model: null, provider: null, childCount: local === callsPerSession - 1 ? 0 : 1 });
    session.toolCalls.push({ entryId: id, sequence: 0, tool: "bash", pathRaw: null, pathResolved: null,
      command: `bench task ${index}`, source: "toolCall", resultEntryId: resultId, exitError: failed });
    session.texts.push(
      { entryId: id, timestamp: entry.timestamp, kind: "assistant", content: `Run synthetic task ${index}. ${"progress detail ".repeat(10)}` },
      { entryId: id, timestamp: entry.timestamp, kind: "thinking", content: `Check synthetic task ${index}. ${"bounded inspection ".repeat(10)}` },
      { entryId: resultId, timestamp: timestamp(index * 1000 + 1), kind: "tool_head", content: (`result-${index} ` + "synthetic command output detail ".repeat(100)).slice(0, 2048) },
    );
  }
  return session;
}

try {
  const started = performance.now();
  const { identity: parser } = await resolvePiParser();
  const store = new AtlasStore(databasePath, { identity: { sourceRoot: join(root, "synthetic-sessions"),
    pathHome: join(root, "synthetic-home"), schemaVersion: ATLAS_SCHEMA_VERSION,
    extractionVersion: ATLAS_EXTRACTION_VERSION, toolHeadBytes: 2048, parser } });
  try {
    // Seed normalized rows directly. This measures command queries, not Pi
    // parsing/indexing throughput, and does not manufacture session sources.
    for (let number = 0; number < totalCalls / callsPerSession; number++) {
      store.replaceSession(sessionFixture(number), { mtimeMs: 0, size: 0 }, timestamp(0));
    }
  } finally { store.close(); }
  const setupMs = performance.now() - started;
  const before = fingerprint(databasePath);
  const database = openQueryDatabase(databasePath);
  const apiMs: number[] = [];
  const cliMs: number[] = [];
  const expected = ["bench task 49999", "bench task 49998", "bench task 49997"];
  let sqliteVersion: unknown;
  let counts: unknown;
  try {
    counts = database.prepare(`SELECT (SELECT count(*) FROM sessions) AS sessions,
      (SELECT count(*) FROM tool_calls) AS calls, (SELECT count(*) FROM entries) AS entries,
      (SELECT count(*) FROM text_fts) AS text_rows`).get();
    assert.deepEqual({ ...counts as object }, { sessions: 100, calls: 50_000, entries: 100_000, text_rows: 150_000 });
    sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get()?.version;
    for (let run = 0; run < 6; run++) {
      const start = performance.now();
      const rows = searchCommands(database, { pattern: "bench task", limit: 3 });
      apiMs.push(performance.now() - start);
      assert.deepEqual(rows.map((row) => row.command), expected);
      assert.ok(rows.every((row, index) => row.outputHead?.startsWith(`result-${49999 - index} `) && row.outputHead.length === 500));
    }
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const result = spawnSync(join(projectRoot, "bin", "atlas"), ["cmd", "bench task", "--db", databasePath, "--limit", "3", "--json"],
        { cwd: projectRoot, env: process.env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
      cliMs.push(performance.now() - start);
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).results.map((row: { command: string }) => row.command), expected);
    }
  } finally { database.close(); }
  assert.deepEqual(fingerprint(databasePath), before);
  const result = { counts, headBytesPerCall: 2048, databaseBytes: statSync(databasePath).size, setupMs,
    apiMsFirstAndFiveWarm: apiMs, cliMsThreeWarm: cliMs, warmBudgetMs: 2000,
    withinWarmBudget: [...apiMs.slice(1), ...cliMs].every((value) => value < 2000), databaseUnchanged: true,
    runtime: process.version, sqliteVersion, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), processMaxRssKiBIncludingSetup: process.resourceUsage().maxRSS,
  };
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.withinWarmBudget, true, "manual warm-query acceptance budget exceeded; investigate, do not weaken silently");
} finally {
  // Only the fresh synthetic root allocated above, never a caller-supplied path.
  rmSync(root, { recursive: true, force: true });
}
