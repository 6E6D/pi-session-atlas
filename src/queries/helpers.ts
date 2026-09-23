import type { DatabaseSync } from "node:sqlite";

import { truncateDisplay, type SessionIdentity } from "../query-db.ts";

export function sessionFromRow(row: Record<string, string | number | null>): SessionIdentity {
  return {
    uuid: String(row.uuid ?? row.session_uuid),
    file: String(row.file),
    cwd: String(row.cwd),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    firstUserText:
      row.first_user_text === null || row.first_user_text === undefined
        ? null
        : String(row.first_user_text),
    created: String(row.created),
    lastActivity: String(row.last_activity),
  };
}

export function entrySnippet(database: DatabaseSync, sessionUuid: string, entryId: string): string {
  const rows = database
    .prepare(
      `SELECT content FROM text_fts
       WHERE session_uuid = ? AND entry_id = ?
       ORDER BY CASE kind
         WHEN 'user' THEN 1 WHEN 'assistant' THEN 2 WHEN 'summary' THEN 3
         WHEN 'tool_head' THEN 4 WHEN 'thinking' THEN 5 ELSE 6 END,
         rowid
       LIMIT 2`,
    )
    .all(sessionUuid, entryId) as Array<{ content: string }>;
  return truncateDisplay(rows.map((row) => row.content).join(" "), 240);
}
