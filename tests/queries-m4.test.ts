import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { indexSessions } from "../src/indexer.ts";
import { openQueryDatabase } from "../src/query-db.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { costReport, errorReport } from "../src/queries/reports.ts";
import { branchedSessionFixture, writeFixture } from "./fixtures.ts";

test("M4 cost and error reports use deterministic indexed facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-atlas-m4-"));
  try {
    const sessionsDirectory = join(root, "sessions");
    const databasePath = join(root, "atlas", "atlas.db");
    writeFixture(sessionsDirectory, "fixture.jsonl", branchedSessionFixture());
    writeFixture(sessionsDirectory, "provider-error.jsonl", [
      {
        type: "session", version: 3, id: "fixture-provider-error",
        timestamp: "2026-08-23T11:00:00.000Z", cwd: "/workspace/project",
      },
      {
        type: "message", id: "20000001", parentId: null,
        timestamp: "2026-08-23T11:00:01.000Z",
        message: { role: "user", content: "Trigger provider error", timestamp: 1 },
      },
      {
        type: "message", id: "20000002", parentId: "20000001",
        timestamp: "2026-08-23T11:00:02.000Z",
        message: {
          role: "assistant", content: [], provider: "test-provider", model: "test-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error", errorMessage: "Provider unavailable: fixture outage", timestamp: 2,
        },
      },
    ]);
    const parser = (await resolvePiParser()).api;
    await indexSessions({ databasePath, sessionsDirectory }, parser);
    const database = openQueryDatabase(databasePath);
    try {
      const byProject = costReport(database, { by: "project", top: 5 });
      assert.ok(Math.abs(byProject.totals.cost - 0.065) < 1e-12);
      assert.equal(byProject.totals.tokensIn, 400);
      assert.equal(byProject.groups.length, 1);
      assert.equal(byProject.groups[0]?.key, "/workspace/project");
      assert.ok(Math.abs((byProject.groups[0]?.cost ?? 0) - 0.065) < 1e-12);
      assert.equal(byProject.topSessions[0]?.sessionUuid, "fixture-session-alpha");

      const byModel = costReport(database, { by: "model", top: 5 });
      const modelCosts = new Map(byModel.groups.map((group) => [group.key, group.cost]));
      assert.ok(Math.abs((modelCosts.get("test-model") ?? 0) - 0.06) < 1e-12);
      assert.ok(Math.abs((modelCosts.get("(unattributed)") ?? 0) - 0.005) < 1e-12);

      const errors = errorReport(database, { by: "tool", limit: 20 });
      assert.equal(errors.toolFailures, 1);
      assert.equal(errors.assistantErrors, 1);
      assert.equal(errors.assistantAborts, 1);
      assert.deepEqual(
        new Map(errors.groups.map((group) => [group.key, group.count])),
        new Map([
          ["assistant", 2],
          ["bash", 1],
        ]),
      );
      assert.ok(errors.recent.some((failure) => /Tests failed/.test(failure.signature)));
      assert.ok(errors.recent.some((failure) => /Provider unavailable/.test(failure.signature)));
      assert.ok(errors.recent.every((failure) => failure.citation.includes("fixture-")));

      const none = errorReport(database, {
        by: "signature",
        since: "2027-01-01T00:00:00.000Z",
        limit: 20,
      });
      assert.equal(none.toolFailures, 0);
      assert.equal(none.assistantAborts, 0);
      assert.deepEqual(none.groups, []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
