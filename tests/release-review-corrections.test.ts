import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { recognizeCache } from "../src/cache.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { cite } from "../src/queries/cite.ts";
import { traceFile } from "../src/queries/trace.ts";
import type { FixtureEntry } from "./fixtures.ts";
import { writeFixture } from "./fixtures.ts";
import { createArchive, createSandbox, envelope, errorEnvelope, fingerprint, userSession } from "./prepublication-support.ts";

function toolSession(uuid: string, path: string, second = 1): FixtureEntry[] {
  const timestamp = (value: number) => `2026-09-08T12:00:${String(value).padStart(2, "0")}.000Z`;
  return [
    { type: "session", version: 3, id: uuid, timestamp: timestamp(0), cwd: "/workspace/synthetic" },
    {
      type: "message",
      id: `${uuid}-entry`,
      parentId: null,
      timestamp: timestamp(second),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: `${uuid}-call`, name: "read", arguments: { path } }],
        stopReason: "stop",
        provider: "synthetic",
        model: "synthetic",
      },
    },
  ];
}

function logicalCache(path: string): unknown {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(
      ["cache_metadata", "catalog", "sessions", "entries", "tool_calls", "text_fts", "file_health"].map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    database.close();
  }
}

test("path-expansion home is explicit cache identity and cannot mix across incremental refreshes", async (t) => {
  const a = createSandbox(t);
  const homeA = join(a.root, "path-home-a");
  const homeB = join(a.root, "path-home-b");
  writeFixture(a.sessionsDirectory, "a.jsonl", toolSession("home-a", "~/alpha.txt"));
  writeFixture(a.sessionsDirectory, "b.jsonl", toolSession("home-b", "~/before.txt", 2));

  let result = a.cli(["index", "--path-home", homeA, "--json"], { env: { HOME: homeA } });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  let indexed = envelope(result.stdout, "index", true).results[0] as any;
  assert.equal(indexed.coverage.identity.extractionVersion, 4);
  assert.equal(indexed.coverage.identity.pathHome, homeA);

  writeFixture(a.sessionsDirectory, "b.jsonl", toolSession("home-b", "~/beta.txt", 3));
  const before = fingerprint(a.databasePath);
  result = a.cli(["index", "--json"], { env: { HOME: homeB } });
  assert.equal(result.status, 2);
  assert.equal(errorEnvelope(result.stdout, "index").error?.code, "CACHE_IDENTITY_MISMATCH");
  assert.deepEqual(fingerprint(a.databasePath), before);

  result = a.cli(["index", "--path-home", homeA, "--json"], { env: { HOME: homeB } });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  let database = openQueryDatabase(a.databasePath);
  try {
    const rows = database.prepare("SELECT session_uuid, path_resolved FROM tool_calls ORDER BY session_uuid").all() as any[];
    assert.deepEqual(rows.map((row) => [row.session_uuid, row.path_resolved]), [
      ["home-a", join(homeA, "alpha.txt")],
      ["home-b", join(homeA, "beta.txt")],
    ]);
  } finally {
    database.close();
  }

  result = a.cli(["index", "--rebuild", "--path-home", homeB, "--json"], { env: { HOME: homeA } });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  indexed = envelope(result.stdout, "index", true).results[0] as any;
  assert.equal(indexed.coverage.identity.pathHome, homeB);
  database = openQueryDatabase(a.databasePath);
  try {
    assert.deepEqual(
      (database.prepare("SELECT path_resolved FROM tool_calls ORDER BY session_uuid").all() as any[]).map((row) => row.path_resolved),
      [join(homeB, "alpha.txt"), join(homeB, "beta.txt")],
    );
  } finally {
    database.close();
  }
});

test("recognized extraction-v2 identity without path home is query-ineligible until explicit rebuild", async (t) => {
  const a = await createArchive(t);
  const writer = new DatabaseSync(a.databasePath);
  try {
    const identity = JSON.parse(String(writer.prepare("SELECT identity FROM cache_metadata").get()!.identity));
    identity.extractionVersion = 2;
    delete identity.pathHome;
    writer.prepare("UPDATE cache_metadata SET identity = ?").run(JSON.stringify(identity));
  } finally {
    writer.close();
  }
  const recognized = recognizeCache(a.databasePath)!.coverage!.identity;
  assert.equal(recognized.extractionVersion, 2);
  assert.equal(recognized.pathHome, undefined);
  const before = fingerprint(a.databasePath);
  let result = a.cli(["sessions", "--json"]);
  assert.equal(result.status, 2);
  assert.equal(errorEnvelope(result.stdout, "sessions").error?.code, "CACHE_EXTRACTION_MISMATCH");
  assert.deepEqual(fingerprint(a.databasePath), before);
  result = a.cli(["index", "--json"]);
  assert.equal(result.status, 2);
  assert.equal(errorEnvelope(result.stdout, "index").error?.code, "CACHE_IDENTITY_MISMATCH");
  assert.deepEqual(fingerprint(a.databasePath), before);
  result = a.cli(["index", "--rebuild", "--json"]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const identity = (envelope(result.stdout, "index", true).results[0] as any).coverage.identity;
  assert.equal(identity.extractionVersion, 4);
  assert.equal(identity.pathHome, a.env.HOME);
});

test("session and entry references use exact case-sensitive literal prefixes", async (t) => {
  const percent = userSession("literal%session", ["percent entry"]);
  percent[1]!.id = "entry%one";
  const underscore = userSession("literal_session", ["underscore entry"]);
  underscore[1]!.id = "entry_one";
  const upper = userSession("CaseSession", ["case entry"]);
  const a = await createArchive(t, { files: { "percent.jsonl": percent, "underscore.jsonl": underscore, "upper.jsonl": upper } });
  const database = openQueryDatabase(a.databasePath);
  try {
    assert.equal(cite(database, "literal%", "entry%").sessionUuid, "literal%session");
    assert.equal(cite(database, "literal_", "entry_").sessionUuid, "literal_session");
    assert.throws(() => cite(database, "%"), (error: any) => error.code === "SESSION_NOT_FOUND");
    assert.throws(() => cite(database, "literal%session", "%"), (error: any) => error.code === "ENTRY_NOT_FOUND");
    assert.throws(() => cite(database, "casesession"), (error: any) => error.code === "SESSION_NOT_FOUND");
    assert.throws(() => cite(database, ""), (error: any) => error.code === "SESSION_NOT_FOUND");
  } finally {
    database.close();
  }
});

test("CLI date bounds reject zone-free timestamps independently of process timezone", async (t) => {
  const a = await createArchive(t, { files: { "source.jsonl": userSession("fixture-zone-bound", ["timezone evidence"]) } });
  const families = [
    ["search", "timezone", "--since"],
    ["sessions", "--since"],
    ["trace", "--file", "notes.md", "--since"],
    ["unfinished", "--since"],
    ["cmd", "command", "--until"],
    ["report", "cost", "--since"],
  ];
  for (const tz of ["UTC", "America/New_York", "Europe/Vienna"]) {
    for (const args of families) {
      const result = a.cli([...args, "2026-09-08T12:00:00", "--json"], { env: { TZ: tz } });
      assert.equal(result.status, 1, `${tz}: ${args.join(" ")}: ${result.stdout}`);
      assert.equal(errorEnvelope(result.stdout, args[0]!).error?.code, "USAGE_ERROR");
    }
    const explicit = a.cli(["search", "timezone", "--since", "2026-09-08T12:00:00Z", "--json"], { env: { TZ: tz } });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(envelope(explicit.stdout, "search", true).results.length, 1);
    const day = a.cli(["search", "timezone", "--since", "2026-09-08", "--json"], { env: { TZ: tz } });
    assert.equal(day.status, 0, day.stderr);
    assert.equal(envelope(day.stdout, "search", true).results.length, 1);
  }
});

test("trace paths are literal by default and glob only under the explicit option", async (t) => {
  const files = {
    "underscore.jsonl": toolSession("trace-underscore", "~/a_b.txt", 1),
    "neighbor.jsonl": toolSession("trace-neighbor", "~/axb.txt", 2),
    "percent.jsonl": toolSession("trace-percent", "~/a%b.txt", 3),
    "star.jsonl": toolSession("trace-star", "~/star*.txt", 4),
    "star-neighbor.jsonl": toolSession("trace-star-neighbor", "~/star-one.txt", 5),
    "upper.jsonl": toolSession("trace-upper", "~/Case.txt", 6),
    "lower.jsonl": toolSession("trace-lower", "~/case.txt", 7),
  };
  const a = await createArchive(t, { files });
  const query = (file: string, extra: string[] = []) => {
    const result = a.cli(["trace", "--file", file, ...extra, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    return envelope(result.stdout, "trace", true).results.map((row) => row.sessionUuid);
  };
  assert.deepEqual(query("a_b.txt"), ["trace-underscore"]);
  assert.deepEqual(query("a%b.txt"), ["trace-percent"]);
  assert.deepEqual(query("star*.txt"), ["trace-star"]);
  assert.deepEqual(new Set(query("star*.txt", ["--glob"])), new Set(["trace-star", "trace-star-neighbor"]));
  assert.deepEqual(query("Case.txt"), ["trace-upper"]);
  assert.deepEqual(query("case.txt"), ["trace-lower"]);

  const database = openQueryDatabase(a.databasePath);
  try {
    assert.deepEqual(traceFile(database, { file: "a_b.txt", limit: 20 }).map((row) => row.sessionUuid), ["trace-underscore"]);
    assert.deepEqual(new Set(traceFile(database, { file: "star*.txt", glob: true, limit: 20 }).map((row) => row.sessionUuid)), new Set(["trace-star", "trace-star-neighbor"]));
  } finally {
    database.close();
  }
});

test("query contract preserves sources and logical cache records while allowing SQLite sidecar metadata", async (t) => {
  const a = await createArchive(t);
  const source = join(a.sessionsDirectory, "fixture.jsonl");
  const sourceBefore = fingerprint(source);
  const databaseBefore = fingerprint(a.databasePath);
  const logicalBefore = logicalCache(a.databasePath);
  const result = a.cli(["sessions", "--limit", "1", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fingerprint(source), sourceBefore);
  assert.deepEqual(fingerprint(a.databasePath), databaseBefore);
  assert.deepEqual(logicalCache(a.databasePath), logicalBefore);

  const help = a.cli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /No source or cache is modified by either query/);
  assert.match(help.stdout, /logical\s+Atlas records/i);
  assert.match(help.stdout, /WAL\/SHM.*metadata/i);

  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /logical\s+Atlas records/i);
  assert.match(readme, /WAL\/SHM.*metadata/i);
});
