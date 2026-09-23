import assert from "node:assert/strict";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const complete = process.argv[2] === "--complete";
assert(process.argv.length === 2 || (process.argv.length === 3 && complete),
  "usage: node scripts/check-dist.mjs [--complete]");

function inspect(directory, prefix = "") {
  assert(lstatSync(directory).isDirectory(), `not a regular directory: ${directory}`);
  const files = [];
  const directories = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const state = lstatSync(path);
    if (state.isDirectory()) {
      directories.push(relative);
      const nested = inspect(path, relative);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else {
      assert(state.isFile() && state.nlink === 1,
        `refusing nonregular or aliased build input/output: ${path}`);
      files.push(relative);
    }
  }
  return { files, directories };
}

const source = inspect(join(root, "src"));
assert(source.files.length > 0, "source tree is empty");
for (const file of source.files) {
  assert(file.endsWith(".ts") && !file.endsWith(".d.ts"),
    `unexpected source input: ${file}`);
}
const expected = source.files.map((file) => file.slice(0, -3) + ".js").sort();
const expectedDirectories = new Set();
for (const file of expected) {
  for (let directory = posix.dirname(file); directory !== "."; directory = posix.dirname(directory)) {
    expectedDirectories.add(directory);
  }
}

try {
  lstatSync(join(root, "dist"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  assert(!complete, "dist is missing; build did not produce an artifact");
  process.exit(0);
}
const output = inspect(join(root, "dist"));
for (const directory of output.directories) {
  assert(expectedDirectories.has(directory), `unexpected dist directory: ${directory}`);
}
for (const file of output.files) {
  assert(expected.includes(file), `unexpected or stale dist file: ${file}; review it, do not auto-delete it`);
}
if (complete) assert.deepEqual(output.files.sort(), expected, "dist is incomplete");
