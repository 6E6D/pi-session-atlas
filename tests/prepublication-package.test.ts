import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createSandbox, projectRoot } from "./prepublication-support.ts";

test("executable works from an installed-shaped node_modules path without dev dependencies", (t) => {
  const sandbox = createSandbox(t);
  const installed = join(sandbox.root, "node_modules", "fixture-atlas");
  mkdirSync(installed, { recursive: true });
  // This is a narrow execution regression, not an npm pack/install acceptance
  // test. Copy no development history, private docs, deploy wrapper or skills.
  for (const name of ["bin", "package.json"]) {
    cpSync(join(projectRoot, name), join(installed, name), { recursive: true });
  }
  if (existsSync(join(projectRoot, "dist"))) {
    cpSync(join(projectRoot, "dist"), join(installed, "dist"), { recursive: true });
  }
  assert.equal(existsSync(join(installed, "node_modules")), false);
  assert.equal(existsSync(join(installed, "src")), false);
  const result = sandbox.cli(["--help"], { executable: join(installed, "bin", "atlas") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});
