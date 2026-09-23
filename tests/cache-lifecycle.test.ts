import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { createArchive, createSandbox, envelope, errorEnvelope, fingerprint, userSession } from "./prepublication-support.ts";

for (const kind of ["empty-file", "empty-sqlite", "same-version", "extra-object", "future-version", "older-version", "cache-symlink", "hardlink", "sidecar-symlink"] as const) {
  test(`cache refusal is nonmutating: ${kind}`, async (t) => {
    const a = await createArchive(t);
    let target = a.databasePath;
    if (kind === "empty-file" || kind === "empty-sqlite" || kind === "same-version") {
      target = join(a.atlasHome, "foreign.db");
      if (kind === "empty-file") writeFileSync(target, "", { mode: 0o600 });
      else { const db = new DatabaseSync(target); db.exec(kind === "same-version" ? "CREATE TABLE notes(value); PRAGMA user_version=4" : "PRAGMA user_version=0; VACUUM"); db.close(); chmodSync(target, 0o600); }
    } else if (kind === "extra-object" || kind === "future-version" || kind === "older-version") {
      const db = new DatabaseSync(target); db.exec(kind === "extra-object" ? "CREATE TABLE private_notes(value)" : kind === "older-version" ? "PRAGMA user_version=2" : "PRAGMA user_version=999"); db.close();
    } else if (kind === "cache-symlink" || kind === "hardlink") {
      const alias = join(a.atlasHome, "alias.db");
      if (kind === "cache-symlink") symlinkSync(target, alias); else linkSync(target, alias);
      target = alias;
    } else symlinkSync(join(a.atlasHome, "sentinel"), target + "-wal");
    const before = fingerprint(target); const names = readdirSync(a.atlasHome);
    for (const flags of [[], ["--rebuild"], ["--rebuild", "--rebind", "--sessions-dir", a.sessionsDirectory]]) {
      const result = a.cli(["index", "--db", target, "--json", ...flags]);
      assert.equal(result.status, 2, result.stdout);
      assert.match(String(errorEnvelope(result.stdout, "index").error?.code), /^CACHE_|^DATABASE_/);
      assert.deepEqual(fingerprint(target), before); assert.deepEqual(readdirSync(a.atlasHome), names);
    }
  });
}

test("root rebinding needs both explicit flags and an explicit CLI root; incomplete rebind preserves the old corpus", async (t) => {
  const a = await createArchive(t);
  const other = join(a.root, "other"); mkdirSync(other, { mode: 0o700 });
  const before = fingerprint(a.databasePath);
  for (const flags of [["--sessions-dir", other], ["--sessions-dir", other, "--rebuild"]]) {
    const r = a.cli(["index", ...flags, "--json"]); assert.equal(r.status, 2); assert.deepEqual(fingerprint(a.databasePath), before);
  }
  for (const flags of [["--rebind"], ["--rebind", "--rebuild"]]) {
    const r = a.cli(["index", ...flags, "--json"]); assert.equal(r.status, 1); assert.equal(errorEnvelope(r.stdout, "index").error?.code, "USAGE_ERROR");
  }
  writeFileSync(join(other, "bad.jsonl"), "{}\n");
  const failed = a.cli(["index", "--rebuild", "--rebind", "--sessions-dir", other, "--json"]);
  assert.equal(failed.status, 2);
  assert.equal(envelope(a.cli(["sessions", "--json"]).stdout, "sessions", true).results.length, 1);
  unlinkSync(join(other, "bad.jsonl"));
  const rebound = a.cli(["index", "--rebuild", "--rebind", "--sessions-dir", other, "--json"]);
  assert.equal(rebound.status, 0, rebound.stdout);
  assert.equal(envelope(a.cli(["sessions", "--json"]).stdout, "sessions", true).results.length, 0);
});

test("parser/settings mismatches refuse unchanged-file reuse until explicit rebuild", async (t) => {
  const a = await createArchive(t, { toolHeadBytes: 32 }); const before = fingerprint(a.databasePath);
  await assert.rejects(indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, toolHeadBytes: 64 }, a.parser), /identity|settings|rebuild/i);
  assert.deepEqual(fingerprint(a.databasePath), before);
  const same = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, toolHeadBytes: 32 }, a.parser);
  assert.equal(same.filesUnchanged, 1);
  const rebuilt = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, toolHeadBytes: 64, rebuild: true }, a.parser);
  assert.equal(rebuilt.filesChanged, 1);
  const unknown = { ...a.parser };
  await assert.rejects(indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, toolHeadBytes: 64 }, unknown), /parser.*identity/i);
});

test("legacy v3 requires explicit rebuild and root binding; extra objects are not adoptable", async (t) => {
  const a = createSandbox(t); const db = new DatabaseSync(a.databasePath);
  db.exec(readFileSync(new URL("./fixtures/atlas-v3-schema.sql", import.meta.url), "utf8")); db.close(); chmodSync(a.databasePath, 0o600);
  const before = fingerprint(a.databasePath);
  const extendedPath = join(a.atlasHome, "extended-v3.db"); const extended = new DatabaseSync(extendedPath);
  extended.exec(readFileSync(new URL("./fixtures/atlas-v3-schema.sql", import.meta.url), "utf8"));
  extended.exec("CREATE TABLE private_notes(value)"); extended.close(); chmodSync(extendedPath, 0o600);
  const extendedBefore = fingerprint(extendedPath);
  assert.equal(a.cli(["index", "--db", extendedPath, "--rebuild", "--rebind", "--sessions-dir", a.sessionsDirectory, "--json"]).status, 2);
  assert.deepEqual(fingerprint(extendedPath), extendedBefore);
  for (const flags of [[], ["--rebuild"]]) { assert.equal(a.cli(["index", "--json", ...flags]).status, 2); assert.deepEqual(fingerprint(a.databasePath), before); }
  const r = a.cli(["index", "--rebuild", "--rebind", "--sessions-dir", a.sessionsDirectory, "--json"]);
  assert.equal(r.status, 0, r.stdout);
  const query = openQueryDatabase(a.databasePath); try { assert.equal(query.prepare("PRAGMA user_version").get()?.user_version, 4); } finally { query.close(); }
});

test("failed changed files retain visibly unverified evidence and do not advance successful scan time", async (t) => {
  const a = await createArchive(t, { files: { "fixture.jsonl": userSession("fixture-stale", ["old evidence"]) } });
  const initial = JSON.parse(a.cli(["search", "evidence", "--json"]).stdout);
  assert.ok(initial.cache?.lastSuccessfulScan);
  writeFileSync(join(a.sessionsDirectory, "fixture.jsonl"), "{}\n");
  assert.equal(a.cli(["index", "--json"]).status, 2);
  const after = JSON.parse(a.cli(["search", "evidence", "--json"]).stdout);
  assert.equal(after.results.length, 1);
  assert.equal(after.cache.lastSuccessfulScan, initial.cache.lastSuccessfulScan);
  assert.equal(after.cache.lastAttempt.status, "partial");
  assert.equal(after.cache.unverifiedFiles.length, 1);
  assert.match(a.cli(["search", "evidence"]).stdout, /unverified|partial/i);
});

test("failed rebuild preserves previously queryable rows and metadata binding", async (t) => {
  const a = await createArchive(t); writeFileSync(join(a.sessionsDirectory, "fixture.jsonl"), "{}\n");
  const r = a.cli(["index", "--rebuild", "--json"]); assert.equal(r.status, 2);
  const q = a.cli(["sessions", "--json"]); assert.equal(q.status, 0, q.stdout);
  const payload = JSON.parse(q.stdout); assert.equal(payload.results.length, 1);
  assert.equal(payload.cache.identity.sourceRoot, a.sessionsDirectory);
  assert.equal(payload.cache.lastAttempt.status, "failed");
});

test("incomplete enumeration does not evict prior rows; private state and aliases are checked", async (t) => {
  const a = await createArchive(t); const held = join(a.root, "held.jsonl");
  renameSync(join(a.sessionsDirectory, "fixture.jsonl"), held);
  symlinkSync(held, join(a.sessionsDirectory, "fixture.jsonl"));
  const r = a.cli(["index", "--json"]); assert.equal(r.status, 2);
  assert.equal(JSON.parse(a.cli(["sessions", "--json"]).stdout).results.length, 1);
  chmodSync(a.atlasHome, 0o755); const before = fingerprint(a.databasePath);
  assert.equal(a.cli(["index", "--json"]).status, 2); assert.deepEqual(fingerprint(a.databasePath), before);
  assert.equal(fingerprint(a.databasePath).mode, 0o600);
});
