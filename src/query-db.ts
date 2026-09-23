import { lstatSync } from "node:fs";
import { CacheError, observationEqual, recognizeCache, validateCachePaths } from "./cache.ts";
import { DatabaseSync } from "node:sqlite";

import { ATLAS_EXTRACTION_VERSION, ATLAS_SCHEMA_VERSION } from "./types.ts";

export interface SessionIdentity {
  uuid: string;
  file: string;
  cwd: string;
  name: string | null;
  firstUserText: string | null;
  created: string;
  lastActivity: string;
}

export class AtlasQueryError extends Error {
  readonly code: string;

  constructor(message: string, code = "QUERY_FAILED") {
    super(message);
    this.name = "AtlasQueryError";
    this.code = code;
  }
}

export function openQueryDatabase(databasePath: string): DatabaseSync {
  const known = recognizeCache(databasePath);
  if (!known) {
    throw new AtlasQueryError(`Atlas database not found at ${databasePath}; run 'atlas index' first`, "DATABASE_NOT_FOUND");
  }
  if (known.version !== ATLAS_SCHEMA_VERSION) {
    throw new AtlasQueryError("recognized legacy v3 cache requires explicit --rebuild --rebind --sessions-dir PATH, or a new cache path", "DATABASE_SCHEMA_MISMATCH");
  }
  if (known.coverage?.identity.extractionVersion !== ATLAS_EXTRACTION_VERSION) {
    throw new CacheError("recognized cache uses an older extraction interpretation; explicit index --rebuild or a new cache path required; preserve the old cache if originals are unavailable", "CACHE_EXTRACTION_MISMATCH");
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    validateCachePaths(databasePath);
    if (!observationEqual(known.stat, lstatSync(databasePath))) throw new CacheError("cache changed during query open", "CACHE_CHANGED");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function resolveSession(database: DatabaseSync, reference: string): SessionIdentity {
  if (reference.length === 0) throw new AtlasQueryError("session reference must not be empty", "SESSION_NOT_FOUND");
  const exact = database
    .prepare(
      `SELECT uuid, file, cwd, name, first_user_text, created, last_activity
       FROM sessions WHERE uuid = ?`,
    )
    .get(reference) as Record<string, string | null> | undefined;
  if (exact) return toSessionIdentity(exact);

  const rows = database
    .prepare(
      `SELECT uuid, file, cwd, name, first_user_text, created, last_activity
       FROM sessions
       WHERE substr(uuid, 1, length(?)) = ?
       ORDER BY uuid LIMIT 2`,
    )
    .all(reference, reference) as Array<Record<string, string | null>>;
  if (rows.length === 0) throw new AtlasQueryError(`session not found: ${reference}`, "SESSION_NOT_FOUND");
  if (rows.length > 1) {
    throw new AtlasQueryError(
      `session reference is ambiguous: ${reference} (${rows.map((row) => row.uuid).join(", ")})`,
      "SESSION_AMBIGUOUS",
    );
  }
  return toSessionIdentity(rows[0]!);
}

function toSessionIdentity(row: Record<string, string | null>): SessionIdentity {
  return {
    uuid: String(row.uuid),
    file: String(row.file),
    cwd: String(row.cwd),
    name: row.name === null ? null : String(row.name),
    firstUserText: row.first_user_text === null ? null : String(row.first_user_text),
    created: String(row.created),
    lastActivity: String(row.last_activity),
  };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateDisplay(value: string, maximum = 120): string {
  const normalized = oneLine(value);
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

export function citationFor(session: SessionIdentity, entryId?: string | null): string {
  const pointer = entryId ? `\`${session.uuid}\`#${entryId}` : `\`${session.uuid}\``;
  const date = session.created.slice(0, 10) || "unknown-date";
  const description = truncateDisplay(
    session.name || session.firstUserText || `Pi session in ${session.cwd}`,
  );
  return `${pointer} (${date}), ${description}`;
}
