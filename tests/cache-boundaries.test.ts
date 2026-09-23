import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cacheCoverage, recognizeCache } from "../src/cache.ts";
import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { parserIdentityFor } from "../src/resolve-pi.ts";
import { createArchive, createSandbox, fingerprint, userSession } from "./prepublication-support.ts";

function writeSession(path: string, uuid: string, text = "synthetic evidence") {
  writeFileSync(path, userSession(uuid, [text]).map((v) => JSON.stringify(v)).join("\n") + "\n");
}

test("interrupted scan marks retained rows unverified, including strict source citation verification", async (t) => {
  const a = await createArchive(t);
  const db = new DatabaseSync(a.databasePath);
  try {
    const row = db.prepare("SELECT last_attempt FROM cache_metadata").get()!;
    const attempt = JSON.parse(String(row.last_attempt)); attempt.status = "running"; attempt.finishedAt = null;
    db.prepare("UPDATE cache_metadata SET last_attempt=?").run(JSON.stringify(attempt));
  } finally { db.close(); }
  const q = JSON.parse(a.cli(["sessions", "--json"]).stdout);
  assert.equal(q.cache.unverifiedFiles.length, 1);
  const cited = a.cli(["cite", "fixture-session-alpha", "00000001", "--verify-source", "--json"]);
  assert.equal(cited.status, 2); assert.equal(JSON.parse(cited.stdout).error.code, "SOURCE_CHANGED");
  const refreshed = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory }, a.parser);
  assert.equal(refreshed.filesChanged, 1); assert.equal(refreshed.filesUnchanged, 0);
});

test("parser package identity changes require rebuild and persist the selected identity", async (t) => {
  const a = await createArchive(t); const parserIdentity = { ...parserIdentityFor(a.parser)!, packageVersion: "synthetic-successor" };
  const options = { databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, parserIdentity };
  const before = fingerprint(a.databasePath);
  await assert.rejects(indexSessions(options, a.parser), /identity.*rebuild/i); assert.deepEqual(fingerprint(a.databasePath), before);
  const r = await indexSessions({ ...options, rebuild: true }, a.parser);
  assert.equal(r.coverage?.identity.parser.packageVersion, "synthetic-successor");
  await assert.rejects(indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory }, a.parser), /identity.*rebuild/i);
});

test("canonical source-root aliases do not cause rebinding", async (t) => {
  const a = await createArchive(t); const alias = join(a.root, "root-alias"); symlinkSync(a.sessionsDirectory, alias);
  const r = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: alias }, a.parser);
  assert.equal(r.filesUnchanged, 1); assert.equal(r.coverage?.identity.sourceRoot, a.sessionsDirectory);
});

test("concurrent append is not committed as stable and failed rebuild preserves previous data", async (t) => {
  const a = await createArchive(t); const file = join(a.sessionsDirectory, "fixture.jsonl"); let calls = 0;
  const r = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, rebuild: true,
    now: () => { if (++calls === 2) appendFileSync(file, "\n"); return new Date("2026-09-09T00:00:00Z"); },
  }, a.parser);
  assert.equal(r.committed, false); assert.equal(r.rebuilt, false); assert.match(r.failures[0]?.message ?? "", /changed during reading/);
  assert.equal(JSON.parse(a.cli(["sessions", "--json"]).stdout).results.length, 1);
});

test("late file changes remain queryable only as explicitly unverified observations", async (t) => {
  const a = await createArchive(t, { files: { "a.jsonl": userSession("fixture-first", ["before"]), "b.jsonl": userSession("fixture-second", ["before"]) } });
  for (const file of ["a.jsonl", "b.jsonl"]) appendFileSync(join(a.sessionsDirectory, file), "\n");
  let calls = 0;
  const r = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory,
    now: () => { if (++calls === 3) appendFileSync(join(a.sessionsDirectory, "a.jsonl"), "\n"); return new Date("2026-09-09T00:00:00Z"); },
  }, a.parser);
  assert.equal(r.committed, true); assert.equal(r.coverage?.lastAttempt?.status, "partial");
  assert.ok(r.coverage?.unverifiedFiles.some((v) => v.file.endsWith("a.jsonl")));
});

test("a directory race rolls back already staged deletions", async (t) => {
  const a = await createArchive(t); unlinkSync(join(a.sessionsDirectory, "fixture.jsonl"));
  writeSession(join(a.sessionsDirectory, "new.jsonl"), "fixture-new"); let calls = 0;
  const r = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory,
    now: () => { if (++calls === 2) writeSession(join(a.sessionsDirectory, "late.jsonl"), "fixture-late"); return new Date("2026-09-09T00:00:00Z"); },
  }, a.parser);
  assert.equal(r.committed, false); assert.equal(r.filesRemoved, 0);
  const q = JSON.parse(a.cli(["sessions", "--json"]).stdout);
  assert.deepEqual(q.results.map((v: any) => v.uuid), ["fixture-session-alpha"]);
  assert.equal(q.cache.lastAttempt.enumerationComplete, false);
});

test("unreadable subtree is partial coverage, not deletion", async (t) => {
  const a = await createArchive(t, { files: { "a.jsonl": userSession("fixture-nested", ["evidence"]) } });
  const nested = join(a.sessionsDirectory, "nested"); mkdirSync(nested, { mode: 0o700 });
  renameSync(join(a.sessionsDirectory, "a.jsonl"), join(nested, "a.jsonl"));
  await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory }, a.parser);
  chmodSync(nested, 0);
  try {
    const r = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory }, a.parser);
    assert.equal(r.filesRemoved, 0); assert.equal(r.coverage?.lastAttempt?.status, "partial");
    assert.ok(r.coverage?.unverifiedFiles.some((v) => v.file.endsWith("a.jsonl")));
    assert.equal(JSON.parse(a.cli(["sessions", "--json"]).stdout).results.length, 1);
  } finally { chmodSync(nested, 0o700); }
});

test("foreign WAL/SHM bytes and metadata remain untouched while its writer is open", (t) => {
  const a = createSandbox(t); const db = new DatabaseSync(a.databasePath); chmodSync(a.databasePath, 0o600);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(value); INSERT INTO notes VALUES('synthetic sentinel')");
    const paths = [a.databasePath, a.databasePath + "-wal", a.databasePath + "-shm"];
    const before = paths.map(fingerprint);
    assert.equal(a.cli(["index", "--rebuild", "--json"]).status, 2);
    assert.deepEqual(paths.map(fingerprint), before);
  } finally { db.close(); }
});

test("nonempty Atlas WAL is refused without checkpointing; owned new sidecars are private", async (t) => {
  const a = await createArchive(t); const db = new DatabaseSync(a.databasePath);
  try {
    db.exec("UPDATE sessions SET name='synthetic write'");
    const paths = [a.databasePath, a.databasePath + "-wal", a.databasePath + "-shm"];
    assert.deepEqual(paths.map((p) => statSync(p).mode & 0o777), [0o600, 0o600, 0o600]);
    const before = paths.map(fingerprint);
    assert.throws(() => openQueryDatabase(a.databasePath), (e: any) => e.code === "CACHE_BUSY");
    assert.deepEqual(paths.map(fingerprint), before);
  } finally { db.close(); }
  const q = openQueryDatabase(a.databasePath); q.close();
});

test("pre-existing writer lock is never removed or overwritten", async (t) => {
  const a = await createArchive(t); const lock = a.databasePath + ".lock"; writeFileSync(lock, "synthetic lock", { mode: 0o600 });
  const before = fingerprint(a.databasePath); const lockBefore = fingerprint(lock);
  assert.equal(a.cli(["index", "--json"]).status, 2);
  assert.deepEqual(fingerprint(a.databasePath), before); assert.deepEqual(fingerprint(lock), lockBefore);
});

test("malformed metadata and non-SQLite files are refused without leaked descriptors", async (t) => {
  const a = await createArchive(t); const db = new DatabaseSync(a.databasePath);
  db.exec("UPDATE cache_metadata SET identity='{}'"); db.close();
  const before = fingerprint(a.databasePath); const fds = readdirSync("/proc/self/fd").length;
  for (let i = 0; i < 30; i++) assert.throws(() => recognizeCache(a.databasePath));
  assert.ok(readdirSync("/proc/self/fd").length <= fds + 1); assert.deepEqual(fingerprint(a.databasePath), before);
  const other = join(a.atlasHome, "not-sqlite.db"); writeFileSync(other, "synthetic non-SQLite input", { mode: 0o600 });
  const otherBefore = fingerprint(other); assert.throws(() => recognizeCache(other)); assert.deepEqual(fingerprint(other), otherBefore);
});

test("cache path inside source root is rejected before any state is created", (t) => {
  const a = createSandbox(t); const path = join(a.sessionsDirectory, "cache.db");
  const r = a.cli(["index", "--db", path, "--json"]);
  assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).error.code, "CACHE_UNSAFE_PATH");
  assert.deepEqual(readdirSync(a.sessionsDirectory), []);
});

test("unsupported source version and duplicate UUIDs cannot silently replace useful evidence", async (t) => {
  const a = await createArchive(t, { files: { "first.jsonl": userSession("fixture-duplicate", ["first evidence"]) } });
  writeSession(join(a.sessionsDirectory, "second.jsonl"), "fixture-duplicate", "second evidence");
  const duplicate = a.cli(["index", "--json"]); assert.equal(duplicate.status, 2);
  assert.equal(JSON.parse(a.cli(["search", "first", "--json"]).stdout).results.length, 1);
  const v = userSession("fixture-future", ["future"]); v[0]!.version = 999;
  writeFileSync(join(a.sessionsDirectory, "future.jsonl"), v.map((e) => JSON.stringify(e)).join("\n"));
  const future = a.cli(["index", "--json"]); assert.equal(future.status, 2);
  assert.match(future.stdout, /unsupported source session version/);
});

test("incomplete legacy-v3 conversion preserves the exact old database format and data", async (t) => {
  const a = await createArchive(t); const legacy = join(a.atlasHome, "populated-v3.db");
  const db = new DatabaseSync(legacy); const input = openQueryDatabase(a.databasePath);
  try {
    db.exec(readFileSync(new URL("./fixtures/atlas-v3-schema.sql", import.meta.url), "utf8"));
    for (const table of ["sessions", "entries", "tool_calls", "text_fts", "catalog"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
      const insert = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of input.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all()) insert.run(...columns.map((name) => row[name]!));
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 1);
    assert.ok(Number(db.prepare("SELECT count(*) AS n FROM text_fts").get()?.n) > 0);
  } finally { input.close(); db.close(); }
  chmodSync(legacy, 0o600); const before = fingerprint(legacy);
  writeFileSync(join(a.sessionsDirectory, "bad.jsonl"), "{}\n");
  const r = a.cli(["index", "--db", legacy, "--rebuild", "--rebind", "--sessions-dir", a.sessionsDirectory, "--json"]);
  assert.equal(r.status, 2); assert.equal(recognizeCache(legacy)?.version, 3);
  assert.equal(fingerprint(legacy).sha256, before.sha256);
});

test("unexpected metadata extensions are not overwritten as disposable cache data", async (t) => {
  const a = await createArchive(t); const db = new DatabaseSync(a.databasePath);
  const identity = JSON.parse(String(db.prepare("SELECT identity FROM cache_metadata").get()!.identity));
  identity.privateAnnotation = "synthetic non-cache addition";
  db.prepare("UPDATE cache_metadata SET identity=?").run(JSON.stringify(identity)); db.close();
  const before = fingerprint(a.databasePath);
  assert.equal(a.cli(["index", "--rebuild", "--json"]).status, 2);
  assert.deepEqual(fingerprint(a.databasePath), before);
});

test("invalid clock input fails before allocating cache state or a writer lock", async (t) => {
  const a = createSandbox(t); const { api } = await (await import("../src/resolve-pi.ts")).resolvePiParser();
  await assert.rejects(indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, now: () => new Date(NaN) }, api));
  assert.deepEqual(readdirSync(a.atlasHome), []);
});
