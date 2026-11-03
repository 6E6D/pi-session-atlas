import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { HostConfigError, resolveHostConfig } from "../src/config.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { branchedSessionFixture, linearLegacyV1Fixture, writeFixture } from "./fixtures.ts";
import { createSandbox, envelope, errorEnvelope, fingerprint, projectRoot } from "./sandbox-support.ts";
import { copyRuntime, shellQuote } from "./package-support.ts";

function setup(t: TestContext) {
  const a = createSandbox(t);
  const home = join(a.root, "home");
  const configPath = join(a.root, "xdg-config", "session-atlas", "host.json");
  const host = {
    schemaVersion: 1,
    cachePath: join(a.root, "configured cache", "atlas.db"),
    sessionsPath: a.sessionsDirectory,
    pathHome: home,
  };
  const env: NodeJS.ProcessEnv = { ...a.env, HOME: home, ATLAS_HOME: undefined, ATLAS_SESSIONS_DIR: undefined, ATLAS_PI_PACKAGE: undefined };
  function put(value: unknown = host, path = configPath) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  }
  const cli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => a.cli(args, { env: { ...env, ...extraEnv } });
  return { ...a, home, configPath, host, env, put, cli };
}

test("absent optional config preserves defaults; XDG and explicit selection resolve deterministically", (t) => {
  const a = setup(t);
  let c = resolveHostConfig({}, a.env, a.home);
  assert.deepEqual(c.configFile, { path: a.configPath, selection: "default", present: false });
  assert.deepEqual(c.settings.cachePath, { value: join(a.home, ".pi/agent/atlas/atlas.db"), source: "built-in" });
  assert.equal(c.settings.piPackagePath.value, null);
  a.put();
  c = resolveHostConfig({}, a.env, a.home);
  assert.deepEqual(c.settings.cachePath, { value: a.host.cachePath, source: "host.json" });
  const fallback = join(a.home, ".config/session-atlas/host.json"); a.put(a.host, fallback);
  assert.equal(resolveHostConfig({}, { ...a.env, XDG_CONFIG_HOME: undefined }, a.home).configFile.path, fallback);
  const other = join(a.root, "other.json"); a.put({ schemaVersion: 1, cachePath: join(a.root, "other.db") }, other);
  c = resolveHostConfig({ configPath: other }, { ...a.env, XDG_CONFIG_HOME: "relative/invalid" }, a.home);
  assert.equal(c.configFile.selection, "--config"); assert.equal(c.settings.cachePath.value, join(a.root, "other.db"));
  assert.equal(c.settings.sessionsPath.source, "built-in");
});

test("command > environment > host > built-in precedence is exposed per field without environment mutation", (t) => {
  const a = setup(t); a.put({ ...a.host, piPackagePath: join(a.root, "host-pi") });
  const env = { ...a.env, ATLAS_HOME: join(a.root, "env-cache"), ATLAS_SESSIONS_DIR: join(a.root, "env-sessions"), ATLAS_PI_PACKAGE: join(a.root, "env-pi") };
  const before = { ...env };
  const c = resolveHostConfig({ cachePath: "cli.db", sessionsPath: "cli-sessions", pathHome: "cli-home" }, env, a.home);
  assert.deepEqual(c.settings.cachePath, { value: resolve("cli.db"), source: "--db" });
  assert.equal(c.settings.sessionsPath.source, "--sessions-dir"); assert.equal(c.settings.pathHome.source, "--path-home");
  assert.deepEqual(c.settings.piPackagePath, { value: env.ATLAS_PI_PACKAGE, source: "ATLAS_PI_PACKAGE" });
  const e = resolveHostConfig({}, env, a.home);
  assert.deepEqual(e.settings.cachePath, { value: join(env.ATLAS_HOME, "atlas.db"), source: "ATLAS_HOME" });
  assert.deepEqual(e.settings.sessionsPath, { value: env.ATLAS_SESSIONS_DIR, source: "ATLAS_SESSIONS_DIR" });
  assert.equal(e.settings.pathHome.source, "host.json"); assert.deepEqual(env, before);
});

test("invalid host data, unknown version and unsafe paths fail closed even with an explicit cache override", (t) => {
  const a = setup(t);
  for (const value of ["{", [], null, { schemaVersion: 2 }, { schemaVersion: "1" }, {},
    '{"schemaVersion":1,"cachePath":"/one","cachePath":"/two"}',
    '{"schemaVersion":1,"cachePath":"/one","cache\\u0050ath":"/two"}',
    { schemaVersion: 1, password: "PRIVATE_SENTINEL" }, { ...a.host, cachePath: "relative.db" },
    { ...a.host, cachePath: "~/atlas.db" }, { ...a.host, piPackagePath: null },
    { ...a.host, sessionsPath: "" }, { ...a.host, pathHome: "/bad\npath" }]) {
    a.put(value);
    const r = a.cli(["sessions", "--db", join(a.root, "override.db"), "--json"]);
    assert.equal(r.status, 2); const e = errorEnvelope(r.stdout, "sessions");
    assert.match(e.error!.code, /^CONFIG_/); assert.doesNotMatch(r.stdout, /PRIVATE_SENTINEL/);
    assert.equal(existsSync(join(a.root, "override.db")), false); assert.equal(existsSync(a.host.cachePath), false);
  }
  a.put();
  const r = a.cli(["config", "show", "--config", join(a.root, "missing.json"), "--json"]);
  assert.equal(r.status, 2); assert.equal(errorEnvelope(r.stdout, "config").error!.code, "CONFIG_UNREADABLE");
  assert.throws(() => resolveHostConfig({}, { ...a.env, XDG_CONFIG_HOME: "relative" }, a.home), HostConfigError);
});

test("configuration reader refuses links, nonregular files, insecure permissions, oversized and invalid UTF-8 inputs", (t) => {
  const a = setup(t); a.put();
  const links = [join(a.root, "symlink.json"), join(a.root, "hardlink.json"), join(a.root, "dangling.json")];
  symlinkSync(a.configPath, links[0]!); linkSync(a.configPath, links[1]!); symlinkSync(join(a.root, "missing"), links[2]!);
  for (const path of [...links, a.root]) assert.throws(() => resolveHostConfig({ configPath: path }, a.env, a.home), HostConfigError);
  const insecure = join(a.root, "insecure.json"); a.put(a.host, insecure); chmodSync(insecure, 0o666);
  assert.throws(() => resolveHostConfig({ configPath: insecure }, a.env, a.home), /group\/world-writable/);
  const huge = join(a.root, "huge.json"); a.put(" ".repeat(65537), huge);
  assert.throws(() => resolveHostConfig({ configPath: huge }, a.env, a.home), /at most/);
  const invalid = join(a.root, "invalid.json"); writeFileSync(invalid, Buffer.from([0xff]), { mode: 0o600 });
  assert.throws(() => resolveHostConfig({ configPath: invalid }, a.env, a.home), /UTF-8/);
  // The optional default must not treat a dangling link as absence either.
  const xdg = join(a.root, "dangling-default"); mkdirSync(join(xdg, "session-atlas"), { recursive: true });
  symlinkSync(join(a.root, "missing"), join(xdg, "session-atlas/host.json"));
  assert.throws(() => resolveHostConfig({}, { ...a.env, XDG_CONFIG_HOME: xdg }, a.home), HostConfigError);
});

test("config show performs no cache/source I/O, parser import or npm lookup", (t) => {
  const a = setup(t); const marker = join(a.root, "parser-imported"); const pi = join(a.root, "untrusted-pi");
  mkdirSync(join(pi, "dist"), { recursive: true });
  writeFileSync(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0", type: "module" }));
  writeFileSync(join(pi, "dist/index.js"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'BAD'); throw new Error('must not import');`);
  a.put({ ...a.host, piPackagePath: pi, sessionsPath: join(a.root, "absent-sessions") });
  const before = fingerprint(a.configPath);
  // Use Node explicitly so the shebang cannot mask an accidental npm lookup.
  const explicit = spawnSync(process.execPath, [join(projectRoot, "bin/atlas"), "config", "show", "--json"], {
    env: { ...a.env, PATH: "/does-not-exist" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  const c = envelope(explicit.stdout, "config", true).results[0] as any;
  assert.equal(c.settings.piPackagePath.value, pi); assert.equal(existsSync(marker), false);
  assert.equal(existsSync(a.host.cachePath), false); assert.equal(existsSync(join(a.root, "absent-sessions")), false);
  assert.deepEqual(fingerprint(a.configPath), before);
});

test("direct, wrapper and service-shaped invocations share configuration; unchanged identity refreshes without rebuild", async (t) => {
  const a = setup(t); const pi = (await resolvePiParser()).packageRoot;
  a.put({ ...a.host, piPackagePath: pi });
  const source = writeFixture(a.sessionsDirectory, "modern.jsonl", branchedSessionFixture());
  const before = fingerprint(source);
  const executable = copyRuntime(join(a.root, "installed-package"));
  const wrapper = join(a.root, "atlas-wrapper");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(executable)} "$@"\n`, { mode: 0o700 });
  const invoke = (program: string, args: string[], cwd: string, env = a.env) => {
    const r = spawnSync(program, args, { cwd, env, encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout);
  };
  const direct = invoke(process.execPath, [executable, "config", "show", "--json"], a.root);
  const wrapped = invoke(wrapper, ["config", "show", "--json"], a.home);
  const scheduled = invoke(wrapper, ["config", "show", "--config", a.configPath, "--json"], "/", { ...a.env, XDG_CONFIG_HOME: undefined });
  assert.deepEqual(direct.results[0].settings, wrapped.results[0].settings);
  assert.deepEqual(direct.results[0].settings, scheduled.results[0].settings);
  const first = invoke(process.execPath, [executable, "index", "--json"], a.root);
  assert.equal(first.results[0].filesChanged, 1);
  const refresh = invoke(wrapper, ["index", "--config", a.configPath, "--json"], "/", { ...a.env, XDG_CONFIG_HOME: undefined });
  assert.equal(refresh.results[0].filesChanged, 0); assert.deepEqual(refresh.results[0].failures, []);
  assert.deepEqual(first.results[0].coverage.identity, refresh.results[0].coverage.identity);
  assert.equal(invoke(wrapper, ["search", "Atlas", "--json"], a.home).ok, true);
  assert.deepEqual(fingerprint(source), before);
});

test("configured parser reaches index, legacy show and source verification without leaking to the environment", async (t) => {
  const a = setup(t); a.put({ ...a.host, piPackagePath: (await resolvePiParser()).packageRoot });
  writeFixture(a.sessionsDirectory, "legacy.jsonl", linearLegacyV1Fixture());
  assert.equal(a.cli(["index", "--json"]).status, 0);
  for (const args of [["show", "fixture-legacy-v1", "--context", "1"], ["cite", "fixture-legacy-v1", "--verify-source"]]) {
    const r = a.cli([...args, "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr);
    envelope(r.stdout, args[0]!, true);
  }
  // Missing explicit parser never falls through to a global installation.
  a.put({ ...a.host, piPackagePath: join(a.root, "missing-pi") });
  const before = fingerprint(a.host.cachePath);
  for (const args of [["index"], ["show", "fixture-legacy-v1"], ["cite", "fixture-legacy-v1", "--verify-source"]]) {
    const r = a.cli([...args, "--json"]); assert.equal(r.status, 2);
    assert.equal(errorEnvelope(r.stdout, args[0]!).error!.code, "PI_PARSER_UNAVAILABLE");
  }
  assert.deepEqual(fingerprint(a.host.cachePath), before);
  assert.equal(a.cli(["sessions", "--json"]).status, 0, "index-only reads do not load the configured Pi package");
  assert.equal(a.cli(["sessions", "--json"], { ATLAS_PI_PACKAGE: "" }).status, 0,
    "an empty parser environment override retains parser-free query compatibility");
  const empty = a.cli(["index", "--json"], { ATLAS_PI_PACKAGE: "" });
  assert.equal(empty.status, 2); assert.equal(errorEnvelope(empty.stdout, "index").error!.code, "PI_PARSER_UNAVAILABLE");
});

test("host defaults do not bypass explicit rebind gate or cache identity safeguards", async (t) => {
  const a = setup(t); a.put({ ...a.host, piPackagePath: (await resolvePiParser()).packageRoot });
  assert.equal(a.cli(["index", "--json"]).status, 0);
  const before = fingerprint(a.host.cachePath);
  let r = a.cli(["index", "--rebuild", "--rebind", "--json"]);
  assert.equal(r.status, 1); assert.match(errorEnvelope(r.stdout, "index").error!.message, /explicit --sessions-dir/);
  a.put({ ...a.host, pathHome: join(a.root, "different-home"), piPackagePath: (await resolvePiParser()).packageRoot });
  r = a.cli(["index", "--json"]); assert.equal(r.status, 2);
  assert.equal(errorEnvelope(r.stdout, "index").error!.code, "CACHE_IDENTITY_MISMATCH");
  assert.deepEqual(fingerprint(a.host.cachePath), before);
});

test("default missing config is not created; usage, help and option-like literals retain their semantics", (t) => {
  const a = setup(t);
  assert.equal(a.cli(["config", "show", "--json"]).status, 0);
  assert.equal(existsSync(a.configPath), false);
  for (const args of [["config"], ["config", "edit"], ["config", "show", "--config"], ["sessions", "--config"]]) {
    const r = a.cli([...args, "--json"]); assert.equal(r.status, 1); errorEnvelope(r.stdout, args[0]!);
  }
  a.put("malformed");
  assert.equal(a.cli(["--help"]).status, 0); assert.equal(a.cli(["config", "show", "--help"]).status, 0);
  const r = a.cli(["search", "--exact", "--", "--config"]);
  assert.equal(r.status, 2); assert.match(r.stderr, /valid UTF-8 JSON/);
  assert.ok(readFileSync(a.configPath, "utf8") === "malformed");
});
