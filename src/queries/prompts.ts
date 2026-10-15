import type { DatabaseSync } from "node:sqlite";

import { UsageError } from "../errors.ts";
import { citationFor, resolveSession } from "../query-db.ts";
import { sessionFromRow } from "./helpers.ts";

export interface PromptOptions {
  since: string;
  until?: string;
  cwdGlob?: string;
  sessionDirectoryGlob?: string;
  sessionReference?: string;
  limit: number;
  maxChars: number;
}

export interface PromptMessage {
  sessionUuid: string;
  entryId: string;
  timestamp: string;
  cwd: string;
  sessionName: string | null;
  excerpt: string;
  textTruncated: boolean;
  textAvailable: boolean;
  onObservedBranch: boolean;
  citation: string;
}

export interface PromptListing {
  authorship: "unverified-user-role";
  limitation: string;
  filters: {
    since: string;
    until: string | null;
    cwdGlob: string | null;
    sessionDirectoryGlob: string | null;
    sessionUuid: string | null;
  };
  selection: {
    ordering: "timestamp-desc,session-uuid-asc,entry-id-asc";
    limit: number;
    maxChars: number;
    totalMatching: number;
    returned: number;
    hasMore: boolean;
    withoutIndexedText: number;
  };
  messages: PromptMessage[];
}

export function validatePromptOptions(options: PromptOptions): void {
  if (!options.since) throw new UsageError("prompts requires --since DATE");
  if (![options.cwdGlob, options.sessionDirectoryGlob, options.sessionReference].some(v => v?.trim())) {
    throw new UsageError("prompts requires --cwd, --dir or --session");
  }
  for (const value of [options.cwdGlob, options.sessionDirectoryGlob, options.sessionReference]) {
    if (value !== undefined && !value.trim()) throw new UsageError("prompt selectors must not be empty");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new UsageError("prompts --limit must be an integer from 1 to 100");
  }
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1 || options.maxChars > 2000) {
    throw new UsageError("--max-chars must be an integer from 1 to 2000");
  }
}

export function listPrompts(database: DatabaseSync, options: PromptOptions): PromptListing {
  validatePromptOptions(options);
  // Identity resolution must not fetch an unbounded first-user-message copy.
  const sessionUuid = options.sessionReference
    ? resolveSession(database, options.sessionReference, { omitFirstUserText: true }).uuid : null;
  const conditions = ["e.role = 'user'", "e.ts >= ?"];
  const parameters: Array<string | number> = [options.since];
  for (const [condition, value] of [
    ["e.ts <= ?", options.until], ["s.cwd GLOB ?", options.cwdGlob],
    ["s.session_dir GLOB ?", options.sessionDirectoryGlob], ["s.uuid = ?", sessionUuid],
  ] as const) {
    if (value !== undefined && value !== null) { conditions.push(condition); parameters.push(value); }
  }
  const population = `FROM entries AS e JOIN sessions AS s ON s.uuid = e.session_uuid
    WHERE ${conditions.join(" AND ")}`;
  // One read snapshot keeps counts and excerpts consistent during concurrent indexing.
  const ownsTransaction = !database.isTransaction;
  if (ownsTransaction) database.exec("BEGIN");
  try {
    const totalMatching = Number(database.prepare(`SELECT count(*) AS n ${population}`).get(...parameters)!.n);
    const candidates = database.prepare(`SELECT e.id, e.ts, e.on_active_path,
      s.uuid, s.cwd, s.name, s.created, s.last_activity
      ${population} ORDER BY e.ts DESC, s.uuid, e.id LIMIT ?`)
      .all(...parameters, options.limit) as Array<Record<string, string | number | null>>;

    // FTS stores nonblank blocks in insertion order. BLOB slicing preserves embedded
    // NUL (SQLite text substr stops there). Four bytes per code point plus a sentinel
    // suffice even for astral text; decode only bounded chunks, never complete messages.
    // Iterate rather than .all(): even thousands of blocks do not accumulate in JS.
    const blocks = database.prepare(`SELECT substr(CAST(content AS BLOB), 1, ?) AS prefix
      FROM text_fts WHERE session_uuid = ? AND entry_id = ? AND kind = 'user'
      ORDER BY rowid LIMIT ?`);
    const messages = candidates.map(row => {
      const session = sessionFromRow(row);
      const points: string[] = [];
      let textAvailable = false;
      for (const block of blocks.iterate((options.maxChars + 1) * 4, session.uuid, String(row.id), options.maxChars + 1)) {
        if (textAvailable) points.push("\n");
        textAvailable = true;
        for (const point of Buffer.from(block.prefix as Uint8Array).toString("utf8")) {
          if (points.length > options.maxChars) break;
          points.push(point);
        }
        if (points.length > options.maxChars) break;
      }
      return {
        sessionUuid: session.uuid, entryId: String(row.id), timestamp: String(row.ts),
        cwd: session.cwd, sessionName: session.name,
        excerpt: points.slice(0, options.maxChars).join(""),
        textTruncated: points.length > options.maxChars, textAvailable,
        onObservedBranch: Boolean(row.on_active_path),
        citation: citationFor(session, String(row.id)),
      };
    });
    return {
      authorship: "unverified-user-role",
      limitation: "Newest-first indexed selection, not a representative sample or verified human requests. Branch membership is observed at indexing, not current model visibility, acceptance or completion.",
      filters: { since: options.since, until: options.until ?? null, cwdGlob: options.cwdGlob ?? null,
        sessionDirectoryGlob: options.sessionDirectoryGlob ?? null, sessionUuid },
      selection: { ordering: "timestamp-desc,session-uuid-asc,entry-id-asc", limit: options.limit,
        maxChars: options.maxChars, totalMatching, returned: messages.length,
        hasMore: totalMatching > messages.length, withoutIndexedText: messages.filter(m => !m.textAvailable).length },
      messages,
    };
  } finally {
    if (ownsTransaction) database.exec("ROLLBACK"); // End the read-only snapshot, including on failure.
  }
}
