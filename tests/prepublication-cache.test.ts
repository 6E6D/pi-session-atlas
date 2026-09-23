import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { listSessions } from "../src/queries/sessions.ts";
import { AtlasStore } from "../src/store.ts";
import { createArchive, createSandbox, fingerprint } from "./prepublication-support.ts";

for (const rebuild of [false, true]) {
  test(`foreign SQLite file is rejected without mutation (rebuild=${rebuild})`, (t) => {
    const sandbox = createSandbox(t);
    const foreign = join(sandbox.root, "foreign.sqlite");
    const database = new DatabaseSync(foreign);
    database.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('synthetic sentinel'); PRAGMA user_version = 77;");
    database.close();
    chmodSync(foreign, 0o640);
    const before = fingerprint(foreign);
    let refusal: unknown;
    try {
      const store = new AtlasStore(foreign, { rebuild });
      store.close();
    } catch (error) {
      refusal = error;
    }
    assert.deepEqual(fingerprint(foreign), before, "foreign file bytes, timestamp and permissions must not change");
    assert.ok(refusal instanceof Error, "foreign database must be refused, not silently adopted");
  });
}

test("switching source roots refuses implicit rebind and preserves the old corpus", async (t) => {
  const archive = await createArchive(t);
  const otherRoot = join(archive.root, "other-sessions");
  mkdirSync(otherRoot, { mode: 0o700 });
  let refusal: unknown;
  try {
    await indexSessions({ databasePath: archive.databasePath, sessionsDirectory: otherRoot }, archive.parser);
  } catch (error) {
    refusal = error;
  }
  const database = openQueryDatabase(archive.databasePath);
  try {
    assert.deepEqual(listSessions(database, { limit: 10 }).map((row) => row.uuid), ["fixture-session-alpha"], "a different input root must not evict the prior corpus");
  } finally {
    database.close();
  }
  assert.ok(refusal instanceof Error, "source-root changes require an explicit rebind/rebuild decision");
  assert.match(refusal.message, /scope|root|rebuild/i);
});
