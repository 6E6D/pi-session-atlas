import type { DatabaseSync } from "node:sqlite";

import { AtlasQueryError, citationFor, resolveSession } from "../query-db.ts";
import { inspectSource, type SourceEvidence } from "../source.ts";

export interface CiteResult {
  sessionUuid: string;
  entryId: string | null;
  timestamp: string;
  citation: string;
}

export function resolveEntry(database: DatabaseSync, sessionUuid: string, reference: string): {
  id: string;
  timestamp: string;
} {
  if (reference.length === 0) throw new AtlasQueryError(`entry reference must not be empty in ${sessionUuid}`, "ENTRY_NOT_FOUND");
  const exact = database
    .prepare("SELECT id, ts FROM entries WHERE session_uuid = ? AND id = ?")
    .get(sessionUuid, reference) as { id: string; ts: string } | undefined;
  if (exact) return { id: exact.id, timestamp: exact.ts };

  const rows = database
    .prepare(
      `SELECT id, ts FROM entries
       WHERE session_uuid = ? AND substr(id, 1, length(?)) = ?
       ORDER BY id LIMIT 2`,
    )
    .all(sessionUuid, reference, reference) as Array<{ id: string; ts: string }>;
  if (rows.length === 0) throw new AtlasQueryError(`entry not found in ${sessionUuid}: ${reference}`, "ENTRY_NOT_FOUND");
  if (rows.length > 1) throw new AtlasQueryError(`entry reference is ambiguous: ${reference}`, "ENTRY_AMBIGUOUS");
  return { id: rows[0]!.id, timestamp: rows[0]!.ts };
}

/** Index-only pointer resolution: source presence, truth and approval are not checked. */
export function cite(
  database: DatabaseSync,
  sessionReference: string,
  entryReference?: string,
): CiteResult {
  const session = resolveSession(database, sessionReference);
  const entry = entryReference ? resolveEntry(database, session.uuid, entryReference) : null;
  return {
    sessionUuid: session.uuid,
    entryId: entry?.id ?? null,
    timestamp: entry?.timestamp ?? session.created,
    citation: citationFor(session, entry?.id),
  };
}

export async function verifyCitation(
  database: DatabaseSync,
  sessionReference: string,
  entryReference?: string,
): Promise<CiteResult & { verification: SourceEvidence }> {
  const result = cite(database, sessionReference, entryReference);
  const session = resolveSession(database, result.sessionUuid);
  const verification = await inspectSource(database, session, result.entryId ?? undefined);
  if (verification.indexState !== "metadata-match") {
    throw new AtlasQueryError(`current source metadata differs from the index or has no catalog entry: ${session.file}; inspect the source and refresh only if appropriate`, "SOURCE_CHANGED");
  }
  return { ...result, verification };
}
