import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createSandbox, envelope, errorEnvelope, fingerprint, projectRoot, userSession } from "./prepublication-support.ts";
import { linearLegacyV1Fixture, writeFixture } from "./fixtures.ts";
import { copyNode, runNode } from "./package-support.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
const realPi = (await resolvePiParser()).packageRoot;

function npm(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync("npm", args, { cwd, env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr); return r;
}

test("native Pi discovers only the installed package skill, prompt-lists it and reports collisions explicitly", (t) => {
  const a = createSandbox(t); const packed = JSON.parse(npm(["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", a.root], projectRoot, a.env).stdout)[0];
  const prefix = join(a.root, "new installed tools");
  npm(["install", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--prefix", prefix, join(a.root, packed.filename)], a.root, a.env);
  const installed = join(prefix, "node_modules", "session-atlas"); const cwd = join(a.root, "fresh project"); mkdirSync(cwd);
  const duplicate = join(a.root, "synthetic legacy skill"); mkdirSync(duplicate);
  cpSync(join(installed, "skills", "session-atlas", "SKILL.md"), join(duplicate, "SKILL.md"));
  const script = join(a.root, "native-discovery.mjs");
  writeFileSync(script, `import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { DefaultPackageManager, SettingsManager, loadSkills, formatSkillsForPrompt } from ${JSON.stringify(pathToFileURL(join(realPi, "dist", "index.js")).href)};
    const cwd=${JSON.stringify(cwd)}, installed=${JSON.stringify(installed)}, agentDir=process.env.PI_CODING_AGENT_DIR;
    // Untrusted project mode avoids ancestor .agents discovery. Settings and
    // user roots are wholly synthetic; no existing configuration is read.
    const settings = SettingsManager.inMemory({packages:[installed]}, {projectTrusted:false});
    const manager = new DefaultPackageManager({cwd, agentDir, settingsManager:settings});
    manager.setProgressCallback(() => { throw new Error('unexpected package mutation'); });
    const resources = await manager.resolve(async () => { throw new Error('unexpected missing external source'); });
    for (const kind of ['extensions','prompts','themes']) assert.deepEqual(resources[kind], []);
    assert.equal(resources.skills.length,1); assert.equal(resources.skills[0].enabled,true);
    assert.equal(resources.skills[0].metadata.origin,'package'); assert.equal(resources.skills[0].metadata.baseDir,installed);
    const paths=resources.skills.map(r=>r.path);
    const loaded=loadSkills({cwd,agentDir,skillPaths:paths,includeDefaults:false});
    assert.deepEqual(loaded.diagnostics,[]); assert.equal(loaded.skills.length,1);
    assert.equal(loaded.skills[0].name,'session-atlas'); assert.equal(loaded.skills[0].disableModelInvocation,false);
    const prompt=formatSkillsForPrompt(loaded.skills); assert.ok(prompt.includes('<name>session-atlas</name>'));
    assert.ok(prompt.includes(loaded.skills[0].filePath));
    const collision=loadSkills({cwd,agentDir,skillPaths:[${JSON.stringify(duplicate)},...paths],includeDefaults:false});
    assert.equal(collision.skills.length,1); assert.equal(collision.diagnostics.length,1);
    assert.equal(collision.diagnostics[0].type,'collision');
    assert.equal(collision.diagnostics[0].collision.winnerPath,${JSON.stringify(join(duplicate, "SKILL.md"))});
    assert.equal(collision.diagnostics[0].collision.loserPath,loaded.skills[0].filePath);
    assert.equal(existsSync(agentDir+'/settings.json'),false); assert.equal(existsSync(cwd+'/.pi/settings.json'),false);
    console.log(JSON.stringify({skill:loaded.skills[0].filePath, resources, diagnostics:loaded.diagnostics}));
  `);
  const discovered = runNode(process.execPath, [script], cwd, a.env); assert.equal(discovered.status, 0, discovered.stdout + discovered.stderr);
  assert.equal(discovered.stderr, ""); const skill = JSON.parse(discovered.stdout).skill as string;
  assert.equal(skill, join(installed, "skills", "session-atlas", "SKILL.md"));
  const executable = resolve(dirname(skill), "../../bin/atlas");
  assert.match(runNode(process.execPath, [executable, "--help"], cwd, a.env).stdout, /Usage:/);
  assert.equal(existsSync(join(installed, "src")), false); assert.equal(existsSync(join(installed, "node_modules")), false);
  assert.deepEqual(readdirSync(join(prefix, "node_modules")).filter((p) => !p.startsWith(".")), ["session-atlas"]);

  // Run all supported source formats from the discovered package executable.
  const v1 = linearLegacyV1Fixture(); const v2 = userSession("fixture-packaged-v2", ["legacy custom text"]);
  v2[0]!.version = 2; (v2[1]!.message as Record<string, unknown>).role = "hookMessage";
  const v3 = userSession("fixture-packaged-v3", ["modern text"]);
  for (const [name, entries] of [["v1", v1], ["v2", v2], ["v3", v3]] as const) writeFixture(a.sessionsDirectory, `${name}.jsonl`, entries);
  const sources = Object.fromEntries(readdirSync(a.sessionsDirectory).map((p) => [p, fingerprint(join(a.sessionsDirectory, p))]));
  const call = (args: string[], env = a.env, node = process.execPath) => runNode(node, [executable, ...args, "--json"], cwd, env);
  let result = call(["index"]); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal((envelope(result.stdout, "index", true).results[0] as any).sessionsIndexed, 3);
  const v1id = `v1-${createHash("sha256").update("fixture-legacy-v1:1").digest("hex").slice(0, 12)}`;
  for (const [session, entry, raw, role] of [["fixture-legacy-v1", v1id, v1[1], "user"], ["fixture-packaged-v2", "00000001", v2[1], "custom"], ["fixture-packaged-v3", "00000001", v3[1], "user"]] as const) {
    for (const context of [0, 1]) {
      result = call(["show", session, entry, "--context", String(context)]); assert.equal(result.status, 0, result.stderr);
      const row = envelope(result.stdout, "show", true).results[0] as any;
      assert.equal(row.entries[0].id, entry); assert.equal(row.entries[0].role, role);
      if (context === 0) assert.deepEqual(row.entries[0].raw, raw); else assert.equal(row.entries[0].raw, undefined);
    }
    result = call(["cite", session, entry, "--verify-source"]); assert.equal(result.status, 0, result.stderr);
    assert.equal((envelope(result.stdout, "cite", true).results[0] as any).verification.basis, "source-identity");
  }
  const node = copyNode(a.root); const emptyPath = join(a.root, "empty bin"); mkdirSync(emptyPath);
  const withoutPi = { ...a.env, PATH: emptyPath, ATLAS_PI_PACKAGE: undefined }; const dbBefore = fingerprint(a.databasePath);
  result = call(["cite", "fixture-legacy-v1", v1id], withoutPi, node); assert.equal(result.status, 0, result.stderr);
  for (const args of [["show", "fixture-legacy-v1", v1id, "--context", "0"], ["cite", "fixture-packaged-v2", "00000001", "--verify-source"]]) {
    result = call(args, withoutPi, node); assert.equal(result.status, 2);
    assert.equal(errorEnvelope(result.stdout, args[0]!).error?.code, "PI_PARSER_UNAVAILABLE");
  }
  assert.deepEqual(fingerprint(a.databasePath), dbBefore);
  for (const [p, before] of Object.entries(sources)) assert.deepEqual(fingerprint(join(a.sessionsDirectory, p)), before);
  assert.equal(existsSync(join(a.env.PI_CODING_AGENT_DIR!, "settings.json")), false);
});
