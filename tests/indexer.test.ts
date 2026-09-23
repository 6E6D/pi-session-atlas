import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { indexSessions } from "../src/indexer.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { AtlasStore } from "../src/store.ts";
import { branchedSessionFixture, writeFixture } from "./fixtures.ts";

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stableDatabaseSnapshot(databasePath: string): string {
  const store = new AtlasStore(databasePath);
  try {
    const database = store.rawDatabase();
    return JSON.stringify({
      sessions: database.prepare("SELECT * FROM sessions ORDER BY uuid").all(),
      entries: database.prepare("SELECT * FROM entries ORDER BY session_uuid, id").all(),
      calls: database
        .prepare("SELECT * FROM tool_calls ORDER BY session_uuid, entry_id, seq, source")
        .all(),
      texts: database
        .prepare("SELECT content, kind, session_uuid, entry_id, ts FROM text_fts ORDER BY rowid")
        .all(),
    });
  } finally {
    store.close();
  }
}

test("index is incremental, rebuildable, read-only on source, and propagates deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-atlas-test-"));
  try {
    const sessionsDirectory = join(root, "sessions");
    const databasePath = join(root, "store", "atlas.db");
    const sessionFile = writeFixture(
      join(sessionsDirectory, "--workspace-project--"),
      "fixture.jsonl",
      branchedSessionFixture(),
      true,
    );
    const before = { hash: digest(sessionFile), mtimeMs: statSync(sessionFile).mtimeMs };
    const parser = (await resolvePiParser()).api;
    const now = (): Date => new Date("2026-08-23T12:00:00.000Z");

    const first = await indexSessions(
      { databasePath, sessionsDirectory, toolHeadBytes: 32, now },
      parser,
    );
    assert.equal(first.filesScanned, 1);
    assert.equal(first.filesChanged, 1);
    assert.equal(first.filesUnchanged, 0);
    assert.equal(first.sessionsIndexed, 1);
    assert.equal(first.entriesIndexed, 11);
    assert.equal(first.parseWarnings, 1);
    assert.equal(first.failures.length, 0);
    assert.ok(first.databaseBytes > 0);

    const firstSnapshot = stableDatabaseSnapshot(databasePath);
    const store = new AtlasStore(databasePath);
    try {
      assert.equal(store.countSessions(), 1);
      assert.equal(store.countEntries(), 11);
      const ftsHit = store
        .rawDatabase()
        .prepare("SELECT count(*) AS count FROM text_fts WHERE text_fts MATCH 'expected'")
        .get() as { count: number | bigint };
      assert.equal(Number(ftsHit.count), 1);
      assert.equal(store.getCatalog().get(sessionFile)?.parseWarnings, 1);
    } finally {
      store.close();
    }

    const second = await indexSessions({ databasePath, sessionsDirectory, toolHeadBytes: 32, now }, parser);
    assert.equal(second.filesChanged, 0);
    assert.equal(second.filesUnchanged, 1);

    const rebuilt = await indexSessions(
      { databasePath, sessionsDirectory, rebuild: true, toolHeadBytes: 32, now },
      parser,
    );
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(rebuilt.filesChanged, 1);
    assert.equal(stableDatabaseSnapshot(databasePath), firstSnapshot);

    const after = { hash: digest(sessionFile), mtimeMs: statSync(sessionFile).mtimeMs };
    assert.deepEqual(after, before);

    unlinkSync(sessionFile);
    const removed = await indexSessions({ databasePath, sessionsDirectory, toolHeadBytes: 32, now }, parser);
    assert.equal(removed.filesScanned, 0);
    assert.equal(removed.filesRemoved, 1);
    const empty = new AtlasStore(databasePath);
    try {
      assert.equal(empty.countSessions(), 0);
      assert.equal(empty.countEntries(), 0);
    } finally {
      empty.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
