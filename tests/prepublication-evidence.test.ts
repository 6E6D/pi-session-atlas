import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { indexSessions } from "../src/indexer.ts";
import { AtlasQueryError, openQueryDatabase } from "../src/query-db.ts";
import { cite } from "../src/queries/cite.ts";
import { search } from "../src/queries/search.ts";
import { showSession } from "../src/queries/show.ts";
import { linearLegacyV1Fixture } from "./fixtures.ts";
import { createArchive, fingerprint, userSession } from "./prepublication-support.ts";

test("modern full/raw retrieval is deliberate, bounded mode excludes raw, and source stays unchanged", async (t) => {
  const text = `Full text\n${"synthetic evidence ".repeat(500)}\nfinal marker`;
  const entries = userSession("fixture-full-output", [text, "next entry"]);
  const archive = await createArchive(t, { files: { "full.jsonl": entries } });
  const source = join(archive.sessionsDirectory, "full.jsonl");
  const before = fingerprint(source);
  const database = openQueryDatabase(archive.databasePath);
  try {
    const bounded = await showSession(database, "fixture-full-output", "00000001", 1);
    assert.ok(bounded.entries.every((entry) => entry.raw === undefined && entry.text.length <= 500));
    const full = await showSession(database, "fixture-full-output", "00000001", 0);
    assert.equal(full.entries.length, 1);
    assert.equal(full.entries[0]?.text, text);
    assert.deepEqual(full.entries[0]?.raw, entries[1]);
    assert.deepEqual(fingerprint(source), before);
  } finally {
    database.close();
  }
});

test("legacy v1 index, citation and full source display share one stable entry identity", async (t) => {
  const archive = await createArchive(t, { files: { "legacy.jsonl": linearLegacyV1Fixture() } });
  const source = join(archive.sessionsDirectory, "legacy.jsonl");
  const before = fingerprint(source);
  const database = openQueryDatabase(archive.databasePath);
  let entryId: string;
  try {
    const hit = search(database, { query: "Legacy prompt", exact: true, limit: 1 })[0];
    assert.ok(hit, "legacy prompt must be indexed before testing source display");
    entryId = hit.entryId;
    assert.match(entryId, /^v1-[0-9a-f]{12}$/);
    assert.equal(cite(database, hit.sessionUuid, entryId).entryId, entryId);
    const shown = await showSession(database, hit.sessionUuid, entryId, 0);
    assert.equal(shown.entries[0]?.id, entryId);
    assert.equal(shown.entries[0]?.text, "Legacy prompt");
    assert.deepEqual(fingerprint(source), before);
  } finally {
    database.close();
  }
  await indexSessions({ databasePath: archive.databasePath, sessionsDirectory: archive.sessionsDirectory, rebuild: true }, archive.parser);
  const rebuilt = openQueryDatabase(archive.databasePath);
  try {
    assert.equal(search(rebuilt, { query: "Legacy prompt", exact: true, limit: 1 })[0]?.entryId, entryId);
  } finally {
    rebuilt.close();
  }
});

test("citation lookup remains index-based while source display rejects a missing file", async (t) => {
  const archive = await createArchive(t);
  const database = openQueryDatabase(archive.databasePath);
  try {
    const before = cite(database, "fixture-session-alpha", "00000001");
    unlinkSync(join(archive.sessionsDirectory, "fixture.jsonl"));
    assert.deepEqual(cite(database, "fixture-session-alpha", "00000001"), before);
    await assert.rejects(showSession(database, "fixture-session-alpha", "00000001", 0), AtlasQueryError);
  } finally {
    database.close();
  }
});

test("exact references and unique prefixes resolve; ambiguous session and entry prefixes reject", async (t) => {
  const archive = await createArchive(t, { files: {
    "alpha.jsonl": userSession("fixture-prefix-alpha", ["first", "second"]),
    "beta.jsonl": userSession("fixture-prefix-beta", ["other"]),
  } });
  const database = openQueryDatabase(archive.databasePath);
  try {
    assert.equal(cite(database, "fixture-prefix-alpha", "00000001").entryId, "00000001");
    assert.equal(cite(database, "fixture-prefix-a").sessionUuid, "fixture-prefix-alpha");
    assert.throws(() => cite(database, "fixture-prefix"), /ambiguous/);
    assert.throws(() => cite(database, "fixture-prefix-alpha", "0000000"), /ambiguous/);
    assert.throws(() => cite(database, "fixture-prefix-alpha", "missing-entry"), /entry not found/);
  } finally {
    database.close();
  }
});
