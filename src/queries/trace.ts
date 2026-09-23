import { isAbsolute, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { citationFor } from "../query-db.ts";
import { sessionFromRow } from "./helpers.ts";

export interface TraceOptions {
  file: string;
  /** Apply SQLite GLOB semantics deliberately; literal matching is the default. */
  glob?: boolean;
  since?: string;
  limit: number;
}

export interface TraceResult {
  sessionUuid: string;
  sessionName: string | null;
  cwd: string;
  entryId: string;
  timestamp: string;
  tool: string;
  pathRaw: string;
  pathResolved: string;
  source: string;
  citation: string;
}

export function traceFile(database: DatabaseSync, options: TraceOptions): TraceResult[] {
  const conditions: string[] = ["tc.path_resolved IS NOT NULL"];
  const parameters: Array<string | number> = [];
  const query = normalize(options.file);
  if (options.glob) {
    if (isAbsolute(options.file)) {
      conditions.push("(tc.path_resolved GLOB ? OR tc.path_raw GLOB ?)");
      parameters.push(options.file, options.file);
    } else {
      conditions.push("(tc.path_raw GLOB ? OR tc.path_resolved GLOB ? OR tc.path_resolved GLOB ?)");
      parameters.push(options.file, options.file, `*/${options.file}`);
    }
  } else if (isAbsolute(query)) {
    conditions.push("tc.path_resolved = ?");
    parameters.push(query);
  } else {
    const suffix = `/${query}`;
    conditions.push("(tc.path_raw = ? OR tc.path_resolved = ? OR substr(tc.path_resolved, -length(?)) = ?)");
    parameters.push(options.file, query, suffix, suffix);
  }
  if (options.since) {
    conditions.push("e.ts >= ?");
    parameters.push(options.since);
  }
  parameters.push(options.limit);

  const rows = database
    .prepare(
      `SELECT tc.entry_id, tc.tool, tc.path_raw, tc.path_resolved, tc.source,
              e.ts, s.uuid, s.file, s.cwd, s.name, s.first_user_text,
              s.created, s.last_activity
       FROM tool_calls AS tc
       JOIN entries AS e ON e.session_uuid = tc.session_uuid AND e.id = tc.entry_id
       JOIN sessions AS s ON s.uuid = tc.session_uuid
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.ts DESC, s.uuid, tc.seq
       LIMIT ?`,
    )
    .all(...parameters) as Array<Record<string, string | number | null>>;

  return rows.map((row) => {
    const session = sessionFromRow(row);
    const entryId = String(row.entry_id);
    return {
      sessionUuid: session.uuid,
      sessionName: session.name,
      cwd: session.cwd,
      entryId,
      timestamp: String(row.ts),
      tool: String(row.tool),
      pathRaw: String(row.path_raw),
      pathResolved: String(row.path_resolved),
      source: String(row.source),
      citation: citationFor(session, entryId),
    };
  });
}
