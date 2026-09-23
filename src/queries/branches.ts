import type { DatabaseSync } from "node:sqlite";

import { citationFor, resolveSession, type SessionIdentity } from "../query-db.ts";
import { entrySnippet } from "./helpers.ts";

const SEMANTIC_TYPES = new Set(["message", "compaction", "branch_summary", "custom_message"]);

interface TreeEntry {
  id: string;
  parentId: string | null;
  type: string;
  role: string | null;
  timestamp: string;
  onActivePath: boolean;
}

export interface BranchOptions {
  abandonedOnly?: boolean;
  sessionReference?: string;
  limit: number;
  now?: Date;
}

export interface BranchResult {
  sessionUuid: string;
  sessionName: string | null;
  branchPointId: string;
  branchPointTimestamp: string;
  tipEntryId: string;
  tipTimestamp: string;
  tipType: string;
  tipRole: string | null;
  abandoned: boolean;
  ageDays: number;
  snippet: string;
  citation: string;
}

function sessionRows(database: DatabaseSync, reference?: string): SessionIdentity[] {
  if (reference) return [resolveSession(database, reference)];
  return (database
    .prepare(
      `SELECT uuid, file, cwd, name, first_user_text, created, last_activity
       FROM sessions ORDER BY last_activity DESC`,
    )
    .all() as Array<Record<string, string | null>>).map((row) => ({
    uuid: String(row.uuid),
    file: String(row.file),
    cwd: String(row.cwd),
    name: row.name === null ? null : String(row.name),
    firstUserText: row.first_user_text === null ? null : String(row.first_user_text),
    created: String(row.created),
    lastActivity: String(row.last_activity),
  }));
}

function semanticParent(entry: TreeEntry, byId: Map<string, TreeEntry>): TreeEntry | null {
  let parentId = entry.parentId;
  const visited = new Set<string>();
  while (parentId) {
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (SEMANTIC_TYPES.has(parent.type)) return parent;
    parentId = parent.parentId;
  }
  return null;
}

export function findBranches(database: DatabaseSync, options: BranchOptions): BranchResult[] {
  const results: BranchResult[] = [];
  const now = options.now?.getTime() ?? Date.now();

  for (const session of sessionRows(database, options.sessionReference)) {
    const rows = database
      .prepare(
        `SELECT id, parent_id, type, role, ts, on_active_path
         FROM entries WHERE session_uuid = ? ORDER BY rowid`,
      )
      .all(session.uuid) as Array<Record<string, string | number | null>>;
    const entries: TreeEntry[] = rows.map((row) => ({
      id: String(row.id),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      type: String(row.type),
      role: row.role === null ? null : String(row.role),
      timestamp: String(row.ts),
      onActivePath: Number(row.on_active_path) === 1,
    }));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const semantic = entries.filter((entry) => SEMANTIC_TYPES.has(entry.type));
    const semanticParents = new Map<string, string | null>();
    const semanticChildCounts = new Map<string, number>();
    for (const entry of semantic) {
      const parent = semanticParent(entry, byId);
      semanticParents.set(entry.id, parent?.id ?? null);
      if (parent) semanticChildCounts.set(parent.id, (semanticChildCounts.get(parent.id) ?? 0) + 1);
    }
    const branchPointIds = new Set(
      [...semanticChildCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([entryId]) => entryId),
    );
    if (branchPointIds.size === 0) continue;

    for (const tip of semantic.filter((entry) => (semanticChildCounts.get(entry.id) ?? 0) === 0)) {
      if (options.abandonedOnly && tip.onActivePath) continue;
      let ancestorId = semanticParents.get(tip.id) ?? null;
      let branchPoint: TreeEntry | null = null;
      while (ancestorId) {
        if (branchPointIds.has(ancestorId)) {
          branchPoint = byId.get(ancestorId) ?? null;
          break;
        }
        ancestorId = semanticParents.get(ancestorId) ?? null;
      }
      if (!branchPoint) continue;
      const timestampMs = Date.parse(tip.timestamp);
      const ageDays = Number.isFinite(timestampMs)
        ? Math.max(0, Math.floor((now - timestampMs) / 86_400_000))
        : 0;
      results.push({
        sessionUuid: session.uuid,
        sessionName: session.name,
        branchPointId: branchPoint.id,
        branchPointTimestamp: branchPoint.timestamp,
        tipEntryId: tip.id,
        tipTimestamp: tip.timestamp,
        tipType: tip.type,
        tipRole: tip.role,
        abandoned: !tip.onActivePath,
        ageDays,
        snippet: entrySnippet(database, session.uuid, tip.id),
        citation: citationFor(session, tip.id),
      });
    }
  }

  return results
    .sort((left, right) => right.tipTimestamp.localeCompare(left.tipTimestamp))
    .slice(0, options.limit);
}
