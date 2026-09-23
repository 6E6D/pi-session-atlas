export const ATLAS_SCHEMA_VERSION = 4;
export const ATLAS_EXTRACTION_VERSION = 4;

export interface ParserIdentity {
  packageName: string;
  packageVersion: string;
  modulePath: string;
  sessionVersion: number;
  codeFingerprint: string;
}

export interface CacheIdentity {
  sourceRoot: string;
  /** Present for extraction v3/v4; absent only on recognized legacy v1/v2 identities. */
  pathHome?: string;
  schemaVersion: number;
  extractionVersion: number;
  toolHeadBytes: number;
  parser: ParserIdentity;
}

export interface ScanAttempt {
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed";
  sourceRoot: string;
  enumerationComplete: boolean;
  failures: IndexFailure[];
  parseWarnings: number;
}

export interface CacheCoverage {
  basis: "indexed-observations";
  identity: CacheIdentity;
  lastAttempt: ScanAttempt | null;
  lastSuccessfulScan: string | null;
  unverifiedFiles: Array<{ file: string; message: string }>;
}
export const DEFAULT_TOOL_HEAD_BYTES = 2_048;

export type TextKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_head"
  | "summary"
  | "name"
  | "context_edit";

export interface PiParserApi {
  CURRENT_SESSION_VERSION: number;
  parseSessionEntries(content: string): unknown[];
  migrateSessionEntries(entries: unknown[]): void;
}

export interface NormalizedUsage {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface NormalizedEntry extends NormalizedUsage {
  id: string;
  parentId: string | null;
  type: string;
  role: string | null;
  timestamp: string;
  onActivePath: boolean;
  childCount: number;
  stopReason: string | null;
  errorMessage: string | null;
  isError: boolean;
  model: string | null;
  provider: string | null;
}

export interface NormalizedToolCall {
  entryId: string;
  sequence: number;
  tool: string;
  pathRaw: string | null;
  pathResolved: string | null;
  command: string | null;
  source: "toolCall" | "bashExecution" | "compaction_details";
  resultEntryId: string | null;
  exitError: boolean | null;
}

export interface NormalizedText {
  entryId: string;
  timestamp: string;
  kind: TextKind;
  content: string;
}

export interface NormalizedSession extends NormalizedUsage {
  uuid: string;
  file: string;
  sessionDir: string;
  cwd: string;
  name: string | null;
  firstUserText: string | null;
  parentSession: string | null;
  created: string;
  lastActivity: string;
  entryCount: number;
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  models: string[];
  entries: NormalizedEntry[];
  toolCalls: NormalizedToolCall[];
  texts: NormalizedText[];
  warnings: string[];
}

export interface CatalogRecord {
  file: string;
  mtimeMs: number;
  size: number;
  indexedAt: string;
  sessionUuid: string;
  entryCount: number;
  parseWarnings: number;
  ctimeMs: number;
  device: number;
  inode: number;
}

export interface IndexOptions {
  databasePath: string;
  sessionsDirectory: string;
  /** Home used only to interpret recorded `~` and `~/...` tool paths. */
  pathHome?: string;
  rebuild?: boolean;
  rebind?: boolean;
  /** Explicit identity for an injected parser; production resolution supplies its own. */
  parserIdentity?: ParserIdentity;
  toolHeadBytes?: number;
  now?: () => Date;
}

export interface IndexFailure {
  file: string;
  message: string;
}

export interface IndexResult {
  databasePath: string;
  sessionsDirectory: string;
  rebuilt: boolean;
  filesScanned: number;
  filesChanged: number;
  filesRemoved: number;
  filesUnchanged: number;
  sessionsIndexed: number;
  entriesIndexed: number;
  parseWarnings: number;
  failures: IndexFailure[];
  durationMs: number;
  databaseBytes: number;
  committed: boolean;
  coverage: CacheCoverage | null;
}
