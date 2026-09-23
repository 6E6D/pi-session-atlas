import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readlinkSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { projectRoot } from "./prepublication-support.ts";

export const PI_NAME = "@earendil-works/pi-coding-agent";
export function runNode(node: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(node, args, { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(r.error); assert.equal(r.signal, null); return r;
}
export function copyRuntime(destination: string) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ["bin", "dist", "package.json"]) cpSync(join(projectRoot, name), join(destination, name), { recursive: true });
  return join(destination, "bin", "atlas");
}
export function copyNode(root: string) {
  const node = join(root, "isolated runtime", "bin", "node"); mkdirSync(dirname(node), { recursive: true });
  // This copied-runtime fixture targets the reviewed Node distribution layout.
  // Retain its full bundled third-party notice, not just the Node executable.
  cpSync(join(dirname(dirname(process.execPath)), "LICENSE"), join(dirname(dirname(node)), "LICENSE"));
  cpSync(process.execPath, node); return node;
}
export function copyPi(source: string, destination: string) {
  // Preserve only package-internal relative links. Never introduce a pointer
  // back into the installed package or another domain through fixture copying.
  const root = realpathSync(source);
  function inspect(directory: string) {
    for (const entry of readdirSync(directory)) {
      const p = join(directory, entry); const s = lstatSync(p);
      if (s.isSymbolicLink()) {
        assert.equal(isAbsolute(readlinkSync(p)), false, p);
        assert.ok(realpathSync(p).startsWith(root + sep), p);
      } else if (s.isDirectory()) inspect(p);
      else assert.ok(s.isFile(), p);
    }
  }
  inspect(root); mkdirSync(dirname(destination), { recursive: true });
  cpSync(root, destination, { recursive: true, verbatimSymlinks: true });
}
export function shellQuote(text: string) { return `'${text.replaceAll("'", "'\\''")}'`; }
export function npmProbe(root: string, body: string) {
  const bin = join(root, "probe bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n${body}\n`, { mode: 0o700 }); return bin;
}
