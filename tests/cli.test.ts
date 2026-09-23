import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { branchedSessionFixture, writeFixture } from "./fixtures.ts";

test("bin/atlas indexes fixtures and emits the stable JSON envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "session-atlas-cli-"));
  try {
    const sessionsDirectory = join(root, "sessions");
    const atlasHome = join(root, "atlas-home");
    writeFixture(sessionsDirectory, "fixture.jsonl", branchedSessionFixture());

    const result = spawnSync("./bin/atlas", ["index", "--json"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        ATLAS_HOME: atlasHome,
        ATLAS_SESSIONS_DIR: sessionsDirectory,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      results: Array<{ filesChanged: number; entriesIndexed: number }>;
    };
    assert.equal(output.ok, true);
    assert.equal(output.command, "index");
    assert.equal(output.results[0]?.filesChanged, 1);
    assert.equal(output.results[0]?.entriesIndexed, 11);
    assert.equal(statSync(join(atlasHome, "atlas.db")).mode & 0o777, 0o600);

    const search = spawnSync("./bin/atlas", ["search", "Investigate Atlas", "--exact", "--json"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, ATLAS_HOME: atlasHome },
    });
    assert.equal(search.status, 0, search.stderr);
    const searchOutput = JSON.parse(search.stdout) as {
      ok: boolean;
      command: string;
      results: Array<{ entryId: string; citation: string }>;
    };
    assert.equal(searchOutput.ok, true);
    assert.equal(searchOutput.command, "search");
    assert.equal(searchOutput.results[0]?.entryId, "00000001");
    assert.match(searchOutput.results[0]?.citation ?? "", /fixture-session-alpha/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
