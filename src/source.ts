import { constants, type Stats } from "node:fs";
import { cacheCoverage } from "./cache.ts";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { migrateDeterministically } from "./extract.ts";
import { AtlasQueryError, type SessionIdentity } from "./query-db.ts";
import { resolvePiParser } from "./resolve-pi.ts";
import type { PiParserApi } from "./types.ts";

export type SourceRecord = Record<string, unknown>;
export const LEGACY_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
export const LEGACY_SOURCE_MAX_RECORDS = 100_000;

export interface SourceEvidence {
  basis: "source-identity";
  indexState: "metadata-match" | "metadata-different" | "not-catalogued" | "unverified";
  formatVersion: number;
  reader: "streaming" | "bounded-normalization";
  skippedRecords: number;
}

function object(value: unknown): SourceRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as SourceRecord : null;
}

async function* chunks(handle: FileHandle, maximum = Infinity): AsyncGenerator<Buffer> {
  let position = 0;
  while (position < maximum) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maximum - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

async function* lines(handle: FileHandle): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const buffer of chunks(handle)) {
    const text = decoder.write(buffer);
    let start = 0;
    let end: number;
    while ((end = text.indexOf("\n", start)) !== -1) {
      yield pending + text.slice(start, end);
      pending = "";
      start = end + 1;
    }
    pending += text.slice(start);
  }
  pending += decoder.end();
  if (pending) yield pending;
}

function parse(line: string): unknown {
  try { return JSON.parse(line); } catch { return undefined; }
}

async function* modernRecords(handle: FileHandle): AsyncGenerator<unknown> {
  // Pi trims the complete source, not each internal line. One-record
  // lookahead preserves that rule without materializing the whole file.
  let pending: string | undefined;
  let first = true;
  for await (const line of lines(handle)) {
    if (!line.trim()) continue;
    if (pending !== undefined) yield parse(pending);
    pending = first ? line.trimStart() : line;
    first = false;
  }
  if (pending !== undefined) yield parse(pending.trimEnd());
}

function sourceVersion(header: SourceRecord): number {
  const version = header.version ?? 1;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new AtlasQueryError("source has an invalid session version", "SOURCE_FORMAT_INVALID");
  }
  if (version > 3) {
    throw new AtlasQueryError(`source version ${version} is not supported by this source reader (v1–v3); a compatible reader is required`, "SOURCE_VERSION_UNSUPPORTED");
  }
  return version;
}

async function legacyRecords(handle: FileHandle, before: Stats, parser?: PiParserApi): Promise<{ raw: unknown[]; normalized: unknown[]; skipped: number }> {
  const limit = (): never => { throw new AtlasQueryError(`legacy source exceeds the bounded reader limit (${LEGACY_SOURCE_MAX_BYTES} bytes or ${LEGACY_SOURCE_MAX_RECORDS} parsed records); use a separately reviewed source reader`, "SOURCE_LEGACY_LIMIT"); };
  if (before.size > LEGACY_SOURCE_MAX_BYTES) limit();
  // Read at most cap + 1 bytes even if the file grows after the initial stat.
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of chunks(handle, LEGACY_SOURCE_MAX_BYTES + 1)) {
    bytes += chunk.length;
    if (bytes > LEGACY_SOURCE_MAX_BYTES) limit();
    buffers.push(chunk);
  }
  const content = Buffer.concat(buffers).toString("utf8");
  const api = parser ?? (await resolvePiParser()).api;
  if (api.CURRENT_SESSION_VERSION !== 3) {
    throw new AtlasQueryError(`legacy display requires a Pi parser with tested session-format version 3; resolved format version ${api.CURRENT_SESSION_VERSION}`, "SOURCE_PARSER_INCOMPATIBLE");
  }
  try {
    // Preserve source JSON values independently of the parser. Its parsed
    // record sequence must agree before applying the shared migration, because
    // legacy IDs are based on parsed-record positions, not physical line numbers.
    const raw: unknown[] = [];
    let nonBlankLines = 0;
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      nonBlankLines++;
      try { raw.push(JSON.parse(line)); } catch { continue; }
      if (raw.length > LEGACY_SOURCE_MAX_RECORDS) limit();
    }
    const normalized = api.parseSessionEntries(content);
    if (!isDeepStrictEqual(raw, normalized)) throw new Error("parser changed raw values or parsed-record positions");
    migrateDeterministically(normalized, api);
    return { raw, normalized, skipped: nonBlankLines - raw.length };
  } catch (error) {
    if (error instanceof AtlasQueryError) throw error;
    throw new AtlasQueryError(`legacy source normalization failed with the resolved Pi parser: ${error instanceof Error ? error.message : String(error)}`, "SOURCE_PARSER_INCOMPATIBLE");
  }
}

function sameObservation(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Read-only observation, not a hash comparison against the indexed content. */
export async function inspectSource(
  database: DatabaseSync,
  session: SessionIdentity,
  targetEntryId?: string,
  visit?: (normalized: SourceRecord, raw: SourceRecord) => void,
  options: { parser?: PiParserApi } = {},
): Promise<SourceEvidence> {
  let handle: FileHandle | undefined;
  try {
    const root = cacheCoverage(database).identity.sourceRoot;
    const child = relative(root, session.file);
    if (!isAbsolute(session.file) || resolve(session.file) !== session.file || resolve(root) !== root ||
        !child || child === ".." || child.startsWith(".." + sep) || isAbsolute(child)) {
      throw new AtlasQueryError(`source path is outside the canonical bound root: ${session.file}`, "SOURCE_UNSAFE_PATH");
    }
    if (await realpath(session.file) !== session.file) {
      throw new AtlasQueryError(`source path contains a substituted alias: ${session.file}`, "SOURCE_UNSAFE_PATH");
    }
    const pathBefore = await lstat(session.file);
    if (!pathBefore.isFile()) throw new AtlasQueryError(`source is not a regular file: ${session.file}`, "SOURCE_NOT_REGULAR");
    // No-follow protects the leaf; canonical-path checks also catch ordinary
    // ancestor substitutions. This is not an atomic hostile-filesystem sandbox.
    handle = await open(session.file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) throw new AtlasQueryError(`source is not a regular file: ${session.file}`, "SOURCE_NOT_REGULAR");
    if (!sameObservation(pathBefore, before) || await realpath(session.file) !== session.file) {
      throw new AtlasQueryError(`source changed before reading; retry when stable: ${session.file}`, "SOURCE_CHANGED_DURING_READ");
    }
    let header: SourceRecord | null = null;
    for await (const line of lines(handle)) {
      const record = object(parse(line.trim()));
      if (record?.type === "session") { header = record; break; }
    }
    if (!header) throw new AtlasQueryError(`source session header not found: ${session.file}`, "SOURCE_FORMAT_INVALID");
    if (header.id !== session.uuid) throw new AtlasQueryError(`source session identity differs from indexed ${session.uuid}: ${session.file}`, "SOURCE_IDENTITY_MISMATCH");
    const version = sourceVersion(header);
    let headers = 0;
    let targets = 0;
    let skipped = 0;
    const accept = (value: unknown, original: unknown): void => {
      const record = object(value);
      const raw = object(original);
      if (!record || !raw) { skipped++; return; }
      if (record.type === "session") {
        if (++headers > 1) throw new AtlasQueryError(`multiple source session headers: ${session.file}`, "SOURCE_FORMAT_INVALID");
        if (record.id !== session.uuid) throw new AtlasQueryError(`source identity changed while reading: ${session.file}`, "SOURCE_CHANGED_DURING_READ");
        return;
      }
      if (typeof record.id !== "string") { skipped++; return; }
      if (record.id === targetEntryId && ++targets > 1) {
        throw new AtlasQueryError(`source entry ${targetEntryId} is not unique: ${session.file}`, "SOURCE_ENTRY_AMBIGUOUS");
      }
      visit?.(record, raw);
    };
    if (version < 3) {
      const legacy = await legacyRecords(handle, before, options.parser);
      skipped += legacy.skipped;
      legacy.normalized.forEach((record, index) => accept(record, legacy.raw[index]));
    } else {
      for await (const record of modernRecords(handle)) accept(record, record);
    }
    // Compare the same open descriptor AND the path, including inode/ctime, to
    // detect ordinary appends, edits and replacements during this observation.
    if (!sameObservation(before, await handle.stat()) || !sameObservation(before, await lstat(session.file)) || await realpath(session.file) !== session.file) {
      throw new AtlasQueryError(`source changed during reading; retry when stable: ${session.file}`, "SOURCE_CHANGED_DURING_READ");
    }
    if (headers !== 1) throw new AtlasQueryError(`source contains no valid session header: ${session.file}`, "SOURCE_FORMAT_INVALID");
    if (targetEntryId !== undefined && targets === 0) {
      throw new AtlasQueryError(`indexed entry ${targetEntryId} is not present in the current source: ${session.file}; inspect the source and index before refreshing`, "SOURCE_ENTRY_NOT_FOUND");
    }
    const catalog = database.prepare("SELECT mtime_ms, size FROM catalog WHERE file = ? AND session_uuid = ?").get(session.file, session.uuid) as { mtime_ms: number; size: number } | undefined;
    const unverified = cacheCoverage(database).unverifiedFiles.some((value) => value.file === session.file);
    return {
      basis: "source-identity",
      indexState: !catalog ? "not-catalogued" : unverified ? "unverified" : catalog.mtime_ms === before.mtimeMs && catalog.size === before.size ? "metadata-match" : "metadata-different",
      formatVersion: version,
      reader: version < 3 ? "bounded-normalization" : "streaming",
      skippedRecords: skipped,
    };
  } catch (error) {
    if (error instanceof AtlasQueryError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      if (handle) throw new AtlasQueryError(`source disappeared during reading; retry when stable: ${session.file}`, "SOURCE_CHANGED_DURING_READ");
      throw new AtlasQueryError(`source session file no longer exists: ${session.file}`, "SOURCE_NOT_FOUND");
    }
    if (code === "ELOOP") {
      throw new AtlasQueryError(`source path contains an unsafe alias: ${session.file}`, handle ? "SOURCE_CHANGED_DURING_READ" : "SOURCE_UNSAFE_PATH");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new AtlasQueryError(`source session file is not readable: ${session.file}`, "SOURCE_UNREADABLE");
    }
    throw error;
  } finally { await handle?.close(); }
}
