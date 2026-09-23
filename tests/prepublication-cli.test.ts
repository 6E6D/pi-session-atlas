import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createArchive, envelope, errorEnvelope, fingerprint, userSession } from "./prepublication-support.ts";

const prompts = [
  "session-atlas notes",
  "Read src/cli.ts carefully",
  'a"b quotation marker',
  "alpha OR beta",
  "alpha beta",
  "alpha",
  "beta",
  "Café 日本語",
];
const files = { "search.jsonl": userSession("fixture-search-contract", prompts) };

for (const [query, entryId] of [
  ["session-atlas", "00000001"],
  ["src/cli.ts", "00000002"],
  ['a"b', "00000003"],
  ["alpha OR beta", "00000004"],
] as const) {
  test(`plain search treats ${JSON.stringify(query)} as literal text`, async (t) => {
    const archive = await createArchive(t, { files });
    const result = archive.cli(["search", query, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(envelope(result.stdout, "search", true).results.map((row) => row.entryId), [entryId]);
  });
}

test("existing Unicode search and exact-search case/quote behavior remain usable", async (t) => {
  const archive = await createArchive(t, { files });
  for (const [query, exact, ids] of [
    ["Café 日本語", false, ["00000008"]],
    ['a"b', true, ["00000003"]],
    ["session-atlas", true, ["00000001"]],
    ["Session-Atlas", true, []],
  ] as const) {
    const result = archive.cli(["search", query, ...(exact ? ["--exact"] : []), "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(envelope(result.stdout, "search", true).results.map((row) => row.entryId), ids);
  }
});

test("exact-search filters, day bounds, limit, and injection-shaped text stay parameterized", async (t) => {
  const archive = await createArchive(t, { files });
  const filtered = archive.cli([
    "search", "alpha", "--exact", "--kind", "user", "--cwd", "/workspace/*",
    "--dir", `${archive.sessionsDirectory}*`, "--since", "2026-09-08", "--until", "2026-09-08",
    "--limit", "1", "--json",
  ]);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(envelope(filtered.stdout, "search", true).results.map((row) => row.entryId), ["00000006"]);
  for (const extra of [["--kind", "assistant"], ["--since", "2027-01-01"]]) {
    const result = archive.cli(["search", "alpha", "--exact", ...extra, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(envelope(result.stdout, "search", true).results, []);
  }
  const injection = archive.cli(["search", "' OR 1=1 --", "--exact", "--json"]);
  assert.equal(injection.status, 0, injection.stderr);
  assert.deepEqual(envelope(injection.stdout, "search", true).results, []);
});

test("explicit FTS mode retains boolean expressions", async (t) => {
  const archive = await createArchive(t, { files });
  const result = archive.cli(["search", '"session" OR "日本語"', "--fts", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(new Set(envelope(result.stdout, "search", true).results.map((row) => row.entryId)), new Set(["00000001", "00000008"]));
});

for (const query of ["", "   "]) {
  test(`exact search rejects empty input ${JSON.stringify(query)}`, async (t) => {
    const archive = await createArchive(t, { files });
    const result = archive.cli(["search", query, "--exact", "--json"]);
    assert.notEqual(result.status, 0, "empty search must not silently succeed");
    errorEnvelope(result.stdout, "search");
  });
}

const failureCases = [
  { name: "unknown option", command: "sessions", args: ["sessions", "--unknown"], status: 1 },
  { name: "invalid limit", command: "sessions", args: ["sessions", "--limit", "0"], status: 1 },
  { name: "missing session", command: "show", args: ["show", "fixture-missing"], status: 2 },
  { name: "missing entry", command: "show", args: ["show", "fixture-search-contract", "missing-entry"], status: 2 },
] as const;
for (const scenario of failureCases) {
  test(`JSON failure envelope: ${scenario.name}`, async (t) => {
    const archive = await createArchive(t, { files });
    const result = archive.cli([...scenario.args, "--json"]);
    assert.equal(result.status, scenario.status, result.stderr);
    assert.deepEqual(errorEnvelope(result.stdout, scenario.command).results, []);
  });
}

test("JSON failure envelope: missing cache does not create one", async (t) => {
  const archive = await createArchive(t, { files });
  const missing = join(archive.root, "absent-cache");
  assert.equal(existsSync(missing), false);
  const result = archive.cli(["sessions", "--json"], { env: { ATLAS_HOME: missing } });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(existsSync(missing), false);
  errorEnvelope(result.stdout, "sessions");
});

test("partial indexing retains successful results and nonzero status", async (t) => {
  const archive = await createArchive(t, { files });
  const badFile = join(archive.sessionsDirectory, "invalid.jsonl");
  writeFileSync(badFile, "not a session\n", { mode: 0o600 });
  const before = fingerprint(badFile);
  const result = archive.cli(["index", "--json"]);
  assert.equal(result.status, 2, result.stderr);
  const output = envelope(result.stdout, "index", false);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0]?.filesUnchanged, 1);
  assert.equal((output.results[0]?.failures as unknown[]).length, 1);
  assert.deepEqual(fingerprint(badFile), before);
});

test("partial indexing also provides a structured error summary", async (t) => {
  const archive = await createArchive(t, { files });
  writeFileSync(join(archive.sessionsDirectory, "invalid.jsonl"), "not a session\n", { mode: 0o600 });
  const result = archive.cli(["index", "--json"]);
  assert.equal(result.status, 2, result.stderr);
  const output = errorEnvelope(result.stdout, "index");
  assert.equal(output.error?.code, "INDEX_PARTIAL_FAILURE");
  assert.equal(output.results.length, 1);
  assert.equal((output.results[0]?.failures as unknown[]).length, 1);
});
