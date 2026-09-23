import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { CacheError, observationEqual, validateIdentity } from "./cache.ts";
import { UsageError } from "./errors.ts";
import { extractSession } from "./extract.ts";
import { parserCodeFingerprint, parserIdentityFor, resolvePiParser } from "./resolve-pi.ts";
import { AtlasStore } from "./store.ts";
import type { CacheIdentity, IndexFailure, IndexOptions, IndexResult, PiParserApi, ScanAttempt } from "./types.ts";
import { ATLAS_EXTRACTION_VERSION, ATLAS_SCHEMA_VERSION, DEFAULT_TOOL_HEAD_BYTES } from "./types.ts";

function discover(directory: string, failures: IndexFailure[]) {
  const files: string[] = []; const directories = new Map<string, Stats>();
  const visit = (path: string): void => {
    try {
      const before = lstatSync(path);
      if (!before.isDirectory() || realpathSync(path) !== path) throw new Error("unsafe or substituted source directory");
      directories.set(path, before);
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(path, entry.name);
        if (entry.isSymbolicLink()) failures.push({ file: child, message: "source symlink excluded; coverage is unverified" });
        else if (entry.isDirectory()) visit(child);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
        else if (entry.name.endsWith(".jsonl")) failures.push({ file: child, message: "nonregular source excluded" });
      }
    } catch (e) { failures.push({ file: path, message: `source enumeration failed: ${String(e)}` }); }
  };
  visit(directory); return { files, directories };
}
function metadata(stat: Stats) {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, device: stat.dev, inode: stat.ino };
}
function assertSupportedSource(content: string): void {
  for (const line of content.trim().split("\n")) {
    let value: unknown; try { value = JSON.parse(line); } catch { continue; }
    if (typeof value === "object" && value !== null && "type" in value && value.type === "session") {
      const version = (value as { version?: unknown }).version ?? 1;
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 3) {
        throw new Error("unsupported source session version; rebuilding is not a parser compatibility remedy");
      }
      return;
    }
  }
}
export async function indexSessions(options: IndexOptions, injectedParser?: PiParserApi): Promise<IndexResult> {
  const started = performance.now();
  if (options.rebind && !options.rebuild) throw new UsageError("--rebind requires --rebuild and an explicit source root");
  const toolHeadBytes = options.toolHeadBytes ?? DEFAULT_TOOL_HEAD_BYTES;
  if (!Number.isInteger(toolHeadBytes) || toolHeadBytes < 0 || toolHeadBytes > 2_147_483_647) throw new UsageError("invalid toolHeadBytes");
  const parser = injectedParser ?? (await resolvePiParser()).api;
  const declared = injectedParser ? options.parserIdentity ?? parserIdentityFor(parser) : parserIdentityFor(parser);
  if (!declared) throw new CacheError("injected parser identity is required", "CACHE_IDENTITY_INVALID");
  const sessionsDirectory = realpathSync(resolve(options.sessionsDirectory));
  const rootBefore = lstatSync(sessionsDirectory);
  if (!rootBefore.isDirectory()) throw new CacheError("source root is not a directory", "CACHE_SOURCE_ROOT_INVALID");
  accessSync(sessionsDirectory, constants.R_OK | constants.X_OK);
  const pathHome = resolve(options.pathHome ?? homedir());
  const identity: CacheIdentity = { sourceRoot: sessionsDirectory, pathHome, schemaVersion: ATLAS_SCHEMA_VERSION,
    extractionVersion: ATLAS_EXTRACTION_VERSION, toolHeadBytes,
    parser: { ...declared, sessionVersion: parser.CURRENT_SESSION_VERSION, codeFingerprint: parserCodeFingerprint(parser) } };
  validateIdentity(identity);
  const databasePath = resolve(options.databasePath);
  // Mutable cache state is never part of the source tree being enumerated.
  const cacheRelative = relative(sessionsDirectory, databasePath);
  if (cacheRelative === "" || (cacheRelative !== ".." && !cacheRelative.startsWith(".." + sep) && !cacheRelative.startsWith(sep))) {
    throw new CacheError("cache must be outside the source root", "CACHE_UNSAFE_PATH");
  }
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const startedAt = now();
  const store = new AtlasStore(databasePath, { identity, rebuild: options.rebuild, rebind: options.rebind });
  let transaction = false;
  let filesChanged = 0, filesUnchanged = 0, filesRemoved = 0, sessionsIndexed = 0, entriesIndexed = 0, parseWarnings = 0;
  const failures: IndexFailure[] = [];
  const attempt: ScanAttempt = { startedAt, finishedAt: null, status: "running", sourceRoot: sessionsDirectory,
    enumerationComplete: false, failures, parseWarnings: 0 };
  try {
    const priorUnverified = store.coverage()?.unverifiedFiles ?? [];
    const priorHealth = new Set(priorUnverified.map((v) => v.file));
    // Materialize derived uncertainty before replacing its attempt metadata.
    // These reasons survive rollback (including a different-root attempt) or
    // interruption; only the transactional successful observations clear them.
    for (const { file, message } of priorUnverified) store.markUnverified(file, message);
    store.recordAttempt(attempt);
    // Any replacement is one transaction, including schema, corpus and binding.
    transaction = true; store.beginRefresh(identity, options.rebuild === true);
    store.recordAttempt(attempt);
    const catalog = store.getCatalog();
    for (const file of catalog.keys()) {
      const r = relative(sessionsDirectory, file);
      if (!r || r === ".." || r.startsWith(".." + sep) || r.startsWith(sep)) throw new CacheError("catalog file outside bound root", "CACHE_SCOPE_INVALID");
    }
    const { files, directories } = discover(sessionsDirectory, failures);
    attempt.enumerationComplete = failures.length === 0;
    const live = new Set(files);
    const observations = new Map<string, Stats>();
    // Delete only proved-absent paths after successful traversal. If a race is
    // detected below, roll back these deletions along with the refresh.
    if (attempt.enumerationComplete) for (const file of catalog.keys()) {
      if (!live.has(file) && store.removeFile(file)) filesRemoved++;
    }
    store.clearHealth();
    for (const file of files) {
      let fd: number | undefined;
      try {
        if (realpathSync(file) !== file) throw new Error("source path contains a substituted symlink");
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = fstatSync(fd);
        if (!before.isFile()) throw new Error("source is not a regular file");
        const current = metadata(before); const old = catalog.get(file);
        if (!priorHealth.has(file) && old && Object.entries(current).every(([k, v]) => old[k as keyof typeof old] === v)) {
          if (!observationEqual(before, lstatSync(file))) throw new Error("source changed during unchanged-file check");
          filesUnchanged++; observations.set(file, before); continue;
        }
        const content = readFileSync(fd, "utf8");
        assertSupportedSource(content);
        const session = extractSession(content, file, parser, { toolHeadBytes, pathHome });
        const indexedAt = now();
        if (!observationEqual(before, fstatSync(fd)) || !observationEqual(before, lstatSync(file)) || realpathSync(file) !== file) throw new Error("source changed during reading; retry when stable");
        store.replaceSession(session, current, indexedAt);
        filesChanged++; sessionsIndexed++; entriesIndexed += session.entryCount; parseWarnings += session.warnings.length;
        observations.set(file, before);
      } catch (e) { failures.push({ file, message: e instanceof Error ? e.message : String(e) }); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    for (const [file, observed] of observations) {
      try { if (!observationEqual(observed, lstatSync(file)) || realpathSync(file) !== file) throw new Error("source changed after observation; cached result is unverified"); }
      catch (e) { failures.push({ file, message: String(e) }); }
    }
    let directoryRace = false;
    directories.set(sessionsDirectory, rootBefore);
    for (const [path, before] of directories) {
      try { if (!observationEqual(before, lstatSync(path)) || realpathSync(path) !== path) throw new Error("source directory changed during scan"); }
      catch (e) { directoryRace = true; attempt.enumerationComplete = false; failures.push({ file: path, message: String(e) }); }
    }
    const rollback = directoryRace || (store.existed && options.rebuild === true && failures.length > 0);
    attempt.finishedAt = now();
    attempt.status = rollback ? "failed" : failures.length ? "partial" : "success";
    attempt.parseWarnings = [...store.getCatalog().values()].reduce((n, r) => n + r.parseWarnings, 0);
    for (const failure of failures) store.markUnverified(failure.file, failure.message);
    if (!attempt.enumerationComplete) for (const file of catalog.keys()) store.markUnverified(file, "source traversal incomplete; presence and currency unverified");
    store.recordAttempt(attempt);
    store.finishRefresh(!rollback); transaction = false;
    if (rollback) {
      store.recordAttempt(attempt);
      const coverage = store.coverage();
      if (coverage?.identity.sourceRoot === sessionsDirectory) {
        for (const file of store.getCatalog().keys()) store.markUnverified(file, "failed refresh/rebuild; previous evidence retained, currency unverified");
      }
    }
    return { databasePath, sessionsDirectory, rebuilt: options.rebuild === true && !rollback,
      filesScanned: files.length, filesChanged: rollback ? 0 : filesChanged, filesUnchanged: rollback ? 0 : filesUnchanged,
      filesRemoved: rollback ? 0 : filesRemoved, sessionsIndexed: rollback ? 0 : sessionsIndexed, entriesIndexed: rollback ? 0 : entriesIndexed,
      parseWarnings, failures, durationMs: Math.round((performance.now() - started) * 100) / 100,
      databaseBytes: store.databaseBytes(), committed: !rollback, coverage: store.coverage() };
  } catch (e) {
    if (transaction && store.rawDatabase().isTransaction) store.finishRefresh(false);
    attempt.status = "failed"; attempt.finishedAt = new Date().toISOString(); attempt.failures.push({ file: sessionsDirectory, message: String(e) });
    store.recordAttempt(attempt);
    throw e;
  } finally { store.close(); }
}
