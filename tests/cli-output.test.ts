import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createArchive, createSandbox, projectRoot } from "./prepublication-support.ts";

const executable = join(projectRoot, "bin", "atlas");

test("closed Unix stdout pipes stay quiet without masking operation or partial-index failures", async (t) => {
  const archive = await createArchive(t);
  writeFileSync(join(archive.sessionsDirectory, "invalid.jsonl"), "not a session\n");
  for (const [args, expected] of [
    [["--help"], 0], [["sessions"], 0], [["sessions", "--json"], 0],
    [["sessions", "--limit", "0", "--json"], 1],
    [["show", "absent", "--json"], 2], [["index", "--json"], 2],
  ] as const) {
    const result = spawnSync("bash", [
      "-c", 'set -o pipefail; "$@" | head -c 0; codes=("${PIPESTATUS[@]}"); exit "${codes[0]}"',
      "closed-pipe-fixture", executable, ...args,
    ], { cwd: projectRoot, env: archive.env, encoding: "utf8", timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, expected, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "");
  }
});

test("non-EPIPE stdout failures remain visible and nonzero", { skip: !existsSync("/dev/full") }, (t) => {
  const sandbox = createSandbox(t);
  const fd = openSync("/dev/full", "w");
  try {
    const result = spawnSync(executable, ["--help"], {
      cwd: projectRoot, env: sandbox.env, stdio: ["ignore", fd, "pipe"], encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /OUTPUT_FAILED/);
    assert.match(result.stderr, /ENOSPC|space/i);
  } finally {
    closeSync(fd);
  }
});

test("synchronous stdout throws follow the same policy and retain known usage failures", (t) => {
  const sandbox = createSandbox(t);
  for (const code of ["EPIPE", "ENOSPC"]) {
    const preload = join(sandbox.root, `${code}.mjs`);
    writeFileSync(preload, `process.stdout.write = () => { throw Object.assign(new Error('synthetic stdout failure'), { code: '${code}' }); };`);
    for (const [args, expected] of [
      [["--help"], code === "EPIPE" ? 0 : 2],
      [["sessions", "--limit", "0", "--json"], 1],
    ] as const) {
      const result = sandbox.cli([...args], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.stdout, "");
      if (code === "EPIPE") assert.equal(result.stderr, "");
      else assert.match(result.stderr, /OUTPUT_FAILED/);
    }
  }
});
