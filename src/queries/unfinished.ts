import type { DatabaseSync } from "node:sqlite";

import { citationFor } from "../query-db.ts";
import { entrySnippet, sessionFromRow } from "./helpers.ts";

export type UnfinishedReason =
  | "unanswered-user"
  | "aborted"
  | "error"
  | "length"
  | "dangling-tool"
  | "no-assistant";

export interface UnfinishedOptions {
  since?: string;
  limit: number;
}

export interface UnfinishedResult {
  sessionUuid: string;
  sessionName: string | null;
  cwd: string;
  lastActivity: string;
  candidateEntryId: string;
  reasons: UnfinishedReason[];
  snippet: string;
  citation: string;
}

export function findUnfinished(
  database: DatabaseSync,
  options: UnfinishedOptions,
): UnfinishedResult[] {
  const parameters: Array<string | number> = [];
  const where = options.since ? "WHERE last_activity >= ?" : "";
  if (options.since) parameters.push(options.since);
  const sessions = database
    .prepare(
      `SELECT uuid, file, cwd, name, first_user_text, created, last_activity,
              assistant_msgs
       FROM sessions ${where}
       ORDER BY last_activity DESC`,
    )
    .all(...parameters) as Array<Record<string, string | number | null>>;

  const results: UnfinishedResult[] = [];
  for (const row of sessions) {
    const session = sessionFromRow(row);
    const reasons = new Set<UnfinishedReason>();
    const lastMessage = database
      .prepare(
        `SELECT id, role, stop_reason, ts FROM entries
         WHERE session_uuid = ? AND on_active_path = 1 AND type = 'message'
         ORDER BY ts DESC, rowid DESC LIMIT 1`,
      )
      .get(session.uuid) as
      | { id: string; role: string | null; stop_reason: string | null; ts: string }
      | undefined;

    if (Number(row.assistant_msgs) === 0) reasons.add("no-assistant");
    if (lastMessage?.role === "user") reasons.add("unanswered-user");
    if (
      lastMessage?.role === "assistant" &&
      (lastMessage.stop_reason === "aborted" ||
        lastMessage.stop_reason === "error" ||
        lastMessage.stop_reason === "length")
    ) {
      reasons.add(lastMessage.stop_reason);
    }

    const dangling = database
      .prepare(
        `SELECT tc.entry_id AS id, e.ts
         FROM tool_calls AS tc
         JOIN entries AS e
           ON e.session_uuid = tc.session_uuid AND e.id = tc.entry_id
         WHERE tc.session_uuid = ? AND tc.source = 'toolCall'
           AND tc.result_entry_id IS NULL AND e.on_active_path = 1
         ORDER BY e.ts DESC, tc.seq DESC LIMIT 1`,
      )
      .get(session.uuid) as { id: string; ts: string } | undefined;
    if (dangling) reasons.add("dangling-tool");
    if (reasons.size === 0) continue;

    const fallback = database
      .prepare(
        `SELECT id, ts FROM entries WHERE session_uuid = ? AND on_active_path = 1
         ORDER BY ts DESC, rowid DESC LIMIT 1`,
      )
      .get(session.uuid) as { id: string; ts: string } | undefined;
    let candidate = lastMessage ?? fallback;
    if (dangling && (!candidate || dangling.ts >= candidate.ts)) candidate = dangling;
    if (!candidate) continue;

    const orderedReasons: UnfinishedReason[] = [
      "no-assistant",
      "unanswered-user",
      "aborted",
      "error",
      "length",
      "dangling-tool",
    ].filter((reason): reason is UnfinishedReason => reasons.has(reason as UnfinishedReason));
    results.push({
      sessionUuid: session.uuid,
      sessionName: session.name,
      cwd: session.cwd,
      lastActivity: session.lastActivity,
      candidateEntryId: candidate.id,
      reasons: orderedReasons,
      snippet: entrySnippet(database, session.uuid, candidate.id),
      citation: citationFor(session, candidate.id),
    });
  }
  return results.slice(0, options.limit);
}
