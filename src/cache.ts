import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ATLAS_APPLICATION_ID, CURRENT_SCHEMA_SQL, LEGACY_SCHEMA_SQL } from "./cache-schema.ts";
import { ATLAS_EXTRACTION_VERSION, ATLAS_SCHEMA_VERSION, type CacheCoverage, type CacheIdentity, type ScanAttempt } from "./types.ts";

export class CacheError extends Error {
  readonly code: string;
  constructor(message: string, code = "CACHE_UNRECOGNIZED") { super(message); this.name = "CacheError"; this.code = code; }
}
export function observationEqual(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink;
}
export function optionalStat(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
function privateOwned(stat: Stats): boolean {
  return (process.getuid === undefined || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0;
}
export function validateCachePaths(path: string): void {
  const parent = dirname(resolve(path));
  let ancestor = parent;
  while (!optionalStat(ancestor)) ancestor = dirname(ancestor);
  const directory = lstatSync(ancestor);
  if (!directory.isDirectory() || realpathSync(ancestor) !== ancestor || (ancestor === parent && !privateOwned(directory))) {
    throw new CacheError("cache requires a private owned directory and canonical, non-symlink parent path; choose a new private cache directory", "CACHE_UNSAFE_PATH");
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const stat = optionalStat(path + suffix);
    if (!stat) continue;
    if (!stat.isFile() || stat.nlink !== 1 || !privateOwned(stat)) throw new CacheError(`unsafe cache file or sidecar: ${path + suffix}`, "CACHE_UNSAFE_PATH");
    if ((suffix === "-wal" || suffix === "-journal") && stat.size !== 0) {
      throw new CacheError("cache has a nonempty WAL/journal; finish the owning writer and retry, or use a new cache path; no checkpoint or cleanup was attempted", "CACHE_BUSY");
    }
    if (suffix && !optionalStat(path)) throw new CacheError("orphan cache sidecars are not adopted or removed", "CACHE_UNSAFE_PATH");
  }
}

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
function schema(database: DatabaseSync): SchemaRow[] {
  return (database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all() as SchemaRow[])
    .map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").trim() ?? null }));
}
const signatures = new Map<number, SchemaRow[]>();
function signature(version: number): SchemaRow[] {
  let result = signatures.get(version);
  if (!result) {
    const memory = new DatabaseSync(":memory:");
    try { memory.exec(version === 3 ? LEGACY_SCHEMA_SQL : CURRENT_SCHEMA_SQL); result = schema(memory); }
    finally { memory.close(); }
    signatures.set(version, result);
  }
  return result;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}
export function validateIdentity(value: unknown): asserts value is CacheIdentity {
  if (!object(value)) throw new CacheError("cache/parser identity is missing, unsupported or invalid", "CACHE_IDENTITY_INVALID");
  const parser = value.parser;
  const legacy = value.extractionVersion === 1 || value.extractionVersion === 2 || value.extractionVersion === 3;
  const current = value.extractionVersion === ATLAS_EXTRACTION_VERSION;
  const identityKeys = ["sourceRoot", "schemaVersion", "extractionVersion", "toolHeadBytes", "parser"];
  const hasPathHome = current || value.extractionVersion === 3;
  if (hasPathHome) identityKeys.push("pathHome");
  if ((!legacy && !current) || !keys(value, identityKeys) || typeof value.sourceRoot !== "string" || !isAbsolute(value.sourceRoot) || resolve(value.sourceRoot) !== value.sourceRoot ||
      value.schemaVersion !== ATLAS_SCHEMA_VERSION ||
      (hasPathHome && (typeof value.pathHome !== "string" || !isAbsolute(value.pathHome) || resolve(value.pathHome) !== value.pathHome)) ||
      !Number.isInteger(value.toolHeadBytes) || Number(value.toolHeadBytes) < 0 || Number(value.toolHeadBytes) > 2_147_483_647 ||
      !object(parser) || !keys(parser, ["packageName", "packageVersion", "modulePath", "sessionVersion", "codeFingerprint"]) || !["packageName", "packageVersion", "modulePath"].every((k) => typeof parser[k] === "string" && parser[k] !== "" && parser[k] !== "unknown") ||
      parser.sessionVersion !== 3 || !/^[a-f0-9]{64}$/.test(String(parser.codeFingerprint))) {
    throw new CacheError("cache/parser identity is missing, unsupported or invalid", "CACHE_IDENTITY_INVALID");
  }
}
function parseAttempt(text: string | null): ScanAttempt | null {
  if (text === null) return null;
  const v: unknown = JSON.parse(text);
  if (!object(v) || !keys(v, ["startedAt", "finishedAt", "status", "sourceRoot", "enumerationComplete", "failures", "parseWarnings"]) || !date(v.startedAt) || !(v.finishedAt === null || date(v.finishedAt)) ||
      !["running", "success", "partial", "failed"].includes(String(v.status)) || typeof v.sourceRoot !== "string" ||
      typeof v.enumerationComplete !== "boolean" || !Number.isInteger(v.parseWarnings) || Number(v.parseWarnings) < 0 || !Array.isArray(v.failures) ||
      !v.failures.every((f) => object(f) && keys(f, ["file", "message"]) && typeof f.file === "string" && typeof f.message === "string")) {
    throw new CacheError("invalid cache scan metadata");
  }
  return v as unknown as ScanAttempt;
}
export function cacheCoverage(database: DatabaseSync): CacheCoverage {
  const rows = database.prepare("SELECT id, identity, last_attempt, last_successful_scan FROM cache_metadata").all() as Array<{ id: number; identity: string; last_attempt: string | null; last_successful_scan: string | null }>;
  if (rows.length !== 1 || rows[0]?.id !== 1) throw new CacheError("cache metadata must contain exactly one binding");
  const row = rows[0]!;
  const identity: unknown = JSON.parse(row.identity); validateIdentity(identity);
  if (row.last_successful_scan !== null && !date(row.last_successful_scan)) throw new CacheError("invalid successful scan timestamp");
  const lastAttempt = parseAttempt(row.last_attempt);
  const unverified = new Map<string, { file: string; message: string }>();
  const broad = !lastAttempt || (lastAttempt.sourceRoot === identity.sourceRoot &&
    (lastAttempt.status === "running" || lastAttempt.status === "failed" || !lastAttempt.enumerationComplete));
  if (broad) {
    for (const r of database.prepare("SELECT file FROM catalog ORDER BY file").all()) {
      const file = String(r.file); unverified.set(file, { file, message: "no completed verifying scan for these retained observations" });
    }
  }
  for (const r of database.prepare("SELECT file, message FROM file_health ORDER BY file").all()) {
    const file = String(r.file); unverified.set(file, { file, message: String(r.message) });
  }
  return { basis: "indexed-observations", identity, lastAttempt, lastSuccessfulScan: row.last_successful_scan,
    unverifiedFiles: [...unverified.values()].sort((a, b) => a.file.localeCompare(b.file)) };
}
export interface RecognizedCache { version: 3 | 4; stat: Stats; coverage: CacheCoverage | null }
export function recognizeCache(path: string, integrity = false): RecognizedCache | null {
  validateCachePaths(path);
  const before = optionalStat(path);
  if (!before) return null;
  if (before.size === 0) throw new CacheError("existing empty file is not an Atlas cache; choose an unused cache path");
  let database: DatabaseSync | undefined;
  try {
    // Immutable URI deliberately avoids creating/updating SQLite sidecars.
    // Nonempty WAL/journal is refused above rather than silently ignoring it.
    const uri = pathToFileURL(resolve(path)); uri.search = "mode=ro&immutable=1";
    database = new DatabaseSync(uri.href, { readOnly: true });
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    const application = Number(database.prepare("PRAGMA application_id").get()?.application_id);
    if ((version !== 3 && version !== 4) || application !== (version === 3 ? 0 : ATLAS_APPLICATION_ID) || !isDeepStrictEqual(schema(database), signature(version))) {
      throw new CacheError("unrecognized, unsupported or extended cache format; no modification attempted; choose a new cache path");
    }
    const coverage = version === 4 ? cacheCoverage(database) : null;
    if (integrity && database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") throw new CacheError("cache integrity check failed");
    validateCachePaths(path);
    if (!observationEqual(before, lstatSync(path))) throw new CacheError("cache changed during recognition", "CACHE_CHANGED");
    return { version, stat: before, coverage };
  } catch (e) {
    if (e instanceof CacheError) throw e;
    throw new CacheError(`cache recognition failed without modification: ${e instanceof Error ? e.message : String(e)}`);
  } finally { database?.close(); }
}
