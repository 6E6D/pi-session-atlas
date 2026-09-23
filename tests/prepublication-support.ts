import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { indexSessions } from "../src/indexer.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { branchedSessionFixture, type FixtureEntry, writeFixture } from "./fixtures.ts";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// TODO callbacks still execute. Enforce mode turns the same assertions into
// ordinary failing tests for a deliberate red run before the owning repair.
export function pending(reason: string): { todo: boolean | string } {
  return { todo: process.env.ATLAS_TEST_ENFORCE_PENDING === "1" ? false : reason };
}

export function fingerprint(file: string): { sha256: string; size: number; mtimeMs: number; mode: number } {
  const stat = statSync(file);
  return {
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o777,
  };
}

export function createSandbox(t: TestContext) {
  // The space also exercises quoted launcher/path handling. Cleanup is limited
  // to this newly allocated synthetic root, never a caller-supplied directory.
  const root = mkdtempSync(join(tmpdir(), "session-atlas prepublication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDirectory = join(root, "sessions");
  const atlasHome = join(root, "atlas");
  const databasePath = join(atlasHome, "atlas.db");
  for (const directory of [sessionsDirectory, atlasHome, join(root, "home"), join(root, "tmp")]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // API and spawned-CLI calls in one fixture represent the same invoking
    // account. The outer validation harness supplies an isolated private HOME.
    HOME: homedir(),
    TMPDIR: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(root, "pi-agent"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    ATLAS_HOME: atlasHome,
    ATLAS_SESSIONS_DIR: sessionsDirectory,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SESSION_")) delete env[key];
  }
  function cli(args: string[], options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {
    const result = spawnSync(options.executable ?? join(projectRoot, "bin", "atlas"), args, {
      cwd: projectRoot,
      env: { ...env, ...options.env },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `CLI terminated by ${result.signal}`);
    return result;
  }
  return { root, sessionsDirectory, atlasHome, databasePath, cli, env };
}

export async function createArchive(
  t: TestContext,
  options: { files?: Record<string, FixtureEntry[]>; toolHeadBytes?: number } = {},
) {
  const sandbox = createSandbox(t);
  for (const [filename, entries] of Object.entries(options.files ?? { "fixture.jsonl": branchedSessionFixture() })) {
    writeFixture(sandbox.sessionsDirectory, filename, entries);
  }
  const parser = (await resolvePiParser()).api;
  const result = await indexSessions({
    databasePath: sandbox.databasePath,
    sessionsDirectory: sandbox.sessionsDirectory,
    pathHome: sandbox.env.HOME,
    toolHeadBytes: options.toolHeadBytes,
  }, parser);
  assert.deepEqual(result.failures, [], "synthetic archive setup must succeed");
  return { ...sandbox, parser };
}

export function userSession(uuid: string, prompts: string[]): FixtureEntry[] {
  const timestamp = (index: number) => new Date(Date.UTC(2026, 8, 8, 12, 0, index)).toISOString();
  return [
    { type: "session", version: 3, id: uuid, timestamp: timestamp(0), cwd: "/workspace/synthetic" },
    ...prompts.map((content, index) => ({
      type: "message",
      id: (index + 1).toString(16).padStart(8, "0"),
      parentId: index === 0 ? null : index.toString(16).padStart(8, "0"),
      timestamp: timestamp(index + 1),
      message: { role: "user", content, timestamp: index + 1 },
    })),
  ];
}

export interface Envelope {
  ok: boolean;
  command: string;
  generatedAt: string;
  results: Array<Record<string, unknown>>;
  error?: { code: string; message: string; candidates?: string[] };
}

export function envelope(stdout: string, command: string, ok: boolean): Envelope {
  assert.ok(stdout.trim().startsWith("{"), `expected a JSON envelope, got ${JSON.stringify(stdout)}`);
  const value = JSON.parse(stdout) as Envelope;
  assert.equal(value.ok, ok);
  assert.equal(value.command, command);
  assert.ok(Number.isFinite(Date.parse(value.generatedAt)));
  assert.ok(Array.isArray(value.results));
  return value;
}

export function errorEnvelope(stdout: string, command: string): Envelope {
  const value = envelope(stdout, command, false);
  assert.equal(typeof value.error?.code, "string");
  assert.ok(value.error!.code.length > 0);
  assert.equal(typeof value.error?.message, "string");
  assert.ok(value.error!.message.length > 0);
  return value;
}
