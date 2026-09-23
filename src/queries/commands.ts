import type { DatabaseSync } from "node:sqlite";

import { citationFor, truncateDisplay } from "../query-db.ts";
import { sessionFromRow } from "./helpers.ts";

export interface CommandSearchOptions {
  pattern: string;
  failed?: boolean;
  cwdGlob?: string;
  since?: string;
  until?: string;
  limit: number;
}

export interface CommandResult {
  sessionUuid: string;
  sessionName: string | null;
  cwd: string;
  entryId: string;
  timestamp: string;
  command: string;
  failed: boolean | null;
  outputHead: string | null;
  citation: string;
}

export function searchCommands(
  database: DatabaseSync,
  options: CommandSearchOptions,
): CommandResult[] {
  const conditions = ["tc.command IS NOT NULL"];
  const parameters: Array<string | number> = [];
  const hasGlob = /[*?\[]/.test(options.pattern);
  if (hasGlob) {
    conditions.push("tc.command GLOB ?");
    parameters.push(options.pattern);
  } else {
    conditions.push("instr(lower(tc.command), lower(?)) > 0");
    parameters.push(options.pattern);
  }
  if (options.failed) conditions.push("tc.exit_error = 1");
  if (options.cwdGlob) {
    conditions.push("s.cwd GLOB ?");
    parameters.push(options.cwdGlob);
  }
  if (options.since) {
    conditions.push("e.ts >= ?");
    parameters.push(options.since);
  }
  if (options.until) {
    conditions.push("e.ts <= ?");
    parameters.push(options.until);
  }
  parameters.push(options.limit);

  const rows = database
    .prepare(
      // Materialization prevents SQLite from expanding output heads for
      // candidates later discarded by the ordered LIMIT. No store change.
      `WITH candidates AS MATERIALIZED (
         SELECT tc.entry_id, tc.seq, tc.source, tc.command, tc.exit_error, tc.result_entry_id,
                e.ts, s.uuid, s.file, s.cwd, s.name, s.first_user_text,
                s.created, s.last_activity
         FROM tool_calls AS tc
         JOIN entries AS e ON e.session_uuid = tc.session_uuid AND e.id = tc.entry_id
         JOIN sessions AS s ON s.uuid = tc.session_uuid
         WHERE ${conditions.join(" AND ")}
         ORDER BY e.ts DESC, s.uuid, tc.seq, tc.entry_id, tc.source
         LIMIT ?
       )
       SELECT c.*,
              CASE WHEN c.result_entry_id IS NULL THEN NULL ELSE
                (SELECT group_concat(content, char(10)) FROM text_fts
                 WHERE session_uuid = c.uuid AND entry_id = c.result_entry_id
                   AND kind = 'tool_head') END AS output_head
       FROM candidates AS c
       ORDER BY c.ts DESC, c.uuid, c.seq, c.entry_id, c.source`,
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
      command: String(row.command),
      failed: row.exit_error === null ? null : Number(row.exit_error) === 1,
      outputHead: row.output_head === null ? null : truncateDisplay(String(row.output_head), 500),
      citation: citationFor(session, entryId),
    };
  });
}
