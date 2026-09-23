import type { DatabaseSync } from "node:sqlite";

import { UsageError } from "../errors.ts";
import { AtlasQueryError, citationFor, type SessionIdentity } from "../query-db.ts";
import type { TextKind } from "../types.ts";

export interface SearchOptions {
  query: string;
  kinds?: TextKind[];
  sessionDirectoryGlob?: string;
  cwdGlob?: string;
  since?: string;
  until?: string;
  exact?: boolean;
  fts?: boolean;
  limit: number;
}

export interface SearchResult {
  sessionUuid: string;
  sessionName: string | null;
  cwd: string;
  entryId: string;
  timestamp: string;
  kind: string;
  snippet: string;
  rank: number | null;
  citation: string;
}

// unicode61's default token categories. FTS still performs the actual
// tokenization/stemming; Atlas does not delete punctuation or fold case.
const SEARCHABLE = /[\p{L}\p{N}\p{Co}]/u;

export function prepareSearchQuery(options: Pick<SearchOptions, "query" | "exact" | "fts">): string {
  if (options.exact && options.fts) throw new UsageError("--exact and --fts are mutually exclusive");
  if (!options.query.trim()) throw new UsageError("search requires non-empty text");
  if (options.query.includes("\0")) throw new UsageError("search text must not contain NUL characters");
  if (options.exact) return options.query;
  if (options.fts) {
    if (!SEARCHABLE.test(options.query)) throw new UsageError("FTS search requires searchable text");
    return options.query;
  }
  return options.query.trim().split(/\s+/u).map((chunk) => {
    if (!SEARCHABLE.test(chunk)) {
      throw new UsageError("plain search contains a chunk without searchable text; use --exact for punctuation-only text");
    }
    return `"${chunk.replaceAll('"', '""')}"`;
  }).join(" AND ");
}

export function search(database: DatabaseSync, options: SearchOptions): SearchResult[] {
  const query = prepareSearchQuery(options);
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];

  if (options.exact) {
    conditions.push("instr(f.content, ?) > 0");
    parameters.push(query);
  } else {
    conditions.push("text_fts MATCH ?");
    parameters.push(query);
  }
  if (options.kinds && options.kinds.length > 0) {
    conditions.push(`f.kind IN (${options.kinds.map(() => "?").join(", ")})`);
    parameters.push(...options.kinds);
  }
  if (options.sessionDirectoryGlob) {
    conditions.push("s.session_dir GLOB ?");
    parameters.push(options.sessionDirectoryGlob);
  }
  if (options.cwdGlob) {
    conditions.push("s.cwd GLOB ?");
    parameters.push(options.cwdGlob);
  }
  if (options.since) {
    conditions.push("f.ts >= ?");
    parameters.push(options.since);
  }
  if (options.until) {
    conditions.push("f.ts <= ?");
    parameters.push(options.until);
  }
  parameters.push(options.limit);

  const rankExpression = options.exact ? "NULL" : "bm25(text_fts)";
  const snippetExpression = options.exact
    ? "substr(f.content, 1, 300)"
    : "snippet(text_fts, 0, '[', ']', '…', 32)";
  // SQL/schema preparation failures are not user FTS syntax errors.
  const statement = database.prepare(
    `SELECT f.content, f.kind, f.session_uuid, f.entry_id, f.ts,
            ${rankExpression} AS rank, ${snippetExpression} AS snippet,
            s.file, s.cwd, s.name, s.first_user_text, s.created,
            s.last_activity
     FROM text_fts AS f
     JOIN sessions AS s ON s.uuid = f.session_uuid
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${options.exact ? "f.ts DESC" : "rank ASC, f.ts DESC"}
     LIMIT ?`,
  );
  try {
    const rows = statement.all(...parameters) as Array<Record<string, string | number | null>>;

    return rows.map((row) => {
      const session: SessionIdentity = {
        uuid: String(row.session_uuid),
        file: String(row.file),
        cwd: String(row.cwd),
        name: row.name === null ? null : String(row.name),
        firstUserText: row.first_user_text === null ? null : String(row.first_user_text),
        created: String(row.created),
        lastActivity: String(row.last_activity),
      };
      const entryId = String(row.entry_id);
      return {
        sessionUuid: session.uuid,
        sessionName: session.name,
        cwd: session.cwd,
        entryId,
        timestamp: String(row.ts),
        kind: String(row.kind),
        snippet: String(row.snippet),
        rank: row.rank === null ? null : Number(row.rank),
        citation: citationFor(session, entryId),
      };
    });
  } catch (error) {
    if (options.fts && error instanceof Error &&
        /^(?:fts5: (?:syntax error|unterminated string|no such column)|unterminated string|no such column:|malformed MATCH expression:|expected integer, got )/i.test(error.message)) {
      throw new AtlasQueryError(`invalid FTS query ${JSON.stringify(options.query)}: ${error.message}`, "INVALID_FTS_QUERY");
    }
    throw error;
  }
}
