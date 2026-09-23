import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextAnnotations, contextNode } from "../src/context-edits.ts";
import { extractSession, sourceEntryText } from "../src/extract.ts";
import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { showSession } from "../src/queries/show.ts";
import { costReport } from "../src/queries/reports.ts";
import { search } from "../src/queries/search.ts";
import { toJsonl, writeFixture, usage } from "./fixtures.ts";
import { validateIdentity } from "../src/cache.ts";
import { ATLAS_EXTRACTION_VERSION } from "../src/types.ts";

const stamp = "2026-09-21T12:00:00.000Z";
const row = (type: string, id: string, parentId: string | null, fields = {}) => ({ type, id, parentId, timestamp: stamp, ...fields });
const header = { type: "session", version: 3, id: "pi087-synthetic", timestamp: stamp, cwd: "/synthetic" };
const original = row("message", "u", null, { message: { role: "user", content: "ORIGINAL_MARKER", timestamp: 0 } });
const replacement = row("context_edit", "e1", "u", { targetId: "u", replacement: "REPLACEMENT_MARKER" });
const omit = row("context_edit", "e2", "e1", { targetId: "u", replacement: null });
function annotate(entries: Record<string, unknown>[], ids = ["u", "e1", "e2"]) {
  return contextAnnotations(entries.map(contextNode).filter(n => n !== null), ids);
}

test("Pi 0.87 edits preserve original searchable evidence and label replacement evidence", async () => {
  const parser = (await resolvePiParser()).api;
  const result = extractSession(toJsonl([header, original, replacement, omit]), "/synthetic/a.jsonl", parser);
  assert.ok(result.texts.some(t => t.kind === "user" && t.content === "ORIGINAL_MARKER"));
  assert.ok(result.texts.some(t => t.kind === "context_edit" && t.content.includes("REPLACEMENT_MARKER")));
  assert.ok(result.texts.some(t => t.kind === "context_edit" && t.content.includes("omit target=u")));
  assert.equal(result.userMessages, 1);
  assert.equal(result.cost, 0);
  assert.equal(sourceEntryText(omit).text, "context_edit omit target=u");
  const image = row("context_edit", "img", "u", { targetId: "u", replacement: [{ type: "image", data: "PRIVATE_BASE64", mimeType: "image/png" }] });
  assert.ok(!sourceEntryText(image).text.includes("PRIVATE_BASE64"));
});

test("latest edit is branch-relative; navigation before edit does not imply deletion", () => {
  assert.equal(annotate([original, replacement, omit]).entries[0]?.editAction, "omit");
  const branch = row("message", "other", "u", { message: { role: "assistant", content: "Other branch" } });
  const switched = annotate([original, replacement, omit, branch]);
  assert.equal(switched.entries[0]?.editAction, null);
  assert.equal(switched.entries[1]?.onObservedBranch, false);
  assert.equal(annotate([original, replacement]).entries[0]?.editAction, "replace");
  assert.equal(annotate([original]).entries[0]?.editAction, null);
});

test("compaction, retained-none boundaries and invalid targets never claim reconstructed visibility", () => {
  const compact = row("compaction", "compact", "e2", { summary: "Summary", firstKeptEntryId: "compact" });
  const result = annotate([original, replacement, omit, compact]);
  assert.equal(result.modelContextReconstructed, false);
  assert.equal(result.entries[0]?.onObservedBranch, true);
  assert.match(result.limitation, /Compaction/);
  for (const targetId of ["missing", "compact", "bad"]) {
    const bad = row("context_edit", "bad", "compact", { targetId, replacement: null });
    assert.equal(annotate([original, replacement, omit, compact, bad], ["bad"]).entries[0]?.relatedEdits[0]?.valid, false);
  }
  assert.equal(annotate([original, original]).branchValid, false);
  assert.equal(annotate([row("context_edit", "loop", "loop", { targetId: "loop", replacement: null })]).branchValid, false);
});

test("standalone usage counts once, retains attribution and accepts unknown operation kinds", async () => {
  const parser = (await resolvePiParser()).api;
  const entries = [header, original,
    row("message", "a", "u", { message: { role: "assistant", content: "Answer", model: "test-model", provider: "test-provider", usage: usage(1), stopReason: "stop" } }),
    row("usage", "w", "a", { kind: "cache_warm", model: "test-model", provider: "test-provider", usage: usage(2) }),
    row("usage", "x", "w", { kind: "future_operation", model: "other-model", provider: "other-provider", usage: usage(3) }),
    row("context_edit", "o", "x", { targetId: "a", replacement: null })];
  const result = extractSession(toJsonl(entries), "/synthetic/b.jsonl", parser);
  assert.equal(result.cost, 6);
  assert.equal(result.assistantMessages, 1);
  assert.equal(result.entries.find(e => e.id === "w")?.model, "test-model");
  assert.equal(result.entries.find(e => e.id === "x")?.provider, "other-provider");
});

test("synthetic index/search/show/reports preserve source and expose context history", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-pi087-"));
  try {
    const sessionsDirectory = join(root, "sessions");
    const databasePath = join(root, "cache", "atlas.db");
    writeFixture(sessionsDirectory, "a.jsonl", [header, original, replacement, omit,
      row("usage", "w", "e2", { kind: "cache_warm", model: "m", provider: "p", usage: usage(2) })]);
    const file = join(sessionsDirectory, "a.jsonl");
    const before = readFileSync(file);
    await indexSessions({ sessionsDirectory, databasePath });
    const db = openQueryDatabase(databasePath);
    try {
      const shown = await showSession(db, "pi087-synthetic", "e1", 1);
      assert.ok(shown.entries.find(e => e.id === "e1")?.text.includes("replace target=u"));
      assert.equal(shown.contextHistory.entries.find(e => e.entryId === "u")?.editAction, "omit");
      assert.ok(shown.entries.every(e => e.raw === undefined));
      for (const by of ["month", "project", "provider", "model"] as const) {
        const report = costReport(db, { by, top: 5 });
        assert.equal(report.totals.cost, 2);
        assert.equal(report.groups.reduce((sum, g) => sum + g.cost, 0), 2);
      }
      assert.equal(costReport(db, { by: "model", top: 5, since: "2027-01-01T00:00:00.000Z" }).totals.cost, 0);
      const results = search(db, { query: "REPLACEMENT_MARKER", exact: true, limit: 10 });
      assert.equal(results[0]?.entryId, "e1");
    } finally { db.close(); }
    assert.deepEqual(readFileSync(file), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("extraction identity advances without forgetting recognized v3 path-home binding", async () => {
  assert.equal(ATLAS_EXTRACTION_VERSION, 4);
  const { identity } = await resolvePiParser();
  const legacy = { sourceRoot: "/synthetic", schemaVersion: 4, extractionVersion: 3, toolHeadBytes: 2048, parser: identity, pathHome: "/synthetic-home" };
  assert.doesNotThrow(() => validateIdentity(legacy));
  assert.throws(() => validateIdentity({ ...legacy, pathHome: undefined }));
});


test("recognized extraction-v3 cache is refused without mutation, explicit synthetic rebuild advances it", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-pi087-cache-"));
  try {
    const sessionsDirectory = join(root, "sessions");
    const databasePath = join(root, "cache", "atlas.db");
    writeFixture(sessionsDirectory, "a.jsonl", [header, original]);
    await indexSessions({ sessionsDirectory, databasePath });
    const db = new DatabaseSync(databasePath);
    const identity = JSON.parse(String(db.prepare("SELECT identity FROM cache_metadata").get()!.identity));
    identity.extractionVersion = 3;
    db.prepare("UPDATE cache_metadata SET identity=?").run(JSON.stringify(identity));
    db.close();
    const before = readFileSync(databasePath);
    assert.throws(() => openQueryDatabase(databasePath), { code: "CACHE_EXTRACTION_MISMATCH" });
    await assert.rejects(indexSessions({ sessionsDirectory, databasePath }), { code: "CACHE_IDENTITY_MISMATCH" });
    assert.deepEqual(readFileSync(databasePath), before);
    const rebuilt = await indexSessions({ sessionsDirectory, databasePath, rebuild: true });
    assert.equal(rebuilt.coverage?.identity.extractionVersion, 4);
    assert.equal(rebuilt.filesChanged, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assistant and tool replacements remain edits, and sibling-branch targets are invalid", () => {
  for (const role of ["assistant", "toolResult", "user"] as const) {
    const target = row("message", "target", "u", { message: { role, content: "Original" } });
    const edit = row("context_edit", "edit", "target", { targetId: "target", replacement: "Replacement" });
    assert.equal(annotate([original, target, edit], ["target"]).entries[0]?.editAction, "replace");
    const sibling = row("message", "sibling", "u", { message: { role: "user", content: "Sibling" } });
    const cross = row("context_edit", "cross", "sibling", { targetId: "target", replacement: null });
    assert.equal(annotate([original, target, edit, sibling, cross], ["cross"]).entries[0]?.relatedEdits[0]?.valid, false);
  }
});
