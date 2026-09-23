import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { recognizeCache } from "../src/cache.ts";
import { extractSession } from "../src/extract.ts";
import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { findBranches } from "../src/queries/branches.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { linearLegacyV1Fixture, toJsonl, writeFixture, type FixtureEntry } from "./fixtures.ts";
import { createArchive, createSandbox, fingerprint, userSession } from "./prepublication-support.ts";

type Archive = ReturnType<typeof createSandbox>;
function query(a: Archive, args: string[], env?: NodeJS.ProcessEnv): any {
  const result = a.cli([...args, "--json"], { env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout); assert.equal(payload.ok, true); return payload;
}
function clockSession(uuid: string, times: string[], header = "2026-08-01T00:00:00.000Z"): FixtureEntry[] {
  return [{ type: "session", version: 3, id: uuid, cwd: "/workspace/clock", timestamp: header },
    ...times.map((timestamp, i) => ({ type: "message", id: String(i + 1).padStart(8, "0"),
      parentId: i ? String(i).padStart(8, "0") : null, timestamp,
      message: { role: "assistant", model: "fixture-clock", provider: "fixture-provider", stopReason: "error",
        errorMessage: "synthetic clock failure", usage: { input: 1, output: 1, cost: { total: i ? 1 : 10 } },
        content: [{ type: "text", text: "synthetic time oracle" },
          { type: "toolCall", id: `clock-${i}`, name: "bash", arguments: { command: `clock-step ${i}` } },
          { type: "toolCall", id: `read-${i}`, name: "read", arguments: { path: "notes.md" } }] } }))];
}

// Promoted R6 cases retain the same instants, costs and canonical controls as
// the immutable explicit-run final-review probes; no TODO or reduced assertion.
for (const variant of ["offset", "fraction-width"] as const) test(`R6 chronological window: ${variant}`, async t => {
  const times = variant === "offset"
    ? ["2026-09-05T01:30:00+02:00", "2026-09-04T23:00:00-02:00"]
    : ["2026-09-05T00:00:00Z", "2026-09-05T00:00:01Z"];
  const since = variant === "offset" ? "2026-09-05" : "2026-09-05T00:00:00.500Z";
  const entries = clockSession(`fixture-iso-${variant}`, times);
  const a = await createArchive(t, { files: { "source.jsonl": entries } });
  const before = fingerprint(join(a.sessionsDirectory, "source.jsonl")), cache = fingerprint(a.databasePath);
  const result = query(a, ["report", "cost", "--since", since, "--by", "month"]);
  const expected = times.reduce((cost, ts, i) => cost + (Date.parse(ts) >= Date.parse(since) ? i ? 1 : 10 : 0), 0);
  const control = await createArchive(t, { files: { "source.jsonl": entries.map(e => ({ ...e, timestamp: new Date(String(e.timestamp)).toISOString() })) } });
  assert.equal(query(control, ["report", "cost", "--since", since]).results[0].totals.cost, expected);
  assert.deepEqual(query(control, ["search", "synthetic time oracle", "--exact", "--since", since]).results.map((e: any) => e.entryId), ["00000002"]);
  assert.equal(result.results[0].totals.cost, expected);
  assert.equal(result.cache.lastAttempt.parseWarnings, 0); assert.deepEqual(result.cache.unverifiedFiles, []);
  for (const mode of [[], ["--exact"], ["--fts"]]) {
    assert.deepEqual(query(a, ["search", "synthetic time oracle", ...mode, "--since", since]).results.map((e: any) => e.entryId), ["00000002"]);
  }
  assert.deepEqual(fingerprint(join(a.sessionsDirectory, "source.jsonl")), before);
  assert.deepEqual(fingerprint(a.databasePath), cache);
});

test("source normalization covers offsets, fractional widths, leap dates and four-digit year endpoints", async t => {
  const a = createSandbox(t), parser = (await resolvePiParser()).api;
  const pairs: Array<[string, string]> = [
    ["2026-09-05T01:30:00+02:00", "2026-09-04T23:30:00.000Z"],
    ["2026-09-04T23:00:00-02:00", "2026-09-05T01:00:00.000Z"],
    ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"],
    ["2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.100Z"],
    ["2026-01-01T00:00:00.01+00:00", "2026-01-01T00:00:00.010Z"],
    ["2026-01-01T00:00:00.001-00:00", "2026-01-01T00:00:00.001Z"],
    ["2026-01-01T00:00:00.123456789Z", "2026-01-01T00:00:00.123Z"],
    ["1969-12-31T23:59:59.9999Z", "1969-12-31T23:59:59.999Z"],
    ["2024-03-01T00:30:00+01:00", "2024-02-29T23:30:00.000Z"],
    ["2000-02-29T23:59:59.999Z", "2000-02-29T23:59:59.999Z"],
    ["0000-02-29T00:00:00Z", "0000-02-29T00:00:00.000Z"],
    ["0099-01-01T00:00:00Z", "0099-01-01T00:00:00.000Z"],
    ["0000-01-01T00:00:00Z", "0000-01-01T00:00:00.000Z"],
    ["9999-12-31T23:59:59.9999Z", "9999-12-31T23:59:59.999Z"],
    ["2026-09-05T00:00:00+05:45", "2026-09-04T18:15:00.000Z"],
  ];
  for (const [source, expected] of pairs) {
    const entries = userSession("fixture-normalize", ["unchanged full text"]);
    for (const entry of entries) entry.timestamp = source;
    const content = toJsonl(entries), result = extractSession(content, join(a.sessionsDirectory, "source.jsonl"), parser);
    assert.equal(result.created, expected, source); assert.equal(result.lastActivity, expected, source);
    assert.equal(result.entries[0]!.timestamp, expected, source); assert.equal(result.texts[0]!.timestamp, expected, source);
    assert.equal(toJsonl(entries), content); assert.equal(result.texts[0]!.content, "unchanged full text");
  }
});

test("present invalid source timestamps fail instead of fallback, local-time guessing or calendar rollover", async t => {
  const a = createSandbox(t), parser = (await resolvePiParser()).api;
  const invalid: unknown[] = [null, false, 17, {}, [], "", "not-a-date", "2026-09-05", "2026-09-05T00:00:00",
    "2026-09-05T00:00Z", "2026-09-05T24:00:00Z", "2026-09-05T23:60:00Z", "2026-09-05T23:59:60Z",
    "2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "0000-02-30T00:00:00Z", "2026-04-31T00:00:00Z",
    "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z", "2026-01-32T00:00:00Z",
    "2026-09-05T00:00:00+24:00", "2026-09-05T00:00:00+01:60", "2026-09-05T00:00:00+0200",
    "2026-09-05t00:00:00z", "2026-09-05T00:00:00.Z", "2026-09-05T00:00:00,1Z",
    "2026-09-05T00:00:00Z\n", " 2026-09-05T00:00:00Z", "2026-09-05T00:00:00Z ",
    "0000-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01", "+010000-01-01T00:00:00Z"];
  for (const value of invalid) for (const position of [0, 1]) {
    const entries = userSession("fixture-invalid-time", ["preserved"]); entries[position]!.timestamp = value;
    assert.throws(() => extractSession(toJsonl(entries), join(a.sessionsDirectory, "source.jsonl"), parser), /timestamp/i, `${position}:${JSON.stringify(value)}`);
  }
});

test("only absent entry timestamps inherit the validated header; invalid time is not hidden by an omitted ID", async t => {
  const a = createSandbox(t), parser = (await resolvePiParser()).api;
  const entries = userSession("fixture-absent-time", ["preserved"]);
  entries[0]!.timestamp = "2026-09-05T01:30:00+02:00"; delete entries[1]!.timestamp;
  const extract = () => extractSession(toJsonl(entries), join(a.sessionsDirectory, "source.jsonl"), parser);
  assert.equal(extract().entries[0]!.timestamp, "2026-09-04T23:30:00.000Z");
  delete entries[1]!.id; entries[1]!.timestamp = "invalid"; assert.throws(extract, /timestamp/i);
  delete entries[0]!.timestamp; assert.throws(extract, /timestamp/i);
});

test("UTC month groups, last activity and indexed citations coexist with original source-backed timestamps/raw values", async t => {
  const entries = clockSession("fixture-month", ["2026-09-01T01:30:00+02:00", "2026-08-31T23:00:00-02:00"], "2026-09-01T01:00:00+02:00");
  const a = await createArchive(t, { files: { "source.jsonl": entries } }), source = join(a.sessionsDirectory, "source.jsonl");
  const before = fingerprint(source), cache = fingerprint(a.databasePath);
  const session = query(a, ["sessions"]).results[0];
  assert.equal(session.created, "2026-08-31T23:00:00.000Z"); assert.equal(session.lastActivity, "2026-09-01T01:00:00.000Z");
  const report = query(a, ["report", "cost", "--by", "month"]).results[0];
  assert.deepEqual(Object.fromEntries(report.groups.map((g: any) => [g.key, g.cost])), { "2026-08": 10, "2026-09": 1 });
  const cite = query(a, ["cite", "fixture-month", "00000002", "--verify-source"]).results[0];
  assert.equal(cite.timestamp, "2026-09-01T01:00:00.000Z"); assert.match(cite.citation, /\(2026-08-31\)/);
  for (const context of ["0", "1"]) {
    const shown = query(a, ["show", "fixture-month", "00000002", "--context", context]).results[0].entries.find((e: any) => e.id === "00000002");
    assert.equal(shown.timestamp, entries[2]!.timestamp);
    if (context === "0") assert.deepEqual(shown.raw, entries[2]); else assert.equal(shown.raw, undefined);
  }
  assert.deepEqual(fingerprint(source), before); assert.deepEqual(fingerprint(a.databasePath), cache);
});

test("all date-query families share chronological inclusion and ordering across UTC midnight", async t => {
  const times = ["2026-09-01T01:30:00+02:00", "2026-08-31T23:00:00-02:00"];
  const a = await createArchive(t, { files: {
    "early.jsonl": clockSession("fixture-early", [times[0]!], times[0]),
    "late.jsonl": clockSession("fixture-late", [times[1]!], times[1]),
  } });
  const cache = fingerprint(a.databasePath);
  for (const args of [["sessions"], ["unfinished"], ["trace", "--file", "notes.md"], ["cmd", "clock-step"]]) {
    const all = query(a, args).results;
    assert.deepEqual(all.map((r: any) => r.uuid ?? r.sessionUuid), ["fixture-late", "fixture-early"], args.join(" "));
    const selected = query(a, [...args, "--since", "2026-09-01"]).results;
    assert.deepEqual(selected.map((r: any) => r.uuid ?? r.sessionUuid), ["fixture-late"], args.join(" "));
  }
  for (const by of ["tool", "signature"]) {
    const errors = query(a, ["report", "errors", "--by", by, "--since", "2026-09-01"]).results[0];
    assert.equal(errors.assistantErrors, 1); assert.equal(errors.recent[0].sessionUuid, "fixture-late");
    assert.equal(errors.recent[0].timestamp, "2026-09-01T01:00:00.000Z");
  }
  for (const args of [["cmd", "clock-step"], ["search", "synthetic time oracle", "--exact"]]) {
    for (const bound of ["2026-09-01T01:00:00Z", "2026-09-01T03:00:00+02:00"]) {
      assert.deepEqual(query(a, [...args, "--since", bound, "--until", bound]).results.map((r: any) => r.sessionUuid), ["fixture-late"]);
    }
    assert.deepEqual(query(a, [...args, "--until", "2026-08-31"]).results.map((r: any) => r.sessionUuid), ["fixture-early"]);
  }
  assert.deepEqual(fingerprint(a.databasePath), cache);
});

test("branch ordering/age and automatic show target use normalized index time, not raw spelling", async t => {
  const entries = userSession("fixture-clock-tree", ["root", "earlier tip", "later tip"]);
  entries[0]!.timestamp = "2026-08-31T20:00:00Z";
  entries[1]!.timestamp = "2026-09-01T01:30:00+02:00";
  entries[2]!.timestamp = "2026-09-01T02:00:00+02:00";
  entries[3]!.timestamp = "2026-08-31T23:00:00-02:00"; entries[3]!.parentId = "00000001";
  const a = await createArchive(t, { files: { "source.jsonl": entries } });
  const db = openQueryDatabase(a.databasePath);
  try {
    const branches = findBranches(db, { limit: 10, now: new Date("2026-09-02T00:00:00Z") });
    assert.deepEqual(branches.map(b => [b.tipEntryId, b.tipTimestamp, b.ageDays]), [["00000003", "2026-09-01T01:00:00.000Z", 0], ["00000002", "2026-09-01T00:00:00.000Z", 1]]);
    assert.equal(branches[0]!.branchPointTimestamp, "2026-08-31T23:30:00.000Z");
  } finally { db.close(); }
  assert.equal(query(a, ["show", "fixture-clock-tree", "--context", "0"]).results[0].targetEntryId, "00000003");
});

test("query bounds outside four-digit UTC years fail as usage before cache access, while endpoints and submilliseconds work", async t => {
  const a = createSandbox(t);
  for (const bound of ["+010000-01-01T00:00:00Z", "-000001-12-31T23:59:59Z", "0000-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01"]) {
    for (const args of [["search", "text", "--since"], ["cmd", "text", "--until"], ["report", "cost", "--since"]]) {
      const r = a.cli([...args, bound, "--json"]); assert.equal(r.status, 1, r.stdout);
      assert.equal(JSON.parse(r.stdout).error.code, "USAGE_ERROR"); assert.equal(existsSync(a.databasePath), false);
    }
  }
  const b = await createArchive(t, { files: { "source.jsonl": clockSession("fixture-fraction-bound", ["2026-09-01T00:00:00.123999Z"]) } });
  assert.equal(query(b, ["cmd", "clock-step", "--since", "2026-09-01T00:00:00.123999Z", "--until", "2026-09-01T00:00:00.1231Z"]).results.length, 1);
  assert.equal(query(b, ["search", "synthetic time oracle", "--exact", "--since", "0000-01-01", "--until", "9999-12-31"]).results.length, 1);
});

test("source interpretation is independent of process timezone and does not accept timezone-free input", t => {
  for (const tz of ["UTC", "Pacific/Honolulu", "Asia/Kathmandu"]) {
    const a = createSandbox(t), entries = clockSession("fixture-timezone", ["2026-09-01T00:00:00+05:45"]);
    const file = writeFixture(a.sessionsDirectory, "source.jsonl", entries), before = fingerprint(file);
    const indexed = query(a, ["index"], { TZ: tz }); assert.equal(indexed.results[0].coverage.identity.extractionVersion, 4);
    assert.equal(query(a, ["cite", "fixture-timezone", "00000001"], { TZ: tz }).results[0].timestamp, "2026-08-31T18:15:00.000Z");
    assert.deepEqual(fingerprint(file), before);
    entries[1]!.timestamp = "2026-09-01T00:00:00"; writeFixture(a.sessionsDirectory, "source.jsonl", entries);
    const invalid = a.cli(["index", "--json"], { env: { TZ: tz } }); assert.equal(invalid.status, 2);
    assert.equal(JSON.parse(invalid.stdout).results[0].failures.length, 1);
  }
});

test("invalid changed-source time retains old rows with uncertainty, without advancing success or changing sources", async t => {
  const entries = clockSession("fixture-invalid-refresh", ["2026-09-01T00:00:00Z"]);
  const a = await createArchive(t, { files: { "source.jsonl": entries } });
  const success = recognizeCache(a.databasePath)!.coverage!.lastSuccessfulScan;
  entries[1]!.timestamp = null; const file = writeFixture(a.sessionsDirectory, "source.jsonl", entries), before = fingerprint(file);
  const r = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory }, a.parser);
  assert.equal(r.committed, true); assert.equal(r.failures.length, 1); assert.match(r.failures[0]!.message, /timestamp/);
  assert.equal(r.coverage!.lastSuccessfulScan, success); assert.equal(r.coverage!.unverifiedFiles.length, 1);
  assert.equal(query(a, ["search", "synthetic time oracle", "--exact"]).results.length, 1);
  assert.equal(a.cli(["cite", "fixture-invalid-refresh", "00000001", "--verify-source", "--json"]).status, 2);
  assert.deepEqual(fingerprint(file), before);
});

// Test-only reconstruction of the known v4/v1 interpretation: original time
// spellings and its lexicographic last-activity rule, not merely a version flip.
function oldInterpretation(a: Archive, entries: FixtureEntry[]): void {
  const db = new DatabaseSync(a.databasePath);
  try {
    const identity = JSON.parse(String(db.prepare("SELECT identity FROM cache_metadata").get()!.identity));
    db.exec("BEGIN"); identity.extractionVersion = 1; delete identity.pathHome;
    db.prepare("UPDATE cache_metadata SET identity=?").run(JSON.stringify(identity));
    const created = String(entries[0]!.timestamp); let last = created;
    for (const entry of entries.slice(1)) {
      const ts = typeof entry.timestamp === "string" ? entry.timestamp : created;
      if (ts > last) last = ts;
      db.prepare("UPDATE entries SET ts=? WHERE id=?").run(ts, String(entry.id));
      db.prepare("UPDATE text_fts SET ts=? WHERE entry_id=?").run(ts, String(entry.id));
    }
    db.prepare("UPDATE sessions SET created=?, last_activity=?").run(created, last); db.exec("COMMIT");
  } finally { db.close(); }
}
function corpus(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(["sessions", "entries", "text_fts", "tool_calls", "catalog"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}
const oldTimes = ["2026-09-05T01:30:00+02:00", "2026-09-04T23:00:00-02:00"];

test("known v4/v1 refuses every query family and incremental reuse without mutation or parser discovery", async t => {
  const entries = clockSession("fixture-old-time", oldTimes), a = await createArchive(t, { files: { "source.jsonl": entries } });
  oldInterpretation(a, entries); const before = fingerprint(a.databasePath), names = readdirSync(a.atlasHome);
  assert.equal(recognizeCache(a.databasePath)!.coverage!.identity.extractionVersion, 1);
  assert.throws(() => openQueryDatabase(a.databasePath), (e: any) => e.code === "CACHE_EXTRACTION_MISMATCH");
  for (const args of [["sessions"], ["search", "synthetic"], ["cmd", "clock-step"], ["trace", "--file", "notes.md"],
    ["branches"], ["unfinished"], ["report", "cost"], ["report", "errors"], ["show", "fixture-old-time", "00000001"],
    ["cite", "fixture-old-time", "00000001"], ["cite", "fixture-old-time", "00000001", "--verify-source"]]) {
    const r = a.cli([...args, "--json"], { env: { ATLAS_PI_PACKAGE: join(a.root, "no-parser") } });
    assert.equal(r.status, 2, args.join(" ")); assert.equal(JSON.parse(r.stdout).error.code, "CACHE_EXTRACTION_MISMATCH");
    assert.deepEqual(fingerprint(a.databasePath), before); assert.deepEqual(readdirSync(a.atlasHome), names);
  }
  const r = a.cli(["index", "--json"]); assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).error.code, "CACHE_IDENTITY_MISMATCH");
  assert.deepEqual(fingerprint(a.databasePath), before); assert.deepEqual(readdirSync(a.atlasHome), names);
});

test("explicit same-root v1 rebuild reparses unchanged files into v4 without schema, source or ID changes", async t => {
  const entries = clockSession("fixture-old-time", oldTimes), a = await createArchive(t, { files: { "source.jsonl": entries } });
  oldInterpretation(a, entries); const source = join(a.sessionsDirectory, "source.jsonl"), before = fingerprint(source);
  const r = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, rebuild: true }, a.parser);
  assert.equal(r.committed, true); assert.equal(r.filesChanged, 1); assert.equal(r.filesUnchanged, 0);
  assert.equal(r.coverage!.identity.schemaVersion, 4); assert.equal(r.coverage!.identity.extractionVersion, 4);
  assert.equal(query(a, ["report", "cost", "--since", "2026-09-05"]).results[0].totals.cost, 1);
  assert.deepEqual(query(a, ["search", "synthetic time oracle", "--exact", "--since", "2026-09-05"]).results.map((e: any) => e.entryId), ["00000002"]);
  assert.deepEqual(fingerprint(source), before);
  const again = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory }, a.parser);
  assert.equal(again.filesChanged, 0); assert.equal(again.filesUnchanged, 1);
});

test("failed v1 replacement retains corpus, identity and prior success; failure metadata does not grant query eligibility", async t => {
  const entries = clockSession("fixture-old-time", oldTimes), a = await createArchive(t, { files: { "source.jsonl": entries } });
  oldInterpretation(a, entries); const before = corpus(a.databasePath), success = recognizeCache(a.databasePath)!.coverage!.lastSuccessfulScan;
  entries[1]!.timestamp = "2026-02-30T00:00:00Z"; const source = writeFixture(a.sessionsDirectory, "source.jsonl", entries), sourceBefore = fingerprint(source);
  const r = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, rebuild: true }, a.parser);
  assert.equal(r.committed, false); assert.equal(r.rebuilt, false); assert.equal(r.coverage!.identity.extractionVersion, 1);
  assert.equal(r.coverage!.lastSuccessfulScan, success); assert.equal(r.coverage!.lastAttempt!.status, "failed");
  assert.deepEqual(corpus(a.databasePath), before); assert.deepEqual(fingerprint(source), sourceBefore);
  const cache = fingerprint(a.databasePath);
  assert.equal(JSON.parse(a.cli(["cite", "fixture-old-time", "00000001", "--json"]).stdout).error.code, "CACHE_EXTRACTION_MISMATCH");
  assert.deepEqual(fingerprint(a.databasePath), cache);
});

test("unknown extraction versions are refused nonmutating even with rebuild/rebind", async t => {
  for (const version of [0, -1, 5, 99, 1.5, "3", null]) {
    const a = await createArchive(t), db = new DatabaseSync(a.databasePath);
    const identity = JSON.parse(String(db.prepare("SELECT identity FROM cache_metadata").get()!.identity)); identity.extractionVersion = version;
    db.prepare("UPDATE cache_metadata SET identity=?").run(JSON.stringify(identity)); db.close();
    const before = fingerprint(a.databasePath), names = readdirSync(a.atlasHome);
    for (const args of [["sessions"], ["index"], ["index", "--rebuild"], ["index", "--rebuild", "--rebind", "--sessions-dir", a.sessionsDirectory]]) {
      const r = a.cli([...args, "--json"]); assert.equal(r.status, 2, String(version));
      assert.equal(JSON.parse(r.stdout).error.code, "CACHE_IDENTITY_INVALID");
      assert.deepEqual(fingerprint(a.databasePath), before); assert.deepEqual(readdirSync(a.atlasHome), names);
    }
  }
});

test("missing originals do not authorize changing an old cache, while current caches retain parser-free index-only cite", async t => {
  for (const old of [true, false]) {
    const entries = clockSession("fixture-missing-time", oldTimes), a = await createArchive(t, { files: { "source.jsonl": entries } });
    if (old) oldInterpretation(a, entries);
    const source = join(a.sessionsDirectory, "source.jsonl"), held = join(a.root, "held.jsonl"); renameSync(source, held);
    const before = fingerprint(a.databasePath), original = fingerprint(held);
    const r = a.cli(["cite", "fixture-missing-time", "00000002", "--json"], { env: { ATLAS_PI_PACKAGE: join(a.root, "no-parser") } });
    assert.equal(r.status, old ? 2 : 0);
    if (old) assert.equal(JSON.parse(r.stdout).error.code, "CACHE_EXTRACTION_MISMATCH");
    else assert.equal(JSON.parse(r.stdout).results[0].timestamp, "2026-09-05T01:00:00.000Z");
    assert.deepEqual(fingerprint(a.databasePath), before); assert.deepEqual(fingerprint(held), original);
  }
});

test("v1/v2/v3 source IDs survive time normalization/rebuild and legacy raw values remain original", async t => {
  for (const version of [1, 2, 3]) {
    const entries = version === 1 ? linearLegacyV1Fixture() : userSession(`fixture-time-v${version}`, ["raw stays raw"]);
    entries[0]!.version = version;
    for (const entry of entries) entry.timestamp = "2026-09-01T01:30:00.12345+02:00";
    const a = await createArchive(t, { files: { "source.jsonl": entries } });
    const source = join(a.sessionsDirectory, "source.jsonl"), before = fingerprint(source);
    const extracted = extractSession(readFileSync(source, "utf8"), source, a.parser), ids = extracted.entries.map(e => e.id);
    const uuid = String(entries[0]!.id), target = ids[0]!;
    if (version === 1) assert.match(target, /^v1-[a-f0-9]{12}$/); else assert.equal(target, "00000001");
    assert.equal(query(a, ["cite", uuid, target]).results[0].timestamp, "2026-08-31T23:30:00.123Z");
    assert.deepEqual(query(a, ["show", uuid, target, "--context", "0"]).results[0].entries[0].raw, entries[1]);
    await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, rebuild: true }, a.parser);
    const db = openQueryDatabase(a.databasePath);
    try { assert.deepEqual(db.prepare("SELECT id FROM entries ORDER BY rowid").all().map(e => e.id), ids); }
    finally { db.close(); }
    assert.deepEqual(fingerprint(source), before);
  }
});

test("v1 failed root replacement and finishing-clock exception retain old interpretation and uncertainty until success", async t => {
  const entries = clockSession("fixture-old-time", oldTimes), a = await createArchive(t, { files: { "source.jsonl": entries } });
  oldInterpretation(a, entries);
  const writer = new DatabaseSync(a.databasePath); writer.prepare("UPDATE cache_metadata SET last_attempt=NULL").run(); writer.close();
  const before = corpus(a.databasePath), initial = recognizeCache(a.databasePath)!.coverage!;
  assert.equal(initial.unverifiedFiles.length, 1);
  const other = join(a.root, "other-root"); mkdirSync(other); writeFileSync(join(other, "bad.jsonl"), "{broken\n");
  const untouched = fingerprint(a.databasePath);
  await assert.rejects(indexSessions({ databasePath: a.databasePath, sessionsDirectory: other, rebuild: true }, a.parser), (e: any) => e.code === "CACHE_REBIND_REQUIRED");
  assert.deepEqual(fingerprint(a.databasePath), untouched);
  const rejected = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: other, rebuild: true, rebind: true }, a.parser);
  assert.equal(rejected.committed, false); assert.deepEqual(rejected.coverage!.identity, initial.identity);
  assert.deepEqual(rejected.coverage!.unverifiedFiles, initial.unverifiedFiles); assert.deepEqual(corpus(a.databasePath), before);
  let clocks = 0;
  await assert.rejects(indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, rebuild: true,
    now: () => { if (++clocks === 3) throw new Error("synthetic finishing-clock failure"); return new Date("2026-09-13T00:00:00Z"); },
  }, a.parser), /finishing-clock failure/);
  const failed = recognizeCache(a.databasePath)!.coverage!;
  assert.deepEqual(failed.identity, initial.identity); assert.equal(failed.lastSuccessfulScan, initial.lastSuccessfulScan);
  assert.deepEqual(corpus(a.databasePath), before); assert.equal(failed.unverifiedFiles.length, 1);
  assert.throws(() => openQueryDatabase(a.databasePath), (e: any) => e.code === "CACHE_EXTRACTION_MISMATCH");
  const repaired = await indexSessions({ databasePath: a.databasePath, sessionsDirectory: a.sessionsDirectory, rebuild: true }, a.parser);
  assert.equal(repaired.committed, true); assert.equal(repaired.coverage!.identity.extractionVersion, 4);
  assert.deepEqual(repaired.coverage!.unverifiedFiles, []);
  assert.equal(query(a, ["report", "cost", "--since", "2026-09-05"]).results[0].totals.cost, 1);
});

test("mixed-offset/fraction sources agree with an independent millisecond oracle across cost groupings and inclusive windows", async t => {
  const base = Date.parse("2026-08-31T20:00:00Z"), offsets = [-720, -210, 0, 345, 840];
  const rows = Array.from({ length: 60 }, (_, i) => {
    const instant = base + i * 20 * 60_000 + [0, 100, 10, 123][i % 4]!;
    const offset = offsets[i % offsets.length]!, local = new Date(instant + offset * 60_000).toISOString();
    const fraction = ["", ".1", ".01", ".123456789"][i % 4]!;
    const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
    return { instant, ts: local.slice(0, 19) + fraction + zone, cost: (i + 1) / 8, model: `fixture-model-${i % 2}`, provider: `fixture-provider-${i % 3}` };
  });
  const entries = clockSession("fixture-oracle-offset", rows.map(r => r.ts));
  rows.forEach((row, i) => {
    const message = entries[i + 1]!.message as any;
    message.model = row.model; message.provider = row.provider; message.usage.cost.total = row.cost;
    assert.equal(Date.parse(row.ts), row.instant, "independent fixture construction must preserve each instant");
  });
  const a = await createArchive(t, { files: { "source.jsonl": entries } }), before = fingerprint(a.databasePath), source = fingerprint(join(a.sessionsDirectory, "source.jsonl"));
  for (const since of [base, rows[12]!.instant, rows[29]!.instant, rows[59]!.instant, rows[59]!.instant + 1]) {
    const selected = rows.filter(r => r.instant >= since), bound = new Date(since).toISOString();
    for (const by of ["month", "project", "model", "provider"] as const) {
      const report = query(a, ["report", "cost", "--since", bound, "--by", by]).results[0];
      const key = (r: typeof rows[number]) => by === "month" ? new Date(r.instant).toISOString().slice(0, 7) : by === "project" ? "/workspace/clock" : r[by];
      const expected = Object.fromEntries([...new Set(selected.map(key))].map(k => [k, selected.filter(r => key(r) === k).reduce((sum, r) => sum + r.cost, 0)]));
      assert.equal(report.totals.cost, selected.reduce((sum, r) => sum + r.cost, 0));
      assert.deepEqual(Object.fromEntries(report.groups.map((g: any) => [g.key, g.cost])), expected);
      assert.equal(report.topSessions.length, selected.length ? 1 : 0);
      if (selected.length) assert.equal(report.topSessions[0].cost, report.totals.cost);
    }
    assert.deepEqual(query(a, ["cmd", "clock-step", "--since", bound, "--limit", "100"]).results.map((r: any) => r.timestamp),
      [...selected].reverse().map(r => new Date(r.instant).toISOString()));
  }
  assert.deepEqual(fingerprint(a.databasePath), before); assert.deepEqual(fingerprint(join(a.sessionsDirectory, "source.jsonl")), source);
});
