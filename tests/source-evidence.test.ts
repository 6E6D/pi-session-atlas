import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { showSession } from "../src/queries/show.ts";
import { cite } from "../src/queries/cite.ts";
import { linearLegacyV1Fixture, toJsonl } from "./fixtures.ts";
import { createArchive, envelope, errorEnvelope, fingerprint, userSession } from "./prepublication-support.ts";

const legacyId = (index: number) => `v1-${createHash("sha256").update(`fixture-legacy-v1:${index}`).digest("hex").slice(0, 12)}`;

test("legacy record positions survive blank, malformed and unsupported lines; raw compaction stays original", async (t) => {
  const entries = linearLegacyV1Fixture();
  const compaction = { type: "compaction", timestamp: "2025-01-01T00:00:03Z", firstKeptEntryIndex: 1, summary: "legacy summary", retainedTail: [{ role: "user", content: "not a second record" }] };
  const archive = await createArchive(t, { files: { "legacy.jsonl": entries } });
  const file = join(archive.sessionsDirectory, "legacy.jsonl");
  writeFileSync(file, [JSON.stringify(entries[0]), "", JSON.stringify(entries[1]), "{malformed", "7", JSON.stringify(entries[2]), JSON.stringify(compaction), ""].join("\r\n"));
  const indexed = await indexSessions({ databasePath: archive.databasePath, sessionsDirectory: archive.sessionsDirectory, rebuild: true }, archive.parser);
  assert.deepEqual(indexed.failures, []);
  const before = fingerprint(file);
  const db = openQueryDatabase(archive.databasePath);
  try {
    for (const [position, raw] of [[1, entries[1]], [3, entries[2]], [4, compaction]] as const) {
      const result = await showSession(db, "fixture-legacy-v1", legacyId(position), 0);
      assert.equal(result.entries[0]?.id, legacyId(position));
      assert.deepEqual(result.entries[0]?.raw, raw);
      assert.equal(cite(db, "fixture-legacy-v1", legacyId(position)).entryId, legacyId(position));
    }
    const bounded = await showSession(db, "fixture-legacy-v1", legacyId(3), 1);
    assert.deepEqual(bounded.entries.map((e) => e.id), [legacyId(1), legacyId(3), legacyId(4)]);
    assert.ok(bounded.entries.every((e) => e.raw === undefined));
    assert.deepEqual(fingerprint(file), before);
  } finally { db.close(); }
});

test("v2 migration affects display role but not original raw message", async (t) => {
  const entries = userSession("fixture-v2", ["old custom message"]);
  entries[0]!.version = 2;
  (entries[1]!.message as Record<string, unknown>).role = "hookMessage";
  const archive = await createArchive(t, { files: { "v2.jsonl": entries } });
  const result = archive.cli(["show", "fixture-v2", "00000001", "--context", "0", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const row = envelope(result.stdout, "show", true).results[0] as any;
  assert.equal(row.entries[0].role, "custom");
  assert.deepEqual(row.entries[0].raw, entries[1]);
});

test("verified citations add identity-only evidence; default citations keep their index-only shape", async (t) => {
  for (const entries of [userSession("fixture-modern", ["evidence"]), linearLegacyV1Fixture()]) {
    const archive = await createArchive(t, { files: { "session.jsonl": entries } });
    const id = String(entries[0]!.id);
    const entry = id === "fixture-modern" ? "00000001" : legacyId(1);
    for (const reference of [[id], [id, entry]]) {
      const baseline = archive.cli(["cite", ...reference, "--json"]);
      const original = envelope(baseline.stdout, "cite", true).results[0]!;
      assert.deepEqual(Object.keys(original).sort(), ["citation", "entryId", "sessionUuid", "timestamp"]);
      const verified = archive.cli(["cite", ...reference, "--verify-source", "--json"]);
      assert.equal(verified.status, 0, verified.stderr);
      const { verification, ...same } = envelope(verified.stdout, "cite", true).results[0] as any;
      assert.deepEqual(same, original);
      assert.equal(verification.basis, "source-identity");
      assert.equal(verification.indexState, "metadata-match");
    }
  }
});

test("verification distinguishes missing file, replaced identity, missing entry and unsupported source version", async (t) => {
  for (const kind of ["missing", "identity", "entry", "version", "header"] as const) {
    const entries = userSession("fixture-verification", ["original"]);
    const archive = await createArchive(t, { files: { "session.jsonl": entries } });
    const file = join(archive.sessionsDirectory, "session.jsonl");
    const plain = archive.cli(["cite", "fixture-verification", "00000001", "--json"]);
    if (kind === "missing") unlinkSync(file);
    else {
      if (kind === "identity") entries[0]!.id = "another-session";
      if (kind === "entry") entries[1]!.id = "another-entry";
      if (kind === "version") entries[0]!.version = 999;
      writeFileSync(file, kind === "header" ? "{broken\n" : toJsonl(entries));
    }
    assert.deepEqual(envelope(archive.cli(["cite", "fixture-verification", "00000001", "--json"]).stdout, "cite", true).results, envelope(plain.stdout, "cite", true).results);
    const code = { missing: "SOURCE_NOT_FOUND", identity: "SOURCE_IDENTITY_MISMATCH", entry: "SOURCE_ENTRY_NOT_FOUND", version: "SOURCE_VERSION_UNSUPPORTED", header: "SOURCE_FORMAT_INVALID" }[kind];
    for (const args of [["cite", "--verify-source"], ["show", "--context", "0"]]) {
      const result = archive.cli([...args, "fixture-verification", "00000001", "--json"]);
      assert.equal(result.status, 2);
      assert.equal(errorEnvelope(result.stdout, args[0]!).error?.code, code);
      assert.equal(result.stderr, "");
    }
  }
});

test("changed metadata is explicit in source display and fails strict citation verification", async (t) => {
  const archive = await createArchive(t, { files: { "session.jsonl": userSession("fixture-change", ["original"]) } });
  const file = join(archive.sessionsDirectory, "session.jsonl");
  appendFileSync(file, JSON.stringify({ type: "message", id: "00000002", parentId: "00000001", message: { role: "user", content: "later append" } }) + "\n");
  const before = fingerprint(file);
  const shown = archive.cli(["show", "fixture-change", "00000001", "--json"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal((envelope(shown.stdout, "show", true).results[0] as any).evidence.indexState, "metadata-different");
  const verified = archive.cli(["cite", "fixture-change", "00000001", "--verify-source", "--json"]);
  assert.equal(verified.status, 2);
  assert.equal(errorEnvelope(verified.stdout, "cite").error?.code, "SOURCE_CHANGED");
  assert.deepEqual(fingerprint(file), before);
});

test("modern bounded output marks truncation, excludes image bytes and preserves full/raw values", async (t) => {
  const entries = userSession("fixture-images", ["placeholder", "after"]);
  const text = `line one\n${"image-adjacent text ".repeat(100)}\nlast line`;
  (entries[1]!.message as any).content = [{ type: "text", text }, { type: "image", mimeType: "image/png", data: "synthetic-image-payload" }];
  const archive = await createArchive(t, { files: { "session.jsonl": entries } });
  const db = openQueryDatabase(archive.databasePath);
  try {
    const bounded = await showSession(db, "fixture-images", "00000001", 1);
    assert.equal((bounded.entries[0] as any).textTruncated, true);
    assert.equal((bounded.entries[1] as any).textTruncated, false);
    assert.ok(!JSON.stringify(bounded).includes("synthetic-image-payload"));
    const full = await showSession(db, "fixture-images", "00000001", 0);
    assert.equal(full.entries[0]?.text, `${text}\n[image]`);
    assert.deepEqual(full.entries[0]?.raw, entries[1]);
    assert.equal((full.entries[0] as any).textTruncated, false);
  } finally { db.close(); }
});

test("duplicate source target IDs and multiple headers cannot be verified or displayed as unique", async (t) => {
  for (const kind of ["entry", "header"]) {
    const entries = userSession("fixture-duplicate", ["original"]);
    const archive = await createArchive(t, { files: { "session.jsonl": entries } });
    appendFileSync(join(archive.sessionsDirectory, "session.jsonl"), JSON.stringify(entries[kind === "header" ? 0 : 1]) + "\n");
    const result = archive.cli(["show", "fixture-duplicate", "00000001", "--context", "0", "--json"]);
    assert.equal(result.status, 2);
    assert.equal(errorEnvelope(result.stdout, "show").error?.code, kind === "header" ? "SOURCE_FORMAT_INVALID" : "SOURCE_ENTRY_AMBIGUOUS");
  }
});

test("legacy materialization has a hard byte bound and does not recommend reindexing a size limit", async (t) => {
  const archive = await createArchive(t, { files: { "legacy.jsonl": linearLegacyV1Fixture() } });
  const source = join(archive.sessionsDirectory, "legacy.jsonl");
  truncateSync(source, 16 * 1024 * 1024 + 1);
  const result = archive.cli(["show", "fixture-legacy-v1", legacyId(1), "--context", "0", "--json"]);
  assert.equal(result.status, 2);
  const error = errorEnvelope(result.stdout, "show").error!;
  assert.equal(error.code, "SOURCE_LEGACY_LIMIT");
  assert.doesNotMatch(error.message, /reindex/i);
});

test("human source display exposes changed metadata and skipped-record warnings", async (t) => {
  const archive = await createArchive(t);
  appendFileSync(join(archive.sessionsDirectory, "fixture.jsonl"), "{broken\n");
  const result = archive.cli(["show", "fixture-session-alpha", "00000001"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Source note: metadata-different/);
  assert.match(result.stdout, /1 malformed or unusable source record/);
  assert.equal(result.stderr, "");
});

test("source query context validation happens before source access", async (t) => {
  const archive = await createArchive(t);
  const db = openQueryDatabase(archive.databasePath);
  try {
    for (const context of [-1, 1.5, 101, NaN]) {
      await assert.rejects(showSession(db, "not-indexed", undefined, context), (error: any) => error.name === "UsageError");
    }
  } finally { db.close(); }
});

test("modern JSONL acceptance matches whole-source trimming without accepting internal BOM records", async (t) => {
  const entries = userSession("fixture-trimming", ["first", "last"]);
  const archive = await createArchive(t, { files: { "session.jsonl": entries } });
  const file = join(archive.sessionsDirectory, "session.jsonl");
  const unparseable = { type: "message", id: "not-a-valid-record", message: { role: "user", content: "internal BOM" } };
  const content = `\uFEFF${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n\uFEFF${JSON.stringify(unparseable)}\n${JSON.stringify(entries[2])}\uFEFF\n\n`;
  writeFileSync(file, content);
  const indexed = await indexSessions({ databasePath: archive.databasePath, sessionsDirectory: archive.sessionsDirectory, rebuild: true }, archive.parser);
  assert.deepEqual(indexed.failures, []);
  const db = openQueryDatabase(archive.databasePath);
  try {
    const result = await showSession(db, "fixture-trimming", "00000001", 3);
    assert.deepEqual(result.entries.map((e) => e.id), ["00000001", "00000002"]);
    assert.equal(result.evidence.skippedRecords, 1);
  } finally { db.close(); }
});
