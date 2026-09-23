import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { createArchive, createSandbox, envelope, fingerprint, projectRoot } from "./prepublication-support.ts";

const forbiddenRuntimeText = /from ["'][^"']+\.ts["']|sourceMappingURL|\/(?:home|Users)\/[^/\s]+\/|[A-Za-z]:[\\/]Users[\\/]/;

function files(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(root, path) : [path];
  }).sort();
}

function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, expected = 0) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, expected, result.stdout + result.stderr);
  return result;
}

function copyBuildInputs(destination: string) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"]) {
    cpSync(join(projectRoot, name), join(destination, name), { recursive: true });
  }
}

test("clean builds emit identical JavaScript with a complete rewritten module set and no source maps", (t) => {
  const a = createSandbox(t); const roots = [join(a.root, "first build"), join(a.root, "second build")];
  const expected = files(join(projectRoot, "src")).map((p) => p.replace(/\.ts$/, ".js"));
  for (const root of roots) {
    copyBuildInputs(root); command("npm", ["run", "build"], root, a.env);
    assert.deepEqual(files(join(root, "dist")), expected);
    for (const file of expected) {
      const body = readFileSync(join(root, "dist", file), "utf8");
      assert.doesNotMatch(body, forbiddenRuntimeText);
      assert.equal(fingerprint(join(root, "dist", file)).sha256, fingerprint(join(projectRoot, "dist", file)).sha256);
    }
  }
});

test("build guard refuses stale outputs and aliases without changing unrelated sentinel bytes", (t) => {
  const a = createSandbox(t);
  for (const kind of ["stale", "file-link", "hardlink", "directory-link", "unexpected-directory"]) {
    const root = join(a.root, kind); copyBuildInputs(root);
    const sentinel = join(root, "sentinel.js"); writeFileSync(sentinel, "synthetic private sentinel\n", { mode: 0o640 });
    const before = fingerprint(sentinel); const dist = join(root, "dist");
    if (kind === "directory-link") symlinkSync(join(root, "src"), dist);
    else {
      mkdirSync(dist);
      if (kind === "stale") writeFileSync(join(dist, "stale.js"), "synthetic stale output");
      if (kind === "file-link") symlinkSync(sentinel, join(dist, "cli.js"));
      if (kind === "hardlink") linkSync(sentinel, join(dist, "cli.js"));
      if (kind === "unexpected-directory") mkdirSync(join(dist, "unknown"));
    }
    const result = command("npm", ["run", "build"], root, a.env, 1);
    assert.match(result.stderr, /AssertionError|refusing|unexpected|not a regular directory/);
    assert.deepEqual(fingerprint(sentinel), before);
  }
});

test("actual allowlisted tarball installs offline without Pi/compiler dependencies and runs every CLI family", async (t) => {
  const a = await createArchive(t); const source = join(a.sessionsDirectory, "fixture.jsonl"); const before = fingerprint(source);
  const packed = command("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", a.root], projectRoot, a.env);
  const details = JSON.parse(packed.stdout)[0] as { filename: string; files: { path: string }[]; bundled: string[] };
  const expected = ["LICENSE", "README.md", "package.json", "bin/atlas", "skills/session-atlas/SKILL.md", ...files(join(projectRoot, "dist")).map((p) => `dist/${p}`)].sort();
  assert.deepEqual(details.files.map((v) => v.path).sort(), expected); assert.deepEqual(details.bundled, []);
  const tarball = join(a.root, details.filename);
  const listing = command("tar", ["-tzf", tarball], a.root, a.env).stdout.trim().split("\n").sort();
  assert.deepEqual(listing, expected.map((p) => `package/${p}`).sort());
  const prefix = join(a.root, "fresh installed tools");
  command("npm", ["install", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--prefix", prefix, tarball], a.root, a.env);
  const installed = join(prefix, "node_modules", "session-atlas");
  const modules = readdirSync(join(prefix, "node_modules")).filter((p) => !p.startsWith("."));
  assert.deepEqual(modules, ["session-atlas"]);
  for (const name of ["node_modules", "src", "tests", "docs", "deploy", "scripts", ".worktrees", "STATUS.md", "package-lock.json"]) {
    assert.equal(existsSync(join(installed, name)), false, name);
  }
  for (const path of expected) assert.equal(fingerprint(join(installed, path)).sha256, fingerprint(join(projectRoot, path)).sha256, path);
  const skill = join(installed, "skills", "session-atlas", "SKILL.md");
  const executable = resolve(dirname(skill), "../../bin/atlas");
  assert.equal(relative(installed, executable), "bin/atlas");
  assert.match(command(process.execPath, [executable, "--help"], a.root, a.env).stdout, /Usage:/);
  for (const args of [
    ["index"], ["sessions"], ["search", "Atlas", "--exact"],
    ["show", "fixture-session-alpha", "00000001", "--context", "0"],
    ["trace", "--file", "README.md"], ["branches", "--abandoned"], ["unfinished"],
    ["cmd", "npm test", "--failed"], ["report", "cost", "--by", "model"], ["report", "errors", "--by", "tool"],
    ["cite", "fixture-session-alpha", "00000001"], ["cite", "fixture-session-alpha", "00000001", "--verify-source"],
  ]) {
    const result = command(process.execPath, [executable, ...args, "--json"], a.root, a.env);
    envelope(result.stdout, args[0]!, true); assert.equal(result.stderr, "");
  }
  assert.deepEqual(fingerprint(source), before);
});

// String-level privacy coverage, not a portability claim about these hosts.
test("runtime privacy assertion rejects generic home paths without naming a private account", () => {
  for (const text of ["/home/fixture-user/project", "/Users/fixture-user/project", "C:\\Users\\fixture-user\\project", "import x from './module.ts'", "//# sourceMappingURL=fixture.map"]) {
    assert.match(text, forbiddenRuntimeText);
  }
  assert.doesNotMatch("import './module.js'; const example = '/workspace/synthetic';", forbiddenRuntimeText);
});
