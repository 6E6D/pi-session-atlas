import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createArchive, createSandbox, envelope, errorEnvelope, fingerprint, userSession } from "./prepublication-support.ts";
import { usage, type FixtureEntry } from "./fixtures.ts";
import { costReport } from "../src/queries/reports.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { listPrompts, type PromptListing } from "../src/queries/prompts.ts";

const start = "2026-10-01T00:00:00.000Z";
const end = "2026-10-02T23:59:59.999Z";
function header(id: string, cwd = "/workspace/review"): FixtureEntry {
  return { type: "session", version: 3, id, timestamp: start, cwd };
}
function message(id: string, content: unknown, timestamp = start, parentId: string | null = null, role = "user"): FixtureEntry {
  return { type: "message", id, parentId, timestamp, message: { role, content, timestamp: 0 } };
}
const promptsArgs = ["prompts", "--since", "2026-10-01", "--until", "2026-10-02", "--cwd", "/workspace/review"];
function listing(stdout: string): PromptListing { return envelope(stdout, "prompts", true).results[0] as unknown as PromptListing; }

test("prompts validates bounds and mandatory scope before opening a cache", (t) => {
  const a = createSandbox(t);
  for (const args of [[], ["--since", "2026-10-01"], ["--cwd", "/workspace/*"],
    ["--since", "bad", "--cwd", "*"], ["--since", "2026-10-03", "--until", "2026-10-01", "--cwd", "*"],
    ...["0", "101", "1.5"].map(n => ["--since", "2026-10-01", "--cwd", "*", "--limit", n]),
    ...["0", "2001"].map(n => ["--since", "2026-10-01", "--cwd", "*", "--max-chars", n]),
    ["--since", "2026-10-01", "--session", "   "],
    ["--since", "2026-10-01", "--cwd="],
    ["--since", "2026-10-01", "--cwd", "*", "unexpected"],
  ]) {
    const r = a.cli(["prompts", ...args, "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(errorEnvelope(r.stdout, "prompts").error?.code, "USAGE_ERROR");
  }
  const missing = a.cli([...promptsArgs, "--json"]);
  assert.equal(missing.status, 2);
  assert.equal(errorEnvelope(missing.stdout, "prompts").error?.code, "DATABASE_NOT_FOUND");
});

test("prompts lists one cited message per entry, no-text entries, historical branches and explicit coverage", async (t) => {
  const a = await createArchive(t, { files: { "a.jsonl": [header("review-a"),
    message("first", [{ type: "text", text: "One" }, { type: "text", text: "Two" }]),
    message("old-branch", "Keep original", "2026-10-01T01:00:00.000Z", "first"),
    { type: "context_edit", id: "edit", parentId: "old-branch", timestamp: start, targetId: "old-branch", replacement: "NOT_ORIGINAL" },
    message("image", [{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }], end, "first"),
    message("assistant", [{ type: "text", text: "ASSISTANT_PRIVATE" }, { type: "thinking", thinking: "THINKING_PRIVATE" }], end, "image", "assistant"),
  ], "b.jsonl": [header("review-b", "/elsewhere"), message("foreign", "FOREIGN_PRIVATE") ] } });
  const source = join(a.sessionsDirectory, "a.jsonl"); const before = fingerprint(source); const dbBefore = fingerprint(a.databasePath);
  const r = a.cli([...promptsArgs, "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr);
  const value = listing(r.stdout);
  assert.deepEqual(value.messages.map(m => m.entryId), ["image", "old-branch", "first"]);
  assert.equal(value.messages[0]?.textAvailable, false);
  assert.equal(value.messages[0]?.excerpt, "");
  assert.equal(value.messages[1]?.excerpt, "Keep original");
  assert.equal(value.messages[1]?.onObservedBranch, false);
  assert.equal(value.messages[2]?.excerpt, "One\nTwo");
  assert.ok(value.messages.every(m => m.citation.includes(`\`review-a\`#${m.entryId}`)));
  assert.equal(value.selection.totalMatching, 3); assert.equal(value.selection.returned, 3);
  assert.equal(value.selection.withoutIndexedText, 1); assert.equal(value.selection.hasMore, false);
  assert.equal(value.authorship, "unverified-user-role");
  assert.equal(value.filters.since, start); assert.equal(value.filters.until, end);
  assert.equal(value.selection.limit, 20); assert.equal(value.selection.maxChars, 1200);
  assert.ok(JSON.parse(r.stdout).cache.identity);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_IMAGE|ASSISTANT_PRIVATE|THINKING_PRIVATE|FOREIGN_PRIVATE|NOT_ORIGINAL|"raw"|"file"|"parentSession"/);
  const text = a.cli(promptsArgs); assert.equal(text.status, 0);
  assert.match(text.stdout, /unverified-user-role/); assert.match(text.stdout, /3 of 3/);
  assert.match(text.stdout, /no indexed text/); assert.match(text.stdout, /review-a.*#first/);
  assert.deepEqual(fingerprint(source), before); assert.deepEqual(fingerprint(a.databasePath), dbBefore);
});

test("prompts has stable time ties, AND selectors, literal session resolution and UTC boundaries", async (t) => {
  const a = await createArchive(t, { files: {
    "a.jsonl": [header("review-a"), message("b", "second"), message("a", "first"), message("before", "exclude", "2026-09-30T23:59:59.999Z"), message("after", "exclude", "2026-10-03T00:00:00.000Z")],
    "b.jsonl": [header("review-b"), message("a", "third")],
  } });
  const r = a.cli([...promptsArgs, "--limit", "2", "--json"]); const value = listing(r.stdout);
  assert.deepEqual(value.messages.map(m => [m.sessionUuid, m.entryId]), [["review-a", "a"], ["review-a", "b"]]);
  assert.equal(value.selection.totalMatching, 3); assert.equal(value.selection.hasMore, true);
  const selected = listing(a.cli([...promptsArgs, "--session", "review-a", "--dir", "*/sessions", "--json"]).stdout);
  assert.equal(selected.selection.returned, 2); assert.equal(selected.filters.sessionUuid, "review-a");
  assert.equal(listing(a.cli([...promptsArgs, "--session", "review-a", "--dir", "*/other", "--json"]).stdout).selection.totalMatching, 0);
  assert.equal(listing(a.cli([...promptsArgs, "--cwd", "/WORKSPACE/*", "--json"]).stdout).selection.totalMatching, 0);
  const exact = a.cli(["prompts", "--session", "review-a", "--since", "2026-10-01T02:00:00+02:00", "--until", start, "--json"]);
  assert.equal(listing(exact.stdout).selection.returned, 2);
  for (const [ref, code] of [["review-", "SESSION_AMBIGUOUS"], ["review-%", "SESSION_NOT_FOUND"]]) {
    const r = a.cli(["prompts", "--since", "2026-10-01", "--session", ref!, "--json"]);
    assert.equal(r.status, 2); assert.equal(errorEnvelope(r.stdout, "prompts").error?.code, code);
  }
});

test("prompts truncates code points across blocks including embedded NUL without dropping long messages", async (t) => {
  const a = await createArchive(t, { files: { "a.jsonl": [header("unicode"),
    message("a", [{ type: "text", text: "😀\u0000x" }, { type: "text", text: "éZ" }]),
    message("b", "😀".repeat(50_000)),
    message("c", [{ type: "text", text: "abcd" }, { type: "text", text: "e" }]),
  ] } });
  for (const max of [1, 3, 4, 5, 6, 7]) {
    const value = listing(a.cli([...promptsArgs, "--max-chars", String(max), "--json"]).stdout);
    const original = "😀\u0000x\néZ";
    assert.equal(value.messages[0]?.excerpt, [...original].slice(0, max).join(""));
    assert.equal(value.messages[0]?.textTruncated, max < [...original].length);
    assert.equal(value.messages[1]?.excerpt, "😀".repeat(max)); assert.equal(value.messages[1]?.textTruncated, true);
    assert.equal(value.messages[2]?.excerpt, "abcd\ne".slice(0, max));
    assert.equal(value.messages[2]?.textTruncated, max < 6);
  }
  assert.match(a.cli([...promptsArgs, "--max-chars", "1"]).stdout, /truncated/);
});

test("prompts refuses incompatible caches without mutation", async (t) => {
  const a = await createArchive(t, { files: { "a.jsonl": [header("coverage"), message("u", "Evidence")] } });
  const db = new DatabaseSync(a.databasePath);
  const identity = JSON.parse(String(db.prepare("SELECT identity FROM cache_metadata").get()!.identity));
  identity.extractionVersion = 3;
  db.prepare("UPDATE cache_metadata SET identity=?").run(JSON.stringify(identity)); db.close();
  const before = fingerprint(a.databasePath);
  const r = a.cli([...promptsArgs, "--json"]);
  assert.equal(r.status, 2); assert.equal(errorEnvelope(r.stdout, "prompts").error?.code, "CACHE_EXTRACTION_MISMATCH");
  assert.deepEqual(fingerprint(a.databasePath), before);
});

function usageEntries(): FixtureEntry[] {
  return [header("cost-a"), message("u", "Accounting"),
    { type: "message", id: "a", parentId: "u", timestamp: start, message: { role: "assistant", content: "Answer", model: "m[1]", provider: "p", usage: usage(1) } },
    { type: "usage", id: "b", parentId: "a", timestamp: "2026-10-02T01:00:00+01:00", kind: "cache_warm", model: "m2", provider: "p", usage: usage(2) },
    { type: "usage", id: "c", parentId: "b", timestamp: end, kind: "unknown", model: "m[1]", provider: "q", usage: usage(4) },
    { type: "usage", id: "d", parentId: "c", timestamp: end, kind: "unknown", usage: usage(8) },
    { type: "usage", id: "e", parentId: "d", timestamp: "2026-10-03T00:00:00.000Z", kind: "cache_warm", model: "m[1]", provider: "p", usage: usage(16) },
  ];
}

test("cost filters operate on individual entries consistently across all groupings and top sessions", async (t) => {
  const other = usageEntries(); other[0] = header("cost-b", "/elsewhere");
  const a = await createArchive(t, { files: { "a.jsonl": usageEntries(), "b.jsonl": other, "empty.jsonl": [header("empty")] } });
  const db = openQueryDatabase(a.databasePath);
  try {
    for (const by of ["day", "month", "project", "model", "provider"] as const) {
      const report = costReport(db, { by, top: 10, cwdGlob: "/workspace/*", since: start, until: end, models: ["m[1]", "m2"], providers: ["p"] });
      assert.equal(report.totals.cost, 3, by);
      assert.equal(report.groups.reduce((s, g) => s + g.cost, 0), 3, by);
      assert.equal(report.topSessions.reduce((s, g) => s + g.cost, 0), 3, by);
      assert.deepEqual(report.topSessions.map(s => s.sessionUuid), ["cost-a"]);
      assert.equal(report.totals.tokensIn, 200); assert.equal(report.totals.cacheRead, 100);
      assert.equal(report.totals.tokensOut, 40); assert.equal(report.totals.cacheWrite, 20);
      for (const metric of ["tokensIn", "tokensOut", "cacheRead", "cacheWrite"] as const) {
        assert.equal(report.groups.reduce((sum, g) => sum + g[metric], 0), report.totals[metric], metric);
      }
      assert.equal(report.filters.until, end); assert.deepEqual(report.filters.models, ["m[1]", "m2"]);
    }
    const daily = costReport(db, { by: "day", top: 1, cwdGlob: "/workspace/review", until: end });
    assert.deepEqual(daily.groups.map(g => [g.key, g.cost]), [["2026-10-01", 1], ["2026-10-02", 14]]);
    assert.equal(daily.totals.cost, 15);
    for (const models of [["m"], ["M2"], ["m*"], ["(unattributed)"]]) {
      assert.equal(costReport(db, { by: "model", top: 1, models }).totals.cost, 0);
    }
    const all = costReport(db, { by: "model", top: 1, cwdGlob: "/workspace/review" });
    assert.equal(all.totals.cost, 31); assert.equal(all.groups.find(g => g.key === "(unattributed)")?.cost, 8);
    assert.equal(costReport(db, { by: "project", top: 10, cwdGlob: "/workspace/review" }).groups[0]?.sessions, 2);
    assert.equal(costReport(db, { by: "project", top: 10, cwdGlob: "/workspace/review", providers: ["p"] }).groups[0]?.sessions, 1);
    const unfiltered = costReport(db, { by: "project", top: 1 });
    assert.equal(unfiltered.totals.cost, 62); assert.equal(unfiltered.topSessions.length, 1);
    assert.equal(unfiltered.topSessions[0]?.sessionUuid, "cost-a");
  } finally { db.close(); }
  const r = a.cli(["report", "cost", "--by", "day", "--cwd", "/workspace/*", "--until", "2026-10-02", "--model", "m[1]", "--model", "m2", "--provider", "p", "--provider", "q", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((envelope(r.stdout, "report", true).results[0]!.totals as { cost: number }).cost, 7);
  assert.match(a.cli(["report", "cost", "--by", "day", "--cwd", "/workspace/*"]).stdout, /UTC/);
});

test("cost-only flags are refused on error reports before database opening", (t) => {
  const a = createSandbox(t);
  for (const args of [["--until", "2026-10-02"], ["--cwd", "*"], ["--model", "m"], ["--provider", "p"]]) {
    const r = a.cli(["report", "errors", ...args, "--json"]);
    assert.equal(r.status, 1); assert.equal(errorEnvelope(r.stdout, "report").error?.code, "USAGE_ERROR");
  }
  for (const args of [["--by", "week"], ["--since", "2026-10-02", "--until", "2026-10-01"], ["--provider="]]) {
    assert.equal(a.cli(["report", "cost", ...args, "--json"]).status, 1);
  }
});

test("large prompt population limits expansion and reports nonrepresentative newest-first selection", async (t) => {
  const rows = userSession("large-prompts", Array.from({ length: 3000 }, (_, i) => `Prompt ${i}`));
  rows[0]!.cwd = "/workspace/review";
  const blocks = Array.from({ length: 3000 }, () => ({ type: "text", text: "x".repeat(2000) }));
  rows.push(message("long", blocks, "2026-10-02T00:00:00.000Z", "00000bb8"));
  const a = await createArchive(t, { files: { "a.jsonl": rows } });
  const r = a.cli(["prompts", "--since", "2026-09-01", "--cwd", "/workspace/review", "--limit", "1", "--max-chars", "2000", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const value = listing(r.stdout); assert.equal(value.selection.totalMatching, 3001);
  assert.equal(value.selection.hasMore, true); assert.equal(value.messages.length, 1);
  assert.equal(value.messages[0]?.entryId, "long"); assert.equal(value.messages[0]?.excerpt.length, 2000);
  assert.equal(value.messages[0]?.textTruncated, true); assert.ok(r.stdout.length < 10_000);
  const db = openQueryDatabase(a.databasePath);
  try {
    const prepare = db.prepare.bind(db);
    let blockQueries = 0, fetchedBlocks = 0, fetchedBytes = 0, metadataOmissions = 0;
    db.prepare = (sql) => {
      if (sql.includes("NULL AS first_user_text")) metadataOmissions++;
      const statement = prepare(sql);
      if (sql.includes("AS prefix")) {
        blockQueries++;
        return new Proxy(statement, { get(target, property) {
          if (property === "iterate") return function* (...args: Array<string | number>) {
            for (const row of target.iterate(...args)) {
              const bytes = row.prefix as Uint8Array;
              fetchedBlocks++; fetchedBytes += bytes.byteLength;
              assert.ok(bytes.byteLength <= 8004, "SQL must bound bytes before returning to JS");
              yield row;
            }
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }
      return statement;
    };
    const observed = listPrompts(db, { since: "2026-09-01T00:00:00.000Z", sessionReference: "large-prompts", limit: 1, maxChars: 2000 });
    assert.equal(observed.messages[0]?.excerpt.length, 2000);
    assert.equal(blockQueries, 1); assert.equal(fetchedBlocks, 2); assert.ok(fetchedBytes <= 16008);
    assert.equal(metadataOmissions, 1, "identity lookup must not fetch a complete first-user-message copy");
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test("prompt coverage remains visibly partial and counts handle a successful empty selection", async (t) => {
  const a = await createArchive(t, { files: { "a.jsonl": [header("partial"), message("u", "Stored evidence")] } });
  const db = new DatabaseSync(a.databasePath);
  const attempt = JSON.parse(String(db.prepare("SELECT last_attempt FROM cache_metadata").get()!.last_attempt));
  attempt.status = "partial";
  db.prepare("UPDATE cache_metadata SET last_attempt=?").run(JSON.stringify(attempt));
  db.prepare("INSERT INTO file_health(file, message) VALUES (?, ?)").run(join(a.sessionsDirectory, "a.jsonl"), "synthetic source changed");
  db.close();
  const before = fingerprint(a.databasePath);
  const json = a.cli([...promptsArgs, "--json"]);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.equal(listing(json.stdout).selection.returned, 1);
  const coverage = JSON.parse(json.stdout).cache;
  assert.equal(coverage.unverifiedFiles.length, 1);
  assert.equal(coverage.lastAttempt.status, "partial");
  assert.match(a.cli(promptsArgs).stdout, /Retained evidence may be stale/);
  const empty = listing(a.cli(["prompts", "--since", "2027-01-01", "--dir", "*/sessions", "--json"]).stdout);
  assert.equal(empty.selection.returned, 0); assert.equal(empty.selection.totalMatching, 0);
  assert.equal(empty.selection.hasMore, false); assert.equal(empty.selection.withoutIndexedText, 0);
  assert.deepEqual(empty.messages, []); assert.deepEqual(fingerprint(a.databasePath), before);
});

test("review walkthrough retrieves corrections, a long request, copies, delegated text and counterevidence without classifying authors", async (t) => {
  const long = "Context. ".repeat(180) + "Keep the headings agreed in the brief.";
  const a = await createArchive(t, { files: {
    "human.jsonl": [header("review-human"),
      message("request-1", "Use the headings agreed in the brief."),
      message("answer-1", "I used different headings.", "2026-10-01T01:00:00.000Z", "request-1", "assistant"),
      message("correction-1", "These are not the agreed headings. Restore them.", "2026-10-01T02:00:00.000Z", "answer-1"),
      message("request-2", long, "2026-10-02T01:00:00.000Z", "correction-1"),
      message("answer-2", "I changed the headings again.", "2026-10-02T02:00:00.000Z", "request-2", "assistant"),
      message("correction-2", "Again, keep the agreed headings.", "2026-10-02T03:00:00.000Z", "answer-2"),
      message("resolved", "This revision uses the agreed headings.", "2026-10-02T04:00:00.000Z", "correction-2", "assistant"),
      message("accepted", "Yes, those headings are correct now.", "2026-10-02T05:00:00.000Z", "resolved"),
      message("one-off", "The test runner timed out once.", "2026-10-02T06:00:00.000Z", "accepted"),
    ],
    "fork.jsonl": [{ ...header("review-fork"), parentSession: "human.jsonl" }, message("copy", "These are not the agreed headings. Restore them.", "2026-10-01T02:00:00.000Z")],
    "delegated.jsonl": [header("review-delegated"), message("task", "Delegated analysis task: review the headings issue. This is an agent-generated task description.", "2026-10-02T07:00:00.000Z")],
  } });
  const prompts = listing(a.cli([...promptsArgs, "--json"]).stdout);
  assert.equal(prompts.selection.totalMatching, 8); assert.equal(prompts.selection.hasMore, false);
  assert.equal(prompts.authorship, "unverified-user-role");
  assert.equal(prompts.messages.find(m => m.entryId === "request-2")?.textTruncated, true);
  assert.equal(prompts.messages.find(m => m.entryId === "task")?.sessionUuid, "review-delegated");
  // Inspect surrounding evidence rather than treating duplicate wording or user-role as authorship.
  const shown = a.cli(["show", "review-human", "correction-2", "--context", "2", "--json"]);
  assert.equal(shown.status, 0);
  const entries = envelope(shown.stdout, "show", true).results[0]!.entries as Array<{ id: string; text: string; raw?: unknown }>;
  assert.ok(entries.some(e => e.id === "request-2"));
  assert.ok(entries.some(e => e.id === "resolved"));
  assert.ok(entries.every(e => e.raw === undefined));
  // show is still bounded to 500 characters per entry. Deliberately expand only
  // the known long request's indexed excerpt, not raw source or the whole window.
  const expanded = listing(a.cli(["prompts", "--session", "review-human", "--since", "2026-10-02T01:00:00Z",
    "--until", "2026-10-02T01:00:00Z", "--limit", "1", "--max-chars", "2000", "--json"]).stdout);
  assert.equal(expanded.messages[0]?.excerpt, long);
  assert.equal(expanded.messages[0]?.textTruncated, false);
  assert.ok(prompts.messages.find(m => m.entryId === "accepted")?.excerpt.includes("correct now"));
});
