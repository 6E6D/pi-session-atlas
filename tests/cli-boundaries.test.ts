import assert from "node:assert/strict";
import { existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { failureFor } from "../src/errors.ts";
import { AtlasQueryError } from "../src/query-db.ts";
import { prepareSearchQuery } from "../src/queries/search.ts";
import { createArchive, createSandbox, envelope, errorEnvelope, projectRoot, userSession } from "./prepublication-support.ts";

const texts = ["--help", "-h", "--json", "--", "alpha beta", "alpha", "beta", 'He said "hello".', "literal OR term"];
const files = { "boundary.jsonl": userSession("fixture-boundary", texts) };

test("search modes reject conflicts and preserve advanced syntax errors", async (t) => {
  const archive = await createArchive(t, { files });
  for (const [args, status, code] of [
    [["search", "alpha", "--fts", "--exact"], 1, "USAGE_ERROR"],
    [["search", "alpha AND (", "--fts"], 2, "INVALID_FTS_QUERY"],
    [["search", "missing_column:alpha", "--fts"], 2, "INVALID_FTS_QUERY"],
    [["search", '"alpha', "--fts"], 2, "INVALID_FTS_QUERY"],
  ] as const) {
    const result = archive.cli([...args, "--json"]);
    assert.equal(result.status, status, result.stderr);
    assert.equal(errorEnvelope(result.stdout, "search").error?.code, code);
    assert.equal(result.stderr, "");
  }
});

test("literal chunks preserve quotes, whitespace and AND semantics; FTS retains ranking and filters", async (t) => {
  const archive = await createArchive(t, { files });
  for (const [query, ids] of [
    [" alpha\n\t beta ", ["00000005"]],
    ['"hello"', ["00000008"]],
    ["literal OR term", ["00000009"]],
    ["alpha' OR 1=1", []],
  ] as const) {
    const result = archive.cli(["search", query, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(envelope(result.stdout, "search", true).results.map((row) => row.entryId), ids);
  }
  const plain = archive.cli(["search", "alpha beta", "--kind", "user", "--json"]);
  const advanced = archive.cli(["search", '"alpha" AND "beta"', "--fts", "--kind", "user", "--json"]);
  assert.equal(advanced.status, 0, advanced.stderr);
  assert.deepEqual(envelope(advanced.stdout, "search", true).results, envelope(plain.stdout, "search", true).results);
  const filtered = archive.cli(["search", "alpha OR beta", "--fts", "--cwd", "/absent/*", "--limit", "1", "--json"]);
  assert.deepEqual(envelope(filtered.stdout, "search", true).results, []);
});

test("empty or non-searchable input is refused without breaking exact punctuation search", async (t) => {
  const archive = await createArchive(t, { files });
  for (const [query, flags] of [["", []], [" \t\n", []], ["!!!", []], ["alpha !!!", []], ['"!!!"', ["--fts"]]] as const) {
    const result = archive.cli(["search", query, ...flags, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(errorEnvelope(result.stdout, "search").error?.code, "USAGE_ERROR");
  }
  const result = archive.cli(["search", "--exact", "--json", "--", "--"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope(result.stdout, "search", true).results.length, 3);
});

test("option terminator preserves literal help, JSON and repeated terminator arguments", async (t) => {
  const archive = await createArchive(t, { files });
  for (const text of ["--help", "-h", "--json", "--"]) {
    const result = archive.cli(["search", "--exact", "--json", "--", text]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(envelope(result.stdout, "search", true).results.length, texts.filter((value) => value.includes(text)).length);
  }
  const human = archive.cli(["search", "--exact", "--", "--json"]);
  assert.equal(human.status, 0, human.stderr);
  assert.ok(!human.stdout.startsWith("{"));
  assert.match(human.stdout, /fixture-boundary/);
  const name = archive.cli(["sessions", "--name", "-h", "--json"]);
  assert.equal(name.status, 0);
  envelope(name.stdout, "sessions", true);
});

test("invalid calendars and reversed ranges fail; valid leap days and timezone offsets work", async (t) => {
  const archive = await createArchive(t, { files });
  for (const args of [
    ["--since", "2026-02-29"], ["--until", "2026-02-30T00:00:00Z"],
    ["--since", "2026-13-01"], ["--since", "1900-02-29"], ["--since", "not-a-date"],
    ["--since=", "--until", "2026-09-08"], ["--since", "2026-09-09", "--until", "2026-09-08"],
  ]) {
    const result = archive.cli(["search", "alpha", ...args, "--json"]);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(errorEnvelope(result.stdout, "search").error?.code, "USAGE_ERROR");
  }
  for (const since of ["2000-02-29", "2024-02-29", "2026-09-08T14:00:00+02:00"]) {
    const result = archive.cli(["search", "alpha", "--since", since, "--until", "2026-09-08T14:01:00+02:00", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(envelope(result.stdout, "search", true).results.length, 2);
  }
});

test("usage errors take precedence over an absent cache and preserve JSON intent", (t) => {
  const sandbox = createSandbox(t);
  for (const args of [
    ["unknown-command"], ["sessions", "extra"], ["show"], ["cite"], ["search"], ["cmd"],
    ["trace"], ["branches", "extra"], ["unfinished", "extra"],
    ["report", "unknown"], ["report", "cost", "--by", "invalid"], ["report", "cost", "--top", "0"],
    ["search", "alpha", "--kind", "invalid"], ["search", "alpha", "--since", "2026-13-01"],
    ["search", "alpha", "--fts", "--exact"], ["show", "anything", "--context", "-1"],
    ["sessions", "--limit", "1e2"], ["sessions", "--limit", "0x10"], ["sessions", "--limit", "1.0"],
    ["sessions", "--db="], ["index", "--tool-head-bytes", " "], ["sessions", "--unknown"],
    ["sessions", "--json=false"], ["sessions", "--limit"],
  ]) {
    const result = sandbox.cli([...args, "--json"]);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(errorEnvelope(result.stdout, args[0]!).error?.code, "USAGE_ERROR");
    assert.equal(result.stderr, "");
    assert.equal(existsSync(sandbox.databasePath), false);
  }
});

test("failure codes distinguish lookup, schema and generic operation failures", async (t) => {
  const archive = await createArchive(t, { files: {
    ...files, "other.jsonl": userSession("fixture-boundary-other", ["other synthetic session"]),
  } });
  for (const [args, code] of [
    [["sessions", "--db", join(archive.root, "absent.db")], "DATABASE_NOT_FOUND"],
    [["show", "absent"], "SESSION_NOT_FOUND"],
    [["show", "fixture-bound"], "SESSION_AMBIGUOUS"],
    [["show", "fixture-boundary", "absent"], "ENTRY_NOT_FOUND"],
    [["show", "fixture-boundary", "0000000"], "ENTRY_AMBIGUOUS"],
    [["index", "--sessions-dir", join(archive.root, "absent-source")], "OPERATION_FAILED"],
  ] as const) {
    const result = archive.cli([...args, "--json"]);
    assert.equal(result.status, 2);
    assert.equal(errorEnvelope(result.stdout, args[0]).error?.code, code);
  }
  const old = join(archive.root, "old-synthetic.db");
  const database = new DatabaseSync(old);
  database.exec(readFileSync(new URL("./fixtures/atlas-v3-schema.sql", import.meta.url), "utf8"));
  database.close();
  chmodSync(old, 0o600);
  const result = archive.cli(["sessions", "--db", old, "--json"]);
  assert.equal(result.status, 2);
  assert.equal(errorEnvelope(result.stdout, "sessions").error?.code, "DATABASE_SCHEMA_MISMATCH");
});

test("SQLite storage faults are not mislabeled as user FTS syntax", async (t) => {
  const archive = await createArchive(t, { files });
  const database = new DatabaseSync(archive.databasePath);
  database.exec("DROP TABLE text_fts");
  database.close();
  const result = archive.cli(["search", "alpha", "--fts", "--json"]);
  assert.equal(result.status, 2);
  const error = errorEnvelope(result.stdout, "search").error;
  assert.equal(error?.code, "CACHE_UNRECOGNIZED");
  assert.doesNotMatch(error!.message, /invalid FTS query/i);
});

test("parser-resolution failure is serialized before any cache is created", (t) => {
  const sandbox = createSandbox(t);
  const target = pathToFileURL(join(projectRoot, "dist", "resolve-pi.js")).href;
  const preload = join(sandbox.root, "parser-failure.mjs");
  // Test-only module hook: exercise CLI failure propagation with the genuine
  // error class, without uninstalling Pi or altering discovery on the host.
  const stub = `import { PiPackageResolutionError } from ${JSON.stringify(`${target}?original`)};
    export { PiPackageResolutionError };
    export { parserIdentityFor, parserCodeFingerprint } from ${JSON.stringify(`${target}?original`)};
    export async function resolvePiParser() {
      throw new PiPackageResolutionError('synthetic unavailable parser', ['/synthetic/missing-pi']);
    }`;
  writeFileSync(preload, `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      if (url !== ${JSON.stringify(target)}) return nextLoad(url, context);
      return { format: 'module', shortCircuit: true, source: ${JSON.stringify(stub)} };
    }});`);
  const result = sandbox.cli(["index", "--json"], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  assert.equal(result.status, 2);
  const error = errorEnvelope(result.stdout, "index").error;
  assert.equal(error?.code, "PI_PARSER_UNAVAILABLE");
  assert.deepEqual(error?.candidates, ["/synthetic/missing-pi"]);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(sandbox.databasePath), false);
  const human = sandbox.cli(["index"], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  assert.equal(human.status, 2);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /tried: \/synthetic\/missing-pi/);
});

test("FTS semantic errors such as non-integer NEAR distances have the syntax code", async (t) => {
  const archive = await createArchive(t, { files });
  for (const query of ["NEAR(alpha, nope)", "NEAR()", "alpha +", "NOT alpha"]) {
    const result = archive.cli(["search", query, "--fts", "--json"]);
    assert.equal(result.status, 2);
    assert.equal(errorEnvelope(result.stdout, "search").error?.code, "INVALID_FTS_QUERY", query);
  }
});

test("inline string option values beginning with flags remain data", async (t) => {
  const archive = await createArchive(t, { files });
  for (const value of ["--help", "--json", "--"]) {
    const result = archive.cli(["sessions", `--name=${value}`, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(envelope(result.stdout, "sessions", true).results, []);
  }
  const human = archive.cli(["sessions", "--name=--json"]);
  assert.equal(human.status, 0);
  assert.equal(human.stdout, "No results.\n");
});

test("ISO calendar validation also catches rolled-over dates with a Z suffix", async (t) => {
  const archive = await createArchive(t, { files });
  const result = archive.cli(["search", "alpha", "--since", "2026-02-30Z", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(errorEnvelope(result.stdout, "search").error?.code, "USAGE_ERROR");
});

test("query compiler preserves original exact text and guards direct API input", () => {
  assert.equal(prepareSearchQuery({ query: '  session-atlas a"b 日本語 \uE000  ' }), '"session-atlas" AND "a""b" AND "日本語" AND "\uE000"');
  assert.equal(prepareSearchQuery({ query: " a  b ", exact: true }), " a  b ");
  for (const flags of [{}, { exact: true }, { fts: true }]) {
    assert.throws(() => prepareSearchQuery({ query: "a\0b", ...flags }), /NUL/);
  }
  assert.throws(() => prepareSearchQuery({ query: "alpha", exact: true, fts: true }), /mutually exclusive/);
});

test("generic errors remain structured and EPIPE is special only at stdout", (t) => {
  assert.deepEqual(failureFor("synthetic failure"), { exitCode: 2, error: { code: "OPERATION_FAILED", message: "synthetic failure" } });
  assert.equal(failureFor(new AtlasQueryError("synthetic query failure")).error.code, "QUERY_FAILED");
  assert.equal(failureFor(Object.assign(new Error("not stdout"), { code: "EPIPE" })).exitCode, 2);
  const sandbox = createSandbox(t);
  const human = sandbox.cli(["sessions", "--limit", "0"]);
  assert.equal(human.status, 1);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /atlas:.*--limit/);
  assert.match(human.stderr, /--help/);
  const invalidJson = sandbox.cli(["sessions", "--json=false"]);
  assert.equal(invalidJson.status, 1);
  assert.equal(errorEnvelope(invalidJson.stdout, "sessions").error?.code, "USAGE_ERROR");
});

test("every CLI command family still returns its successful JSON envelope", async (t) => {
  const archive = await createArchive(t);
  for (const args of [
    ["index"], ["sessions"], ["search", "Atlas", "--exact"],
    ["show", "fixture-session-alpha", "00000001", "--context", "0"],
    ["trace", "--file", "README.md", "--since", "2020-01-01"],
    ["branches", "--abandoned"], ["unfinished", "--since", "2020-01-01"],
    ["cmd", "npm test", "--failed"],
    ["report", "cost", "--by", "model", "--top", "3"], ["report", "errors", "--by", "tool"],
    ["cite", "fixture-session-alpha", "00000001"],
  ]) {
    const result = archive.cli([...args, "--json"]);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    const output = envelope(result.stdout, args[0]!, true);
    assert.deepEqual(Object.keys(output).sort(), args[0] === "index" ? ["command", "generatedAt", "ok", "results"] : ["cache", "command", "generatedAt", "ok", "results"]);
    if (args[0] !== "index") assert.equal((output as unknown as { cache: { basis: string } }).cache.basis, "indexed-observations");
    assert.equal(result.stderr, "");
  }
});
