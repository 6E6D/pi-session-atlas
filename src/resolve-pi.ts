import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PiParserApi, ParserIdentity } from "./types.ts";

const identities = new WeakMap<PiParserApi, ParserIdentity>();
export function parserIdentityFor(api: PiParserApi): ParserIdentity | undefined {
  return identities.get(api);
}
export function parserCodeFingerprint(api: PiParserApi): string {
  return createHash("sha256").update(String(api.CURRENT_SESSION_VERSION))
    .update(String(api.parseSessionEntries)).update(String(api.migrateSessionEntries)).digest("hex");
}

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export class PiPackageResolutionError extends Error {
  readonly candidates: string[];

  constructor(message: string, candidates: string[]) {
    super(message);
    this.name = "PiPackageResolutionError";
    this.candidates = candidates;
  }
}

export interface ResolvedPiParser {
  api: PiParserApi;
  packageRoot: string;
  packageVersion: string;
  identity: ParserIdentity;
}

function failure(candidates: string[], detail: string): PiPackageResolutionError {
  return new PiPackageResolutionError(
    `Could not resolve ${PACKAGE_NAME}. Set ATLAS_PI_PACKAGE to a trusted compatible package directory or dist/index.js. ${detail}`,
    [...candidates],
  );
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function loadSelected(candidate: string, candidates: string[], localResolution = false): Promise<ResolvedPiParser> {
  try {
    const selectedStat = statSync(candidate);
    let packageRoot: string;
    if (selectedStat.isDirectory()) packageRoot = realpathSync(candidate);
    else if (selectedStat.isFile() && basename(candidate) === "index.js" && basename(dirname(candidate)) === "dist") {
      packageRoot = realpathSync(resolve(dirname(candidate), ".."));
    } else throw new TypeError("select a package directory or its regular dist/index.js file");

    const packageJson = join(packageRoot, "package.json");
    if (!statSync(packageJson).isFile()) throw new TypeError("package.json is not a regular file");
    let metadata: unknown;
    try { metadata = JSON.parse(readFileSync(packageJson, "utf8")); }
    catch { throw new TypeError("invalid package.json"); }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) throw new TypeError("invalid package metadata");
    const { name, version } = metadata as { name?: unknown; version?: unknown };
    if (name !== PACKAGE_NAME) throw new TypeError(`expected package name ${PACKAGE_NAME}`);
    if (typeof version !== "string" || !version.trim() || version !== version.trim() || version === "unknown") {
      throw new TypeError("package metadata must establish a nonempty version");
    }

    // Node's import conditions apply to the Atlas-local package. Explicit and
    // global package roots use the documented Pi SDK entry point.
    const entryPoint = realpathSync(localResolution
      ? fileURLToPath(import.meta.resolve(PACKAGE_NAME))
      : join(packageRoot, "dist", "index.js"));
    if (!entryPoint.startsWith(packageRoot + sep) || !statSync(entryPoint).isFile()) {
      throw new TypeError("selected SDK entry must be a regular file inside its package");
    }
    const imported: unknown = await import(pathToFileURL(entryPoint).href);
    if (typeof imported !== "object" || imported === null) throw new TypeError("module namespace is not an object");
    const module = imported as Record<string, unknown>;
    if (typeof module.parseSessionEntries !== "function" || typeof module.migrateSessionEntries !== "function") {
      throw new TypeError("expected callable parseSessionEntries and migrateSessionEntries exports");
    }
    if (module.CURRENT_SESSION_VERSION !== 3) throw new TypeError("expected tested session-format version 3");
    const api = module as unknown as PiParserApi;
    const identity: ParserIdentity = { packageName: PACKAGE_NAME, packageVersion: version,
      modulePath: entryPoint, sessionVersion: api.CURRENT_SESSION_VERSION, codeFingerprint: parserCodeFingerprint(api) };
    identities.set(api, identity);
    return { api, packageRoot, packageVersion: version, identity };
  } catch (error) {
    throw failure(candidates, `Selected ${candidate}: ${message(error)} No fallback was attempted.`);
  }
}

export async function resolvePiParser(): Promise<ResolvedPiParser> {
  const candidates: string[] = [];
  const explicit = process.env.ATLAS_PI_PACKAGE;
  if (explicit !== undefined) {
    if (!explicit.trim()) throw failure(candidates, "ATLAS_PI_PACKAGE is set but empty.");
    // Do not trim meaningful spaces from an actual filesystem path.
    const candidate = resolve(explicit); candidates.push(candidate);
    return loadSelected(candidate, candidates);
  }

  // Use Node's Atlas-anchored lookup paths, excluding legacy globalPaths and
  // NODE_PATH. Detect a selected directory even when its exports/main/metadata
  // are broken, so it cannot disappear behind a later global installation.
  const anchoredDirectories = new Set<string>();
  for (let directory = dirname(fileURLToPath(import.meta.url));;) {
    anchoredDirectories.add(join(directory, "node_modules"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const lookup = createRequire(import.meta.url).resolve.paths(PACKAGE_NAME) ?? [];
  const roots = lookup.filter((path) => anchoredDirectories.has(path)).map((path) => join(path, PACKAGE_NAME));
  roots.push(join(resolve(dirname(process.execPath), ".."), "lib", "node_modules", PACKAGE_NAME));
  const localRoots = new Set(roots.slice(0, -1));
  for (const candidate of new Set(roots)) {
    candidates.push(candidate);
    try {
      if (present(candidate)) return loadSelected(candidate, candidates, localRoots.has(candidate));
    } catch (error) { throw failure(candidates, `Cannot inspect ${candidate}: ${message(error)}`); }
  }

  let npmRoot: string;
  try {
    npmRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
    }).replace(/\r?\n$/, "");
    if (!isAbsolute(npmRoot) || /[\r\n\0]/u.test(npmRoot)) throw new TypeError("npm root -g must return one absolute path");
  } catch (error) { throw failure(candidates, `Local npm root -g lookup failed: ${message(error)}`); }
  const candidate = join(npmRoot, PACKAGE_NAME); candidates.push(candidate);
  return loadSelected(candidate, candidates);
}
