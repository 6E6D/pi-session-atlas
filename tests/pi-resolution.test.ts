import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { createArchive, createSandbox, envelope, errorEnvelope, fingerprint, projectRoot, userSession } from "./prepublication-support.ts";
import { writeFixture } from "./fixtures.ts";
import { copyNode, copyPi, copyRuntime, npmProbe, PI_NAME, runNode, shellQuote } from "./package-support.ts";

import { resolvePiParser } from "../src/resolve-pi.ts";
const realPi = (await resolvePiParser()).packageRoot;
const cli = join(projectRoot, "bin", "atlas");
const goodExports = "export const CURRENT_SESSION_VERSION=3; export function parseSessionEntries(){} export function migrateSessionEntries(){}";
function fakePi(root: string, metadata: unknown, code = goodExports) {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  writeFileSync(join(root, "dist", "index.js"), code);
}
function refused(result: ReturnType<typeof runNode>) {
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  return errorEnvelope(result.stdout, "index").error!;
}

test("explicit missing, blank and dangling Pi overrides fail without global fallback or cache creation", (t) => {
  const a = createSandbox(t); const dangling = join(a.root, "dangling"); symlinkSync(join(a.root, "missing"), dangling);
  for (const selected of [join(a.root, "missing"), "", "   ", dangling]) {
    const error = refused(runNode(process.execPath, [cli, "index", "--json"], projectRoot, { ...a.env, ATLAS_PI_PACKAGE: selected }));
    assert.equal(error.code, "PI_PARSER_UNAVAILABLE"); assert.equal(existsSync(a.databasePath), false);
    assert.match(error.message, /ATLAS_PI_PACKAGE/);
  }
});

test("selected metadata is validated before import and incompatible exports never fall through", (t) => {
  const a = createSandbox(t); const marker = join(a.root, "imported");
  const sideEffect = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected'); ${goodExports}`;
  const valid = { name: PI_NAME, version: "0.85.1", type: "module" };
  for (const [i, metadata] of ["{malformed", [], { ...valid, name: "unrelated" }, { ...valid, version: "" }, { ...valid, version: "unknown" }, { name: PI_NAME, type: "module" }].entries()) {
    const root = join(a.root, `metadata-${i}`); fakePi(root, metadata, sideEffect);
    assert.equal(refused(runNode(process.execPath, [cli, "index", "--json"], projectRoot, { ...a.env, ATLAS_PI_PACKAGE: root })).code, "PI_PARSER_UNAVAILABLE");
    assert.equal(existsSync(marker), false); assert.equal(existsSync(a.databasePath), false);
  }
  for (const [i, code] of ["export const CURRENT_SESSION_VERSION=3;", goodExports.replace("VERSION=3", "VERSION=4"), "throw new Error('synthetic import failure')"].entries()) {
    const root = join(a.root, `exports-${i}`); fakePi(root, valid, code);
    assert.equal(refused(runNode(process.execPath, [cli, "index", "--json"], projectRoot, { ...a.env, ATLAS_PI_PACKAGE: root })).code, "PI_PARSER_UNAVAILABLE");
    assert.equal(existsSync(a.databasePath), false);
  }
});

test("explicit roots and dist/index.js use real Pi without probing npm; arbitrary JS is refused", (t) => {
  const a = createSandbox(t); const marker = join(a.root, "npm-called");
  const probe = npmProbe(a.root, `echo called > ${shellQuote(marker)}; exit 19`);
  const env = { ...a.env, PATH: probe };
  // Deliberately no Node on PATH: invoke the executable through the chosen Node.
  for (const [i, selected] of [realPi, join(realPi, "dist", "index.js")].entries()) {
    const result = runNode(process.execPath, [cli, "index", "--db", join(a.atlasHome, `explicit-${i}.db`), "--json"], projectRoot, { ...env, ATLAS_PI_PACKAGE: selected });
    assert.equal(result.status, 0, result.stdout + result.stderr); envelope(result.stdout, "index", true);
    assert.equal(existsSync(marker), false);
  }
  const bad = join(a.root, "not-the-entry.js"); writeFileSync(bad, goodExports);
  assert.equal(refused(runNode(process.execPath, [cli, "index", "--json"], projectRoot, { ...env, ATLAS_PI_PACKAGE: bad })).code, "PI_PARSER_UNAVAILABLE");
});

test("Atlas-local real Pi wins over Node-global; invalid local selection never hides behind global Pi", (t) => {
  const a = createSandbox(t); const app = join(a.root, "app", "node_modules", "session-atlas"); const executable = copyRuntime(app);
  const selected = join(a.root, "app", "node_modules", PI_NAME); copyPi(realPi, selected);
  const marker = join(a.root, "npm-called"); const probe = npmProbe(a.root, `echo called > ${shellQuote(marker)}; exit 19`);
  const env = { ...a.env, PATH: probe, ATLAS_PI_PACKAGE: undefined };
  writeFixture(a.sessionsDirectory, "modern.jsonl", userSession("fixture-local-pi", ["local discovery"]));
  const result = runNode(process.execPath, [executable, "index", "--json"], a.root, env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const row = envelope(result.stdout, "index", true).results[0] as any;
  assert.equal(row.coverage.identity.parser.modulePath, join(selected, "dist", "index.js"));
  assert.equal(existsSync(marker), false);
  // Alter only this disposable package copy to create a selected incompatibility.
  const meta = JSON.parse(readFileSync(join(selected, "package.json"), "utf8")); meta.name = "synthetic-incompatible";
  writeFileSync(join(selected, "package.json"), JSON.stringify(meta));
  const before = fingerprint(a.databasePath);
  assert.equal(refused(runNode(process.execPath, [executable, "index", "--json"], a.root, env)).code, "PI_PARSER_UNAVAILABLE");
  assert.deepEqual(fingerprint(a.databasePath), before); assert.equal(existsSync(marker), false);
  meta.name = PI_NAME; writeFileSync(join(selected, "package.json"), JSON.stringify(meta));
  const spaced = join(a.root, "Pi with trailing space "); renameSync(selected, spaced);
  for (const [i, override] of [spaced, relative(a.root, spaced), join(spaced, "dist", "index.js")].entries()) {
    const r = runNode(process.execPath, [executable, "index", "--db", join(a.atlasHome, `spaced-${i}.db`), "--json"], a.root, { ...env, ATLAS_PI_PACKAGE: override });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  assert.equal(existsSync(marker), false);
});

test("Node-adjacent and lazy npm routes resolve real Pi while caller cwd packages are ignored", (t) => {
  const a = createSandbox(t); const executable = copyRuntime(join(a.root, "app", "node_modules", "session-atlas"));
  const cwd = join(a.root, "unrelated caller"); mkdirSync(cwd);
  fakePi(join(cwd, "node_modules", PI_NAME), { name: "unrelated", version: "0.0.0", type: "module" });
  const marker = join(a.root, "npm-called");
  const npmRoot = resolve(realPi, "../..");
  const probe = npmProbe(a.root, `test "$1" = root && test "$2" = -g || exit 21\necho called >> ${shellQuote(marker)}\nprintf '%s\\n' ${shellQuote(npmRoot)}`);
  const env = { ...a.env, PATH: probe, ATLAS_PI_PACKAGE: undefined };
  const node = copyNode(a.root);
  for (const [i, runtime] of [process.execPath, node].entries()) {
    const r = runNode(runtime, [executable, "index", "--db", join(a.atlasHome, `route-${i}.db`), "--json"], cwd, env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const row = envelope(r.stdout, "index", true).results[0] as any;
    assert.equal(row.coverage.identity.parser.modulePath, join(realPi, "dist", "index.js"));
    if (i === 0) assert.equal(existsSync(marker), false);
    else assert.equal(readFileSync(marker, "utf8"), "called\n");
  }
});

test("actual parser absence still permits index-only and modern reads without npm or dev dependencies", async (t) => {
  const a = await createArchive(t); const app = join(a.root, "without parser", "node_modules", "session-atlas"); const executable = copyRuntime(app);
  const node = copyNode(a.root); const emptyPath = join(a.root, "empty bin"); mkdirSync(emptyPath);
  const env = { ...a.env, PATH: emptyPath, ATLAS_PI_PACKAGE: undefined }; const before = fingerprint(a.databasePath);
  assert.equal(existsSync(join(app, "src")), false); assert.equal(existsSync(join(app, "node_modules")), false);
  for (const args of [["--help"], ["sessions", "--json"], ["search", "Atlas", "--json"], ["show", "fixture-session-alpha", "00000001", "--context", "0", "--json"], ["cite", "fixture-session-alpha", "00000001", "--verify-source", "--json"]]) {
    const r = runNode(node, [executable, ...args], a.root, env); assert.equal(r.status, 0, r.stderr);
  }
  const fresh = join(a.atlasHome, "absent.db");
  assert.equal(refused(runNode(node, [executable, "index", "--db", fresh, "--json"], a.root, env)).code, "PI_PARSER_UNAVAILABLE");
  assert.equal(existsSync(fresh), false); assert.deepEqual(fingerprint(a.databasePath), before);
});

test("npm fallback rejects multiline/relative roots and is bounded for stalled or excessive output", (t) => {
  const a = createSandbox(t); const executable = copyRuntime(join(a.root, "app", "node_modules", "session-atlas")); const node = copyNode(a.root);
  for (const [i, body] of ["printf 'relative/path\\n'", "printf '/one\\n/two\\n'", "exec /bin/sleep 6", "exec /usr/bin/head -c 70000 /dev/zero"].entries()) {
    const bin = npmProbe(join(a.root, String(i)), body); const start = performance.now();
    const error = refused(runNode(node, [executable, "index", "--json"], a.root, { ...a.env, PATH: bin, ATLAS_PI_PACKAGE: undefined }));
    assert.equal(error.code, "PI_PARSER_UNAVAILABLE"); assert.equal(existsSync(a.databasePath), false);
    if (i === 2) assert.ok(performance.now() - start < 5000, "npm probe did not respect its bounded timeout");
  }
});

test("broken local main/exports/metadata are selected failures, not an excuse for global fallback", (t) => {
  const a = createSandbox(t);
  for (const [i, metadata] of [
    { name: PI_NAME, version: "0.85.1", type: "module", exports: {} },
    { name: PI_NAME, version: "0.85.1", type: "module", main: "missing.js" },
    null,
  ].entries()) {
    const root = join(a.root, String(i)); const executable = copyRuntime(join(root, "node_modules", "session-atlas"));
    const selected = join(root, "node_modules", PI_NAME); mkdirSync(selected, { recursive: true });
    if (metadata) writeFileSync(join(selected, "package.json"), JSON.stringify(metadata));
    const error = refused(runNode(process.execPath, [executable, "index", "--json"], a.root, { ...a.env, ATLAS_PI_PACKAGE: undefined }));
    assert.equal(error.code, "PI_PARSER_UNAVAILABLE"); assert.match(error.message, /No fallback/);
    assert.equal(existsSync(a.databasePath), false);
  }
});

test("an incompatible Node-adjacent package stops before a usable npm fallback", (t) => {
  const a = createSandbox(t); const executable = copyRuntime(join(a.root, "app", "node_modules", "session-atlas")); const node = copyNode(a.root);
  fakePi(join(dirname(dirname(node)), "lib", "node_modules", PI_NAME), { name: PI_NAME, version: "0.85.1", type: "module" }, goodExports.replace("VERSION=3", "VERSION=4"));
  const marker = join(a.root, "npm-called");
  const bin = npmProbe(a.root, `echo called > ${shellQuote(marker)}; printf '%s\\n' ${shellQuote(resolve(realPi, "../.."))}`);
  const error = refused(runNode(node, [executable, "index", "--json"], a.root, { ...a.env, PATH: bin, ATLAS_PI_PACKAGE: undefined }));
  assert.equal(error.code, "PI_PARSER_UNAVAILABLE"); assert.match(error.message, /session-format version 3/);
  assert.equal(existsSync(marker), false); assert.equal(existsSync(a.databasePath), false);
});
