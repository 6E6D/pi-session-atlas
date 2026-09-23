import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";

import type { CacheIdentity, CatalogRecord, NormalizedSession, ScanAttempt } from "./types.ts";
import { CacheError, cacheCoverage, observationEqual, optionalStat, recognizeCache, validateCachePaths, validateIdentity } from "./cache.ts";
import { CURRENT_SCHEMA_SQL } from "./cache-schema.ts";
import { ATLAS_SCHEMA_VERSION } from "./types.ts";

const TABLES = ["file_health", "cache_metadata", "text_fts", "tool_calls", "entries", "sessions", "catalog"] as const;

function integer(value: boolean): number {
  return value ? 1 : 0;
}

export interface StoreOpenOptions {
  rebuild?: boolean;
  rebind?: boolean;
  identity?: CacheIdentity;
}

export interface FileMetadata {
  mtimeMs: number;
  size: number;
  ctimeMs?: number;
  device?: number;
  inode?: number;
}

export class AtlasStore {
  readonly databasePath: string;
  readonly schemaRebuilt = false; // No automatic rebuilds.
  readonly existed: boolean;
  private readonly database: DatabaseSync;
  private lockFd: number | undefined;
  private version: number;
  private initialVersion: number;

  constructor(databasePath: string, options: StoreOpenOptions = {}) {
    this.databasePath = resolve(databasePath);
    const known = recognizeCache(this.databasePath, true);
    this.existed = known !== null;
    this.version = this.initialVersion = known?.version ?? ATLAS_SCHEMA_VERSION;
    if (options.rebind && !options.rebuild) throw new CacheError("rebind requires explicit rebuild", "CACHE_REBIND_REQUIRED");
    if (options.identity) validateIdentity(options.identity);
    if (!known && !options.identity) throw new CacheError("new cache requires explicit source/parser identity", "CACHE_IDENTITY_INVALID");
    if (known) {
      if (known.version === 3 && !(options.rebuild && options.rebind && options.identity)) {
        throw new CacheError("legacy v3 has no root binding; use explicit --rebuild --rebind --sessions-dir PATH or a new cache", "CACHE_REBIND_REQUIRED");
      }
      if (options.identity && known.coverage) {
        if (known.coverage.identity.sourceRoot !== options.identity.sourceRoot && !(options.rebuild && options.rebind)) {
          throw new CacheError("source root differs; explicit --rebuild --rebind --sessions-dir PATH required", "CACHE_REBIND_REQUIRED");
        }
        if (!isDeepStrictEqual(known.coverage.identity, options.identity) && !options.rebuild) {
          throw new CacheError("cache parser/extraction/settings identity differs; explicit --rebuild required", "CACHE_IDENTITY_MISMATCH");
        }
      }
      if (options.rebuild && !options.identity) throw new CacheError("rebuild requires validated source/parser identity", "CACHE_IDENTITY_INVALID");
    }
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    validateCachePaths(this.databasePath);
    let database: DatabaseSync | undefined;
    try {
      try { this.lockFd = openSync(this.databasePath + ".lock", constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
      catch (e) { throw new CacheError(`cache writer lock unavailable; no existing lock removed: ${String(e)}`, "CACHE_BUSY"); }
      if (known && !observationEqual(known.stat, lstatSync(this.databasePath))) throw new CacheError("cache changed before writer open", "CACHE_CHANGED");
      if (!known) {
        const fd = openSync(this.databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd);
      }
      const beforeOpen = lstatSync(this.databasePath);
      database = new DatabaseSync(this.databasePath);
      validateCachePaths(this.databasePath);
      if (!observationEqual(beforeOpen, lstatSync(this.databasePath))) throw new CacheError("cache changed during writer open", "CACHE_CHANGED");
      database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
      if (!known) database.exec("PRAGMA journal_mode = WAL;");
      this.database = database;
      if (!known) {
        database.exec("BEGIN IMMEDIATE");
        try { this.createSchema(options.identity!); database.exec("COMMIT"); }
        catch (e) { database.exec("ROLLBACK"); throw e; }
      }
    } catch (e) { database?.close(); this.releaseLock(); throw e; }
  }

  private releaseLock(): void {
    if (this.lockFd === undefined) return;
    try {
      const own = fstatSync(this.lockFd); const path = this.databasePath + ".lock";
      const current = optionalStat(path);
      if (current?.isFile() && current.dev === own.dev && current.ino === own.ino && current.nlink === 1) unlinkSync(path);
    } finally { closeSync(this.lockFd); this.lockFd = undefined; }
  }
  close(): void {
    try { this.database.close(); } finally { this.releaseLock(); }
  }
  private createSchema(identity: CacheIdentity): void {
    this.database.exec(CURRENT_SCHEMA_SQL);
    this.database.prepare("INSERT INTO cache_metadata(id, identity) VALUES (1, ?)").run(JSON.stringify(identity));
  }
  beginRefresh(identity: CacheIdentity, rebuild: boolean): void {
    this.database.exec("BEGIN IMMEDIATE");
    if (rebuild) {
      // Children first; all replacement work is inside this transaction.
      for (const table of TABLES) this.database.exec(`DROP TABLE IF EXISTS ${table}`);
      this.createSchema(identity); this.version = ATLAS_SCHEMA_VERSION;
    }
  }
  finishRefresh(commit: boolean): void {
    this.database.exec(commit ? "COMMIT" : "ROLLBACK");
    if (!commit) this.version = this.initialVersion;
  }
  coverage() { return this.version === 3 ? null : cacheCoverage(this.database); }
  recordAttempt(attempt: ScanAttempt): void {
    if (this.version === 3) return; // Preserve legacy format on failed conversion.
    this.database.prepare("UPDATE cache_metadata SET last_attempt = ?, last_successful_scan = CASE WHEN ? = 'success' THEN ? ELSE last_successful_scan END WHERE id = 1")
      .run(JSON.stringify(attempt), attempt.status, attempt.finishedAt);
  }
  markUnverified(file: string, message: string): void {
    if (this.version !== 3) this.database.prepare("INSERT INTO file_health(file, message) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET message=excluded.message").run(file, message);
  }
  clearHealth(): void { this.database.exec("DELETE FROM file_health"); }

  getCatalog(): Map<string, CatalogRecord> {
    const rows = this.database
      .prepare(
        `SELECT file, mtime_ms, size, indexed_at, session_uuid, entry_count, parse_warnings, ctime_ms, device, inode
         FROM catalog ORDER BY file`,
      )
      .all() as Array<Record<string, string | number | bigint>>;
    const catalog = new Map<string, CatalogRecord>();
    for (const row of rows) {
      const file = String(row.file);
      catalog.set(file, {
        file,
        mtimeMs: Number(row.mtime_ms),
        size: Number(row.size),
        indexedAt: String(row.indexed_at),
        sessionUuid: String(row.session_uuid),
        entryCount: Number(row.entry_count),
        parseWarnings: Number(row.parse_warnings),
        ctimeMs: Number(row.ctime_ms), device: Number(row.device), inode: Number(row.inode),
      });
    }
    return catalog;
  }

  replaceSession(
    session: NormalizedSession,
    metadata: FileMetadata,
    indexedAt: string,
  ): void {
    const conflicting = this.database.prepare("SELECT file FROM sessions WHERE uuid = ? AND file <> ?").get(session.uuid, session.file);
    if (conflicting) throw new CacheError("duplicate session UUID at a different indexed file", "CACHE_SESSION_COLLISION");
    const nested = this.database.isTransaction;
    this.database.exec(nested ? "SAVEPOINT atlas_session" : "BEGIN IMMEDIATE");
    try {
      const old = this.database.prepare("SELECT session_uuid FROM catalog WHERE file = ?").get(session.file) as
        | { session_uuid?: string }
        | undefined;
      if (old?.session_uuid && old.session_uuid !== session.uuid) this.deleteSession(old.session_uuid);
      this.deleteSession(session.uuid);
      this.database.prepare("DELETE FROM catalog WHERE file = ? OR session_uuid = ?").run(session.file, session.uuid);

      this.database
        .prepare(
          `INSERT INTO sessions (
             uuid, file, session_dir, cwd, name, first_user_text, parent_session,
             created, last_activity, entry_count, user_msgs, assistant_msgs,
             tool_results, models, cost_total, tokens_in, tokens_out, cache_read,
             cache_write
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.uuid,
          session.file,
          session.sessionDir,
          session.cwd,
          session.name,
          session.firstUserText,
          session.parentSession,
          session.created,
          session.lastActivity,
          session.entryCount,
          session.userMessages,
          session.assistantMessages,
          session.toolResults,
          JSON.stringify(session.models),
          session.cost,
          session.tokensIn,
          session.tokensOut,
          session.cacheRead,
          session.cacheWrite,
        );

      const insertEntry = this.database.prepare(
        `INSERT INTO entries (
           session_uuid, id, parent_id, type, role, ts, on_active_path,
           child_count, stop_reason, error_message, is_error, model, provider,
           cost, tokens_in, tokens_out, cache_read, cache_write
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of session.entries) {
        insertEntry.run(
          session.uuid,
          entry.id,
          entry.parentId,
          entry.type,
          entry.role,
          entry.timestamp,
          integer(entry.onActivePath),
          entry.childCount,
          entry.stopReason,
          entry.errorMessage,
          integer(entry.isError),
          entry.model,
          entry.provider,
          entry.cost,
          entry.tokensIn,
          entry.tokensOut,
          entry.cacheRead,
          entry.cacheWrite,
        );
      }

      const insertCall = this.database.prepare(
        `INSERT INTO tool_calls (
           session_uuid, entry_id, seq, tool, path_raw, path_resolved, command,
           source, result_entry_id, exit_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const call of session.toolCalls) {
        insertCall.run(
          session.uuid,
          call.entryId,
          call.sequence,
          call.tool,
          call.pathRaw,
          call.pathResolved,
          call.command,
          call.source,
          call.resultEntryId,
          call.exitError === null ? null : integer(call.exitError),
        );
      }

      const insertText = this.database.prepare(
        "INSERT INTO text_fts (content, kind, session_uuid, entry_id, ts) VALUES (?, ?, ?, ?, ?)",
      );
      for (const text of session.texts) {
        insertText.run(text.content, text.kind, session.uuid, text.entryId, text.timestamp);
      }

      this.database
        .prepare(
          `INSERT INTO catalog (
             file, mtime_ms, size, indexed_at, session_uuid, entry_count,
             parse_warnings, ctime_ms, device, inode
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.file,
          metadata.mtimeMs,
          metadata.size,
          indexedAt,
          session.uuid,
          session.entryCount,
          session.warnings.length, metadata.ctimeMs ?? 0, metadata.device ?? 0, metadata.inode ?? 0,
        );
      this.database.prepare("DELETE FROM file_health WHERE file = ?").run(session.file);
      this.database.exec(nested ? "RELEASE atlas_session" : "COMMIT");
    } catch (error) {
      this.database.exec(nested ? "ROLLBACK TO atlas_session; RELEASE atlas_session" : "ROLLBACK");
      throw error;
    }
  }

  removeFile(file: string): boolean {
    const row = this.database.prepare("SELECT session_uuid FROM catalog WHERE file = ?").get(file) as
      | { session_uuid?: string }
      | undefined;
    if (!row?.session_uuid) return false;

    const nested = this.database.isTransaction;
    this.database.exec(nested ? "SAVEPOINT atlas_remove" : "BEGIN IMMEDIATE");
    try {
      this.deleteSession(row.session_uuid);
      this.database.prepare("DELETE FROM catalog WHERE file = ?").run(file);
      this.database.prepare("DELETE FROM file_health WHERE file = ?").run(file);
      this.database.exec(nested ? "RELEASE atlas_remove" : "COMMIT");
      return true;
    } catch (error) {
      this.database.exec(nested ? "ROLLBACK TO atlas_remove; RELEASE atlas_remove" : "ROLLBACK");
      throw error;
    }
  }

  private deleteSession(uuid: string): void {
    this.database.prepare("DELETE FROM text_fts WHERE session_uuid = ?").run(uuid);
    this.database.prepare("DELETE FROM sessions WHERE uuid = ?").run(uuid);
  }

  countSessions(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM sessions").get() as {
      count: number | bigint;
    };
    return Number(row.count);
  }

  countEntries(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM entries").get() as {
      count: number | bigint;
    };
    return Number(row.count);
  }

  databaseBytes(): number {
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return existsSync(this.databasePath) ? statSync(this.databasePath).size : 0;
  }

  /** Test/query seam; production command modules get narrower methods later. */
  rawDatabase(): DatabaseSync {
    return this.database;
  }
}
