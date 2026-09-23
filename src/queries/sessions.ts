import type { DatabaseSync } from "node:sqlite";

import { citationFor, type SessionIdentity } from "../query-db.ts";

export interface ListSessionsOptions {
  sessionDirectoryGlob?: string;
  cwdGlob?: string;
  since?: string;
  namePattern?: string;
  limit: number;
}

export interface SessionResult {
  uuid: string;
  name: string | null;
  cwd: string;
  created: string;
  lastActivity: string;
  entries: number;
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  cost: number;
  models: string[];
  citation: string;
}

export function listSessions(
  database: DatabaseSync,
  options: ListSessionsOptions,
): SessionResult[] {
  const conditions: string[] = ["1 = 1"];
  const parameters: Array<string | number> = [];
  if (options.sessionDirectoryGlob) {
    conditions.push("session_dir GLOB ?");
    parameters.push(options.sessionDirectoryGlob);
  }
  if (options.cwdGlob) {
    conditions.push("cwd GLOB ?");
    parameters.push(options.cwdGlob);
  }
  if (options.since) {
    conditions.push("last_activity >= ?");
    parameters.push(options.since);
  }
  if (options.namePattern) {
    conditions.push("name LIKE ?");
    parameters.push(`%${options.namePattern}%`);
  }
  parameters.push(options.limit);

  const rows = database
    .prepare(
      `SELECT uuid, file, cwd, name, first_user_text, created, last_activity,
              entry_count, user_msgs, assistant_msgs, tool_results, cost_total,
              models
       FROM sessions
       WHERE ${conditions.join(" AND ")}
       ORDER BY last_activity DESC, uuid
       LIMIT ?`,
    )
    .all(...parameters) as Array<Record<string, string | number | null>>;

  return rows.map((row) => {
    const session: SessionIdentity = {
      uuid: String(row.uuid),
      file: String(row.file),
      cwd: String(row.cwd),
      name: row.name === null ? null : String(row.name),
      firstUserText: row.first_user_text === null ? null : String(row.first_user_text),
      created: String(row.created),
      lastActivity: String(row.last_activity),
    };
    let models: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.models));
      if (Array.isArray(parsed)) models = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      // An invalid derived value should not make the whole catalog unqueryable.
    }
    return {
      uuid: session.uuid,
      name: session.name,
      cwd: session.cwd,
      created: session.created,
      lastActivity: session.lastActivity,
      entries: Number(row.entry_count),
      userMessages: Number(row.user_msgs),
      assistantMessages: Number(row.assistant_msgs),
      toolResults: Number(row.tool_results),
      cost: Number(row.cost_total),
      models,
      citation: citationFor(session),
    };
  });
}
