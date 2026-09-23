import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { findBranches } from "../src/queries/branches.ts";
import { searchCommands } from "../src/queries/commands.ts";
import { traceFile } from "../src/queries/trace.ts";
import { findUnfinished } from "../src/queries/unfinished.ts";
import { branchedSessionFixture, type FixtureEntry, usage, writeFixture } from "./fixtures.ts";

function unfinishedFixture(
  id: string,
  final: "user" | "aborted" | "error" | "length" | "dangling",
): FixtureEntry[] {
  const base: FixtureEntry[] = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-08-22T10:00:00.000Z",
      cwd: `/workspace/${id}`,
    },
    {
      type: "message",
      id: "10000001",
      parentId: null,
      timestamp: "2026-08-22T10:00:01.000Z",
      message: { role: "user", content: `Finish ${final} task`, timestamp: 1 },
    },
  ];
  if (final === "user") return base;
  base.push({
    type: "message",
    id: "10000002",
    parentId: "10000001",
    timestamp: "2026-08-22T10:00:02.000Z",
    message: {
      role: "assistant",
      content:
        final === "dangling"
          ? [{ type: "toolCall", id: "dangling-call", name: "bash", arguments: { command: "sleep 1" } }]
          : [{ type: "text", text: `${final} response` }],
      provider: "test-provider",
      model: "test-model",
      usage: usage(),
      stopReason: final === "dangling" ? "toolUse" : final,
      timestamp: 2,
    },
  });
  return base;
}

test("M3 traces files/commands and finds abandoned or unfinished candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-atlas-m3-"));
  try {
    const sessionsDirectory = join(root, "sessions");
    const databasePath = join(root, "atlas", "atlas.db");
    writeFixture(sessionsDirectory, "branches.jsonl", branchedSessionFixture());
    for (const final of ["user", "aborted", "error", "length", "dangling"] as const) {
      writeFixture(
        sessionsDirectory,
        `${final}.jsonl`,
        unfinishedFixture(`fixture-${final}`, final),
      );
    }
    const parser = (await resolvePiParser()).api;
    await indexSessions({ databasePath, sessionsDirectory }, parser);
    const database = openQueryDatabase(databasePath);
    try {
      const reads = traceFile(database, { file: "src/main.ts", limit: 20 });
      assert.equal(reads.length, 1);
      assert.equal(reads[0]?.tool, "read");
      assert.equal(reads[0]?.pathResolved, "/workspace/project/src/main.ts");

      const compacted = traceFile(database, { file: "src/output.ts", limit: 20 });
      assert.equal(compacted.length, 1);
      assert.equal(compacted[0]?.source, "compaction_details");

      const commands = searchCommands(database, { pattern: "npm test", failed: true, limit: 20 });
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.failed, true);
      assert.match(commands[0]?.outputHead ?? "", /Tests failed/);

      const abandoned = findBranches(database, {
        abandonedOnly: true,
        sessionReference: "fixture-session-alpha",
        limit: 20,
        now: new Date("2026-08-25T00:00:00.000Z"),
      });
      assert.equal(abandoned.length, 1);
      assert.equal(abandoned[0]?.branchPointId, "00000004");
      assert.equal(abandoned[0]?.tipEntryId, "00000006");
      assert.equal(abandoned[0]?.abandoned, true);
      assert.match(abandoned[0]?.snippet ?? "", /interrupted/);

      const allTips = findBranches(database, {
        sessionReference: "fixture-session-alpha",
        limit: 20,
        now: new Date("2026-08-25T00:00:00.000Z"),
      });
      assert.deepEqual(
        new Set(allTips.map((tip) => tip.tipEntryId)),
        new Set(["00000006", "00000009"]),
      );

      const unfinished = findUnfinished(database, { limit: 20 });
      const bySession = new Map(unfinished.map((candidate) => [candidate.sessionUuid, candidate.reasons]));
      assert.deepEqual(bySession.get("fixture-user"), ["no-assistant", "unanswered-user"]);
      assert.deepEqual(bySession.get("fixture-aborted"), ["aborted"]);
      assert.deepEqual(bySession.get("fixture-error"), ["error"]);
      assert.deepEqual(bySession.get("fixture-length"), ["length"]);
      assert.deepEqual(bySession.get("fixture-dangling"), ["dangling-tool"]);
      assert.equal(bySession.has("fixture-session-alpha"), false);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
