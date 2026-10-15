import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { recognizeCache } from "../src/cache.ts";
import { AtlasStore } from "../src/store.ts";
import { createArchive, errorEnvelope, fingerprint } from "./prepublication-support.ts";

test("identity diagnostic identifies a package-version-only change without blaming parser code", async (t) => {
  const a = await createArchive(t);
  const previous = recognizeCache(a.databasePath)!.coverage!.identity;
  const requested = structuredClone(previous);
  requested.parser.packageVersion = "synthetic-successor";
  const before = fingerprint(a.databasePath);
  assert.throws(() => new AtlasStore(a.databasePath, { identity: requested }), (error: any) => {
    assert.equal(error.code, "CACHE_IDENTITY_MISMATCH");
    assert.ok(error.message.includes(`parser.packageVersion: ${JSON.stringify(previous.parser.packageVersion)} -> "synthetic-successor"`));
    assert.ok(!error.message.includes("parser.codeFingerprint:"));
    assert.match(error.message, /not ordinary cache staleness or proof of corruption/);
    assert.match(error.message, /explicit approval.*--rebuild.*new private cache path/);
    return true;
  });
  assert.deepEqual(fingerprint(a.databasePath), before);
  assert.equal(existsSync(a.databasePath + ".lock"), false);
});

test("identity diagnostic enumerates multiple changed fields and escapes control characters", async (t) => {
  const a = await createArchive(t);
  const requested = structuredClone(recognizeCache(a.databasePath)!.coverage!.identity);
  requested.parser.packageVersion = "synthetic\n\u001b[31m";
  requested.parser.codeFingerprint = requested.parser.codeFingerprint === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
  requested.toolHeadBytes += 1;
  const before = fingerprint(a.databasePath);
  assert.throws(() => new AtlasStore(a.databasePath, { identity: requested }), (error: any) => {
    assert.equal(error.code, "CACHE_IDENTITY_MISMATCH");
    assert.match(error.message, /toolHeadBytes: .* -> /);
    assert.match(error.message, /parser.codeFingerprint: .* -> /);
    assert.ok(error.message.includes(JSON.stringify(requested.parser.packageVersion)));
    assert.ok(!error.message.includes("\n"));
    assert.ok(!error.message.includes("\u001b"));
    return true;
  });
  assert.deepEqual(fingerprint(a.databasePath), before);
});

test("CLI mismatch retains failure envelope and leaves synthetic cache unchanged", async (t) => {
  const a = await createArchive(t);
  const before = fingerprint(a.databasePath);
  const r = a.cli(["index", "--tool-head-bytes", "4096", "--json"]);
  assert.equal(r.status, 2);
  const error = errorEnvelope(r.stdout, "index").error!;
  assert.equal(error.code, "CACHE_IDENTITY_MISMATCH");
  assert.match(error.message, /toolHeadBytes: 2048 -> 4096/);
  assert.match(error.message, /stored -> requested/);
  assert.deepEqual(fingerprint(a.databasePath), before);
});

test("matching identity still permits ordinary incremental refresh", async (t) => {
  const a = await createArchive(t);
  const r = a.cli(["index", "--json"]);
  assert.equal(r.status, 0, r.stdout || r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].rebuilt, false);
});
