import type { DatabaseSync } from "node:sqlite";

import { citationFor, truncateDisplay } from "../query-db.ts";
import { sessionFromRow } from "./helpers.ts";

export type CostGrouping = "month" | "project" | "model" | "provider";

export interface CostReportOptions {
  by: CostGrouping;
  since?: string;
  top: number;
}

export interface UsageTotals {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheRate: number;
}

export interface CostGroup extends UsageTotals {
  key: string;
  sessions: number;
}

export interface CostReport {
  grouping: CostGrouping;
  since: string | null;
  totals: UsageTotals;
  groups: CostGroup[];
  topSessions: Array<{
    sessionUuid: string;
    name: string | null;
    cwd: string;
    lastActivity: string;
    cost: number;
    tokensIn: number;
    tokensOut: number;
    citation: string;
  }>;
}

function cacheRate(tokensIn: number, cacheRead: number): number {
  const denominator = tokensIn + cacheRead;
  return denominator === 0 ? 0 : cacheRead / denominator;
}

function usageTotals(row: Record<string, string | number | bigint | null>): UsageTotals {
  const tokensIn = Number(row.tokens_in ?? 0);
  const cacheRead = Number(row.cache_read ?? 0);
  return {
    cost: Number(row.cost ?? 0),
    tokensIn,
    tokensOut: Number(row.tokens_out ?? 0),
    cacheRead,
    cacheWrite: Number(row.cache_write ?? 0),
    cacheRate: cacheRate(tokensIn, cacheRead),
  };
}

export function costReport(database: DatabaseSync, options: CostReportOptions): CostReport {
  const sessionParameters = options.since ? [options.since] : [];
  // Date-scoped usage is aggregated from the same eligible entries for totals,
  // project groups and top sessions. Identity/citation metadata stays session-
  // based; unbounded reports retain header-only/zero-usage session inventory.
  const scopedSessions = options.since ? `(
    SELECT s.uuid, s.file, s.cwd, s.name, s.first_user_text, s.created, s.last_activity,
           sum(e.cost) AS cost_total, sum(e.tokens_in) AS tokens_in,
           sum(e.tokens_out) AS tokens_out, sum(e.cache_read) AS cache_read,
           sum(e.cache_write) AS cache_write
    FROM entries AS e JOIN sessions AS s ON s.uuid = e.session_uuid
    WHERE e.ts >= ? GROUP BY s.uuid
  )` : "sessions";
  const totalRow = database
    .prepare(
      `SELECT coalesce(sum(cost_total), 0) AS cost,
              coalesce(sum(tokens_in), 0) AS tokens_in,
              coalesce(sum(tokens_out), 0) AS tokens_out,
              coalesce(sum(cache_read), 0) AS cache_read,
              coalesce(sum(cache_write), 0) AS cache_write
       FROM ${scopedSessions}`,
    )
    .get(...sessionParameters) as Record<string, number | bigint | null>;

  let groupRows: Array<Record<string, string | number | bigint | null>>;
  if (options.by === "project") {
    groupRows = database
      .prepare(
        `SELECT cwd AS group_key, count(*) AS sessions,
                sum(cost_total) AS cost, sum(tokens_in) AS tokens_in,
                sum(tokens_out) AS tokens_out, sum(cache_read) AS cache_read,
                sum(cache_write) AS cache_write
         FROM ${scopedSessions}
         GROUP BY cwd ORDER BY cost DESC, group_key`,
      )
      .all(...sessionParameters) as Array<Record<string, string | number | bigint | null>>;
  } else {
    const keyExpression =
      options.by === "month"
        ? "substr(e.ts, 1, 7)"
        : options.by === "model"
          ? "coalesce(e.model, '(unattributed)')"
          : "coalesce(e.provider, '(unattributed)')";
    const entryWhere = options.since ? "WHERE e.ts >= ?" : "";
    const entryParameters = options.since ? [options.since] : [];
    groupRows = database
      .prepare(
        `SELECT ${keyExpression} AS group_key,
                count(DISTINCT e.session_uuid) AS sessions,
                sum(e.cost) AS cost, sum(e.tokens_in) AS tokens_in,
                sum(e.tokens_out) AS tokens_out, sum(e.cache_read) AS cache_read,
                sum(e.cache_write) AS cache_write
         FROM entries AS e ${entryWhere}
         GROUP BY group_key
         HAVING sum(e.cost) != 0 OR sum(e.tokens_in) != 0 OR sum(e.tokens_out) != 0
             OR sum(e.cache_read) != 0 OR sum(e.cache_write) != 0
         ORDER BY cost DESC, group_key`,
      )
      .all(...entryParameters) as Array<Record<string, string | number | bigint | null>>;
  }

  const topRows = database
    .prepare(
      `SELECT uuid, file, cwd, name, first_user_text, created, last_activity,
              cost_total, tokens_in, tokens_out
       FROM ${scopedSessions}
       ORDER BY cost_total DESC, last_activity DESC LIMIT ?`,
    )
    .all(...sessionParameters, options.top) as Array<Record<string, string | number | null>>;

  return {
    grouping: options.by,
    since: options.since ?? null,
    totals: usageTotals(totalRow),
    groups: groupRows.map((row) => ({
      key: String(row.group_key),
      sessions: Number(row.sessions),
      ...usageTotals(row),
    })),
    topSessions: topRows.map((row) => {
      const session = sessionFromRow(row);
      return {
        sessionUuid: session.uuid,
        name: session.name,
        cwd: session.cwd,
        lastActivity: session.lastActivity,
        cost: Number(row.cost_total),
        tokensIn: Number(row.tokens_in),
        tokensOut: Number(row.tokens_out),
        citation: citationFor(session),
      };
    }),
  };
}

export type ErrorGrouping = "tool" | "signature";

export interface ErrorReportOptions {
  by: ErrorGrouping;
  since?: string;
  limit: number;
}

export interface ErrorReport {
  grouping: ErrorGrouping;
  since: string | null;
  toolFailures: number;
  assistantErrors: number;
  assistantAborts: number;
  groups: Array<{ key: string; count: number }>;
  recent: Array<{
    sessionUuid: string;
    entryId: string;
    timestamp: string;
    kind: "tool" | "assistant";
    tool: string | null;
    signature: string;
    citation: string;
  }>;
}

interface FailureRow extends Record<string, string | number | null> {
  kind: string;
  entry_id: string;
  ts: string;
  tool: string | null;
  signature: string | null;
}

function signature(value: string | null): string {
  if (!value) return "(no output)";
  const firstLine = value.split(/\r?\n/, 1)[0] ?? "";
  return truncateDisplay(firstLine, 160) || "(blank output)";
}

export function errorReport(database: DatabaseSync, options: ErrorReportOptions): ErrorReport {
  const sinceTool = options.since ? "AND e.ts >= ?" : "";
  const toolParameters = options.since ? [options.since] : [];
  const toolRows = database
    .prepare(
      // FTS5 has no index on session/entry columns: a correlated per-failure
      // lookup rescans the whole text table. Aggregate tool heads once.
      `WITH heads AS (
         SELECT session_uuid, entry_id, group_concat(content, char(10)) AS signature
         FROM text_fts WHERE kind = 'tool_head'
         GROUP BY session_uuid, entry_id
       )
       SELECT 'tool' AS kind, tc.entry_id, e.ts, tc.tool,
              h.signature AS signature,
              s.uuid, s.file, s.cwd, s.name, s.first_user_text,
              s.created, s.last_activity
       FROM tool_calls AS tc
       JOIN entries AS e ON e.session_uuid = tc.session_uuid AND e.id = tc.entry_id
       JOIN sessions AS s ON s.uuid = tc.session_uuid
       LEFT JOIN heads AS h ON h.session_uuid = tc.session_uuid AND h.entry_id = tc.result_entry_id
       WHERE tc.exit_error = 1 ${sinceTool}
       ORDER BY tc.rowid`,
    )
    .all(...toolParameters) as FailureRow[];

  const sinceAssistant = options.since ? "AND e.ts >= ?" : "";
  const assistantParameters = options.since ? [options.since] : [];
  const assistantRows = database
    .prepare(
      `SELECT 'assistant' AS kind, e.id AS entry_id, e.ts, NULL AS tool,
              coalesce(e.error_message,
                       (SELECT content FROM text_fts
                        WHERE session_uuid = e.session_uuid AND entry_id = e.id
                          AND kind = 'assistant' ORDER BY rowid LIMIT 1),
                       e.stop_reason) AS signature,
              s.uuid, s.file, s.cwd, s.name, s.first_user_text,
              s.created, s.last_activity, e.stop_reason
       FROM entries AS e
       JOIN sessions AS s ON s.uuid = e.session_uuid
       WHERE e.role = 'assistant' AND e.stop_reason IN ('error', 'aborted')
         ${sinceAssistant}`,
    )
    .all(...assistantParameters) as FailureRow[];

  const all = [...toolRows, ...assistantRows].map((row) => ({ row, signature: signature(row.signature) }));
  const counts = new Map<string, number>();
  for (const failure of all) {
    const key = options.by === "tool" ? failure.row.tool ?? "assistant" : failure.signature;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));

  const recent = all
    .sort((left, right) => String(right.row.ts).localeCompare(String(left.row.ts)))
    .slice(0, options.limit)
    .map(({ row, signature: failureSignature }) => {
      const session = sessionFromRow(row);
      const entryId = String(row.entry_id);
      return {
        sessionUuid: session.uuid,
        entryId,
        timestamp: String(row.ts),
        kind: row.kind === "tool" ? ("tool" as const) : ("assistant" as const),
        tool: row.tool === null ? null : String(row.tool),
        signature: failureSignature,
        citation: citationFor(session, entryId),
      };
    });

  return {
    grouping: options.by,
    since: options.since ?? null,
    toolFailures: toolRows.length,
    assistantErrors: assistantRows.filter((row) => row.stop_reason === "error").length,
    assistantAborts: assistantRows.filter((row) => row.stop_reason === "aborted").length,
    groups,
    recent,
  };
}
