import type { DatabaseSync } from "node:sqlite";

import { contextAnnotations, contextNode, type ContextNode } from "../context-edits.ts";
import { UsageError } from "../errors.ts";
import { sourceEntryText } from "../extract.ts";
import { AtlasQueryError, citationFor, resolveSession, truncateDisplay } from "../query-db.ts";
import { inspectSource, type SourceEvidence, type SourceRecord } from "../source.ts";
import type { PiParserApi } from "../types.ts";
import { resolveEntry } from "./cite.ts";

export interface ShowEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  role: string | null;
  text: string;
  citation: string;
  textTruncated: boolean;
  raw?: SourceRecord;
}

export interface ShowResult {
  sessionUuid: string;
  sessionName: string | null;
  cwd: string;
  sourceFile: string;
  targetEntryId: string;
  entries: ShowEntry[];
  evidence: SourceEvidence;
  contextHistory: ReturnType<typeof contextAnnotations>;
}

export async function showSession(
  database: DatabaseSync,
  sessionReference: string,
  entryReference: string | undefined,
  context: number,
  options: { parser?: PiParserApi } = {},
): Promise<ShowResult> {
  if (!Number.isInteger(context) || context < 0 || context > 100) throw new UsageError("context must be an integer from 0 to 100");
  const session = resolveSession(database, sessionReference);
  let targetEntryId: string;
  if (entryReference) {
    targetEntryId = resolveEntry(database, session.uuid, entryReference).id;
  } else {
    const row = database
      .prepare(
        `SELECT id FROM entries WHERE session_uuid = ? AND on_active_path = 1
         ORDER BY ts DESC, rowid DESC LIMIT 1`,
      )
      .get(session.uuid) as { id?: string } | undefined;
    if (!row?.id) throw new AtlasQueryError(`session has no indexed entries: ${session.uuid}`);
    targetEntryId = row.id;
  }

  const nodes: ContextNode[] = [];
  const preceding: ShowEntry[] = [];
  let selected: ShowEntry[] = [];
  let found = false;
  let following = 0;
  const evidence = await inspectSource(database, session, targetEntryId, (entry, raw) => {
    const node = contextNode(entry);
    if (node) nodes.push(node);
    const isTarget = entry.id === targetEntryId;
    if (!isTarget && (context === 0 || (found && following >= context))) return;
    const { role, text } = sourceEntryText(entry);
    const full = context === 0 && isTarget;
    const normalizedText = text.replace(/\s+/g, " ").trim();
    const displayed: ShowEntry = {
      id: entry.id as string,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      type: typeof entry.type === "string" ? entry.type : "unknown",
      role,
      text: full ? text : truncateDisplay(text, 500),
      textTruncated: !full && normalizedText.length > 500,
      citation: citationFor(session, entry.id as string),
      ...(full ? { raw } : {}),
    };
    if (isTarget) { found = true; selected = [...preceding, displayed]; }
    else if (found) { selected.push(displayed); following++; }
    else { preceding.push(displayed); if (preceding.length > context) preceding.shift(); }
  }, options);
  return {
    sessionUuid: session.uuid,
    sessionName: session.name,
    cwd: session.cwd,
    sourceFile: session.file,
    targetEntryId,
    entries: selected,
    evidence,
    contextHistory: contextAnnotations(nodes, selected.map(entry => entry.id)),
  };
}
