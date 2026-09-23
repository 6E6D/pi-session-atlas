import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { extractSession } from "../src/extract.ts";
import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase, resolveSession } from "../src/query-db.ts";
import { showSession } from "../src/queries/show.ts";
import { verifyCitation } from "../src/queries/cite.ts";
import { inspectSource, LEGACY_SOURCE_MAX_BYTES, LEGACY_SOURCE_MAX_RECORDS } from "../src/source.ts";
import { linearLegacyV1Fixture, toJsonl } from "./fixtures.ts";
import { createArchive, envelope, errorEnvelope, fingerprint, userSession } from "./prepublication-support.ts";

const code = (expected: string) => (error: any) => error?.code === expected;

test("legacy null/array records retain parsed positions, omitted v1 version works and rebuild IDs agree", async (t) => {
  const entries = linearLegacyV1Fixture();
  delete entries[0]!.version;
  const archive = await createArchive(t, { files: { "legacy.jsonl": entries } });
  const file = join(archive.sessionsDirectory, "legacy.jsonl");
  const content = [entries[0], entries[1], null, [], entries[2]].map((entry) => JSON.stringify(entry)).join("\n");
  fs.writeFileSync(file, content);
  const options = { databasePath: archive.databasePath, sessionsDirectory: archive.sessionsDirectory, rebuild: true };
  for (let run = 0; run < 2; run++) {
    assert.deepEqual((await indexSessions(options, archive.parser)).failures, []);
    const expected = extractSession(content, file, archive.parser);
    const db = openQueryDatabase(archive.databasePath);
    try {
      const result = await showSession(db, "fixture-legacy-v1", expected.entries[1]!.id, 0);
      assert.deepEqual(result.entries[0]?.raw, entries[2]);
      assert.equal(result.evidence.skippedRecords, 2);
      assert.equal(result.entries[0]?.parentId, expected.entries[0]?.id);
    } finally { db.close(); }
  }
});

test("UTF-8 split across read chunks, CRLF and a missing final newline preserve full source values", async (t) => {
  const entries = userSession("fixture-utf8", ["PAYLOAD", "last"]);
  const prefix = entries.map((entry) => JSON.stringify(entry)).join("\r\n").split("PAYLOAD")[0]!;
  const text = `${"x".repeat(65_535 - Buffer.byteLength(prefix))}🙂café\n二行\n${"tail".repeat(17_000)}`;
  (entries[1]!.message as any).content = text;
  const archive = await createArchive(t, { files: { "utf8.jsonl": entries } });
  const file = join(archive.sessionsDirectory, "utf8.jsonl");
  const bytes = Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\r\n"));
  assert.equal(bytes.indexOf(Buffer.from("🙂")), 65_535, "four-byte character must straddle a read boundary");
  fs.writeFileSync(file, bytes);
  const before = fingerprint(file);
  const db = openQueryDatabase(archive.databasePath);
  try {
    const shown = await showSession(db, "fixture-utf8", "00000001", 0);
    assert.equal(shown.entries[0]?.text, text);
    assert.deepEqual(shown.entries[0]?.raw, entries[1]);
    assert.deepEqual(fingerprint(file), before);
  } finally { db.close(); }
});

test("modern source larger than legacy cap stays streaming and retains only the requested output window", async (t) => {
  const archive = await createArchive(t, { files: { "modern.jsonl": userSession("fixture-stream", ["target"]) } });
  const file = join(archive.sessionsDirectory, "modern.jsonl");
  for (let i = 0; i < 300; i++) fs.appendFileSync(file, JSON.stringify({ type: "message", id: `extra-${i}`, message: { role: "user", content: "s".repeat(64 * 1024) } }) + "\n");
  assert.ok(fs.statSync(file).size > LEGACY_SOURCE_MAX_BYTES);
  const before = fingerprint(file);
  const readFile = fsp.readFile;
  const readFileSync = fs.readFileSync;
  const open = fsp.open;
  let readCalls = 0;
  let largestRead = 0;
  const syncMock = t.mock.method(fs, "readFileSync", (...args: any[]) => {
    assert.notEqual(String(args[0]), file, "modern source must not be read as one complete string");
    return Reflect.apply(readFileSync, fs, args);
  });
  const asyncMock = t.mock.method(fsp, "readFile", (...args: any[]) => {
    assert.notEqual(String(args[0]), file, "modern source must not be read as one complete string");
    return Reflect.apply(readFile, fsp, args);
  });
  const openMock = t.mock.method(fsp, "open", async (...args: any[]) => {
    const handle = await Reflect.apply(open, fsp, args);
    if (String(args[0]) === file) {
      handle.readFile = async () => { throw new Error("whole-file materialization is forbidden for modern display"); };
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs: any[]) => {
        readCalls++;
        largestRead = Math.max(largestRead, readArgs[2]);
        return Reflect.apply(read, handle, readArgs);
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  const db = openQueryDatabase(archive.databasePath);
  try {
    const shown = await showSession(db, "fixture-stream", "00000001", 1);
    assert.equal(shown.evidence.reader, "streaming");
    assert.equal(shown.entries.length, 2);
    assert.ok(JSON.stringify(shown).length < 3_000);
    assert.ok(readCalls > 300);
    assert.ok(largestRead <= 64 * 1024);
  } finally {
    db.close(); syncMock.mock.restore(); asyncMock.mock.restore(); openMock.mock.restore(); syncBuiltinESMExports();
  }
  assert.deepEqual(fingerprint(file), before);
});

test("legacy parser incompatibility and migration failure are distinct from missing source", async (t) => {
  const archive = await createArchive(t, { files: { "legacy.jsonl": linearLegacyV1Fixture() } });
  const db = openQueryDatabase(archive.databasePath);
  try {
    for (const parser of [
      { ...archive.parser, CURRENT_SESSION_VERSION: 2 },
      { ...archive.parser, migrateSessionEntries() { throw new Error("synthetic migration mismatch"); } },
      { ...archive.parser, migrateSessionEntries(entries: unknown[]) { entries.reverse(); } },
    ]) await assert.rejects(showSession(db, "fixture-legacy-v1", undefined, 0, { parser }), code("SOURCE_PARSER_INCOMPATIBLE"));
  } finally { db.close(); }
});

test("a parser that rewrites raw values before migration cannot label them original source", async (t) => {
  const archive = await createArchive(t, { files: { "legacy.jsonl": linearLegacyV1Fixture() } });
  const db = openQueryDatabase(archive.databasePath);
  const parser = { ...archive.parser, parseSessionEntries(content: string) {
    const parsed = archive.parser.parseSessionEntries(content);
    (parsed[1] as any).message.content = "rewritten by parser";
    return parsed;
  } };
  try { await assert.rejects(showSession(db, "fixture-legacy-v1", undefined, 0, { parser }), code("SOURCE_PARSER_INCOMPATIBLE")); }
  finally { db.close(); }
});

test("legacy record-count ceiling is independent of byte ceiling", async (t) => {
  const archive = await createArchive(t, { files: { "legacy.jsonl": linearLegacyV1Fixture() } });
  const file = join(archive.sessionsDirectory, "legacy.jsonl");
  fs.appendFileSync(file, "7\n".repeat(LEGACY_SOURCE_MAX_RECORDS));
  assert.ok(fs.statSync(file).size < LEGACY_SOURCE_MAX_BYTES);
  const result = archive.cli(["show", "fixture-legacy-v1", "--context", "0", "--json"]);
  assert.equal(result.status, 2);
  assert.equal(errorEnvelope(result.stdout, "show").error?.code, "SOURCE_LEGACY_LIMIT");
});

test("missing catalog metadata is not a verified citation", async (t) => {
  const archive = await createArchive(t);
  const writer = new DatabaseSync(archive.databasePath);
  writer.exec("DELETE FROM catalog"); writer.close();
  const db = openQueryDatabase(archive.databasePath);
  try {
    assert.equal((await showSession(db, "fixture-session-alpha", "00000001", 0)).evidence.indexState, "not-catalogued");
    await assert.rejects(verifyCitation(db, "fixture-session-alpha", "00000001"), code("SOURCE_CHANGED"));
  } finally { db.close(); }
});

test("append, same-path replacement and disappearance during a read never return verified evidence", async (t) => {
  for (const mutation of ["append", "replace", "remove"]) {
    const entries = userSession("fixture-race", ["target"]);
    const archive = await createArchive(t, { files: { "session.jsonl": entries } });
    const file = join(archive.sessionsDirectory, "session.jsonl");
    const db = openQueryDatabase(archive.databasePath);
    try {
      await assert.rejects(inspectSource(db, resolveSession(db, "fixture-race"), "00000001", () => {
        if (mutation === "append") fs.appendFileSync(file, "\n");
        if (mutation === "replace") { fs.renameSync(file, file + ".retained"); fs.writeFileSync(file, toJsonl(entries)); }
        if (mutation === "remove") fs.unlinkSync(file);
      }), code("SOURCE_CHANGED_DURING_READ"));
    } finally { db.close(); }
  }
});

test("matching size/mtime and identity do not claim content-hash equivalence", async (t) => {
  const entries = userSession("fixture-metadata-only", ["alpha"]);
  const archive = await createArchive(t, { files: { "session.jsonl": entries } });
  const file = join(archive.sessionsDirectory, "session.jsonl");
  const fixed = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(file, fixed, fixed);
  await indexSessions({ databasePath: archive.databasePath, sessionsDirectory: archive.sessionsDirectory }, archive.parser);
  const before = fingerprint(file);
  (entries[1]!.message as any).content = "bravo";
  fs.writeFileSync(file, toJsonl(entries)); fs.utimesSync(file, fixed, fixed);
  const after = fingerprint(file);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.notEqual(after.sha256, before.sha256);
  const result = archive.cli(["cite", "fixture-metadata-only", "00000001", "--verify-source", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((envelope(result.stdout, "cite", true).results[0] as any).verification.basis, "source-identity");
});

test("unreadable and nonregular source paths fail promptly with distinct codes", async (t) => {
  for (const kind of ["permission", "directory", "fifo"]) {
    const archive = await createArchive(t);
    const file = join(archive.sessionsDirectory, "fixture.jsonl");
    if (kind === "permission") fs.chmodSync(file, 0);
    else { fs.renameSync(file, file + ".retained"); if (kind === "directory") fs.mkdirSync(file); else execFileSync("mkfifo", [file], { env: archive.env }); }
    const result = archive.cli(["show", "fixture-session-alpha", "00000001", "--json"]);
    assert.equal(result.status, 2);
    assert.equal(errorEnvelope(result.stdout, "show").error?.code, kind === "permission" ? "SOURCE_UNREADABLE" : "SOURCE_NOT_REGULAR");
  }
});

test("source descriptors close after success, failed lookup and visitor failure", async (t) => {
  const archive = await createArchive(t);
  const file = join(archive.sessionsDirectory, "fixture.jsonl");
  const descriptors = () => fs.readdirSync("/proc/self/fd").filter((fd) => {
    try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === file; } catch { return false; }
  });
  const db = openQueryDatabase(archive.databasePath);
  try {
    for (let i = 0; i < 10; i++) {
      await showSession(db, "fixture-session-alpha", "00000001", 1);
      await assert.rejects(inspectSource(db, resolveSession(db, "fixture-session-alpha"), "missing"), code("SOURCE_ENTRY_NOT_FOUND"));
      await assert.rejects(inspectSource(db, resolveSession(db, "fixture-session-alpha"), "00000001", () => { throw new Error("synthetic visitor failure"); }), /synthetic visitor failure/);
      assert.deepEqual(descriptors(), []);
    }
  } finally { db.close(); }
});
