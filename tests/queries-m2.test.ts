import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { cite } from "../src/queries/cite.ts";
import { search } from "../src/queries/search.ts";
import { listSessions } from "../src/queries/sessions.ts";
import { showSession } from "../src/queries/show.ts";
import { branchedSessionFixture, writeFixture } from "./fixtures.ts";

test("M2 search, sessions, show, and cite contracts use indexed evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-atlas-m2-"));
  try {
    const sessionsDirectory = join(root, "sessions");
    const databasePath = join(root, "atlas", "atlas.db");
    writeFixture(sessionsDirectory, "fixture.jsonl", branchedSessionFixture());
    const parser = (await resolvePiParser()).api;
    await indexSessions({ databasePath, sessionsDirectory, toolHeadBytes: 64 }, parser);
    const database = openQueryDatabase(databasePath);
    try {
      const exact = search(database, {
        query: "Investigate Atlas",
        exact: true,
        limit: 20,
      });
      assert.equal(exact.length, 1);
      assert.equal(exact[0]?.kind, "user");
      assert.equal(exact[0]?.entryId, "00000001");
      assert.match(exact[0]?.citation ?? "", /fixture-session-alpha/);

      const summary = search(database, {
        query: "selected",
        kinds: ["summary"],
        cwdGlob: "/workspace/*",
        limit: 20,
      });
      assert.equal(summary.length, 1);
      assert.equal(summary[0]?.entryId, "00000009");

      const sessions = listSessions(database, {
        namePattern: "Atlas",
        limit: 20,
      });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.name, "Fixture Atlas investigation");
      assert.equal(sessions[0]?.entries, 11);
      assert.equal(sessions[0]?.models[0], "test-provider/test-model");

      const sessionCitation = cite(database, "fixture-session");
      assert.match(
        sessionCitation.citation,
        /^`fixture-session-alpha` \(2026-08-23\), Fixture Atlas investigation$/,
      );
      const entryCitation = cite(database, "fixture-session-alpha", "00000009");
      assert.match(entryCitation.citation, /#00000009/);

      const shown = await showSession(database, "fixture-session", "00000004", 1);
      assert.equal(shown.targetEntryId, "00000004");
      assert.deepEqual(
        shown.entries.map((entry) => entry.id),
        ["00000003", "00000004", "00000005"],
      );
      assert.match(shown.entries[1]?.text ?? "", /Tests failed/);

      const full = await showSession(database, "fixture-session", "00000002", 0);
      assert.equal(full.entries.length, 1);
      assert.equal(full.entries[0]?.id, "00000002");
      assert.equal(full.entries[0]?.raw?.type, "message");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
