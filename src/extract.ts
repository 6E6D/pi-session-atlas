import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

import type {
  NormalizedEntry,
  NormalizedSession,
  NormalizedText,
  NormalizedToolCall,
  NormalizedUsage,
  PiParserApi,
  TextKind,
} from "./types.ts";
import { DEFAULT_TOOL_HEAD_BYTES } from "./types.ts";
import { sourceTimestamp } from "./timestamps.ts";

type JsonObject = Record<string, unknown>;

const ZERO_USAGE: NormalizedUsage = {
  cost: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFrom(value: unknown): NormalizedUsage {
  const usage = object(value);
  if (!usage) return { ...ZERO_USAGE };
  const cost = object(usage.cost);
  return {
    cost: finiteNumber(cost?.total),
    tokensIn: finiteNumber(usage.input),
    tokensOut: finiteNumber(usage.output),
    cacheRead: finiteNumber(usage.cacheRead),
    cacheWrite: finiteNumber(usage.cacheWrite),
  };
}

function addUsage(total: NormalizedUsage, addend: NormalizedUsage): void {
  total.cost += addend.cost;
  total.tokensIn += addend.tokensIn;
  total.tokensOut += addend.tokensOut;
  total.cacheRead += addend.cacheRead;
  total.cacheWrite += addend.cacheWrite;
}

function textBlocks(content: unknown, blockType: "text" | "thinking" = "text"): string[] {
  if (typeof content === "string") return blockType === "text" ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const item of content) {
    const block = object(item);
    if (!block || block.type !== blockType) continue;
    const value = blockType === "thinking" ? block.thinking : block.text;
    if (typeof value === "string") texts.push(value);
  }
  return texts;
}

function joinedText(content: unknown): string {
  return textBlocks(content).join("\n").trim();
}

export function truncateUtf8(text: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  for (let end = Math.min(maximumBytes, bytes.length); end >= Math.max(0, maximumBytes - 4); end--) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      // A UTF-8 code point can occupy at most four bytes; back up to its start.
    }
  }
  return "";
}

function normalizedPath(raw: string, cwd: string, pathHome: string): string {
  const expanded = raw === "~" ? pathHome : raw.startsWith("~/") ? resolve(pathHome, raw.slice(2)) : raw;
  return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

function entryUsage(entry: JsonObject, message: JsonObject | null): NormalizedUsage {
  if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") return usageFrom(entry.usage);
  return usageFrom(message?.usage);
}

function deterministicLegacyId(sessionId: string, index: number): string {
  const digest = createHash("sha256").update(`${sessionId}:${index}`).digest("hex").slice(0, 12);
  return `v1-${digest}`;
}

/**
 * Pi's v1 migration generates random entry IDs. Atlas replaces that one step
 * with stable synthetic IDs, then delegates every remaining migration to Pi.
 * Current archives are v3; this preserves deterministic rebuilds for legacy
 * files without copying Pi's current-format parser.
 */
export function migrateDeterministically(entries: unknown[], parser: PiParserApi): void {
  const records = entries.map(object);
  const header = records.find((entry) => entry?.type === "session");
  if (!header) return;
  const version = typeof header.version === "number" ? header.version : 1;

  if (version < 2) {
    const sessionId = typeof header.id === "string" ? header.id : "unknown-session";
    let previousId: string | null = null;
    for (let index = 0; index < records.length; index++) {
      const entry = records[index];
      if (!entry || entry.type === "session") continue;
      const id = deterministicLegacyId(sessionId, index);
      entry.id = id;
      entry.parentId = previousId;
      previousId = id;

      if (entry.type === "compaction" && typeof entry.firstKeptEntryIndex === "number") {
        const target = records[entry.firstKeptEntryIndex];
        if (target && target.type !== "session" && typeof target.id === "string") {
          entry.firstKeptEntryId = target.id;
        }
        delete entry.firstKeptEntryIndex;
      }
    }
    header.version = 2;
  }

  // Preserve parsed-record positions for IDs, but never pass non-record JSON
  // (including null) to Pi migrations, which expect entry objects.
  const supportedRecords = entries.filter((entry) => object(entry) !== null);
  const originalOrder = [...supportedRecords];
  parser.migrateSessionEntries(supportedRecords);
  if (supportedRecords.length !== originalOrder.length || supportedRecords.some((entry, index) => entry !== originalOrder[index])) {
    throw new Error("Pi migration changed parsed-record positions");
  }
}

function addText(
  texts: NormalizedText[],
  entryId: string,
  timestamp: string,
  kind: TextKind,
  content: string,
): void {
  if (content.trim()) texts.push({ entryId, timestamp, kind, content });
}

function toolCallsIn(content: unknown): JsonObject[] {
  if (!Array.isArray(content)) return [];
  const calls: JsonObject[] = [];
  for (const item of content) {
    const block = object(item);
    if (block?.type === "toolCall") calls.push(block);
  }
  return calls;
}

function extractPathArgument(tool: string, args: JsonObject): string | null {
  const pathKeys = tool === "bash" ? [] : ["path", "file_path", "filename", "file"];
  for (const key of pathKeys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export interface ExtractOptions {
  toolHeadBytes?: number;
  /** Explicit interpretation root for recorded `~` and `~/...` paths. */
  pathHome?: string;
}

export function extractSession(
  content: string,
  file: string,
  parser: PiParserApi,
  options: ExtractOptions = {},
): NormalizedSession {
  const toolHeadBytes = options.toolHeadBytes ?? DEFAULT_TOOL_HEAD_BYTES;
  if (!Number.isSafeInteger(toolHeadBytes) || toolHeadBytes < 0) {
    throw new RangeError("toolHeadBytes must be a non-negative safe integer");
  }
  const pathHome = resolve(options.pathHome ?? homedir());

  const nonBlankLines = content.split("\n").filter((line) => line.trim()).length;
  const parsed = parser.parseSessionEntries(content);
  const warnings: string[] = [];
  if (parsed.length < nonBlankLines) {
    warnings.push(`${nonBlankLines - parsed.length} malformed or unsupported JSONL line(s) skipped`);
  }

  migrateDeterministically(parsed, parser);
  const records = parsed.map(object).filter((entry): entry is JsonObject => entry !== null);
  const headers = records.filter((entry) => entry.type === "session");
  if (headers.length === 0) throw new Error("session header not found");
  if (headers.length > 1) warnings.push(`${headers.length} session headers found; using the first`);
  const header = headers[0]!;
  const uuid = typeof header.id === "string" ? header.id : "";
  const cwd = typeof header.cwd === "string" ? header.cwd : "";
  if (!uuid) throw new Error("session header has no id");
  const created = sourceTimestamp(header.timestamp);
  for (const extra of headers.slice(1)) sourceTimestamp(extra.timestamp);

  const version = typeof header.version === "number" ? header.version : 1;
  if (version > parser.CURRENT_SESSION_VERSION) {
    warnings.push(
      `session version ${version} is newer than installed Pi parser version ${parser.CURRENT_SESSION_VERSION}`,
    );
  }

  const rawEntries = records.filter((entry) => entry.type !== "session");
  const byId = new Map<string, JsonObject>();
  const childCounts = new Map<string, number>();
  const orderedEntries: JsonObject[] = [];
  const timestamps = new Map<JsonObject, string>();
  for (const entry of rawEntries) {
    // Validate even a record subsequently skipped for an absent ID. An invalid
    // present time must not be silently accepted as a header-time fallback.
    timestamps.set(entry, Object.hasOwn(entry, "timestamp") ? sourceTimestamp(entry.timestamp) : created);
    if (typeof entry.id !== "string") {
      warnings.push(`entry of type ${String(entry.type)} has no id and was skipped`);
      continue;
    }
    if (byId.has(entry.id)) warnings.push(`duplicate entry id ${entry.id}; latest entry used for tree lookup`);
    byId.set(entry.id, entry);
    orderedEntries.push(entry);
    if (typeof entry.parentId === "string") {
      childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
    }
  }

  const activePath = new Set<string>();
  const leaf = orderedEntries.at(-1);
  let cursor = leaf;
  while (cursor && typeof cursor.id === "string") {
    if (activePath.has(cursor.id)) {
      warnings.push(`cycle detected at entry ${cursor.id}`);
      break;
    }
    activePath.add(cursor.id);
    if (cursor.parentId === null || cursor.parentId === undefined) break;
    if (typeof cursor.parentId !== "string") {
      warnings.push(`entry ${cursor.id} has invalid parentId`);
      break;
    }
    const parent = byId.get(cursor.parentId);
    if (!parent) {
      warnings.push(`entry ${cursor.id} references missing parent ${cursor.parentId}`);
      break;
    }
    cursor = parent;
  }

  const entries: NormalizedEntry[] = [];
  const texts: NormalizedText[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  const callsById = new Map<string, NormalizedToolCall[]>();
  const totals: NormalizedUsage = { ...ZERO_USAGE };
  const models = new Set<string>();
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let firstUserText: string | null = null;
  let name: string | null = null;
  let lastActivity = created;

  for (const entry of orderedEntries) {
    const id = entry.id as string;
    const timestamp = timestamps.get(entry)!;
    if (timestamp > lastActivity) lastActivity = timestamp;
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    const message = type === "message" ? object(entry.message) : null;
    const role = typeof message?.role === "string" ? message.role : null;
    const usage = entryUsage(entry, message);
    addUsage(totals, usage);

    let stopReason: string | null = null;
    let errorMessage: string | null = null;
    let isError = false;
    let model: string | null = null;
    let provider: string | null = null;

    if (role === "user") {
      userMessages++;
      const value = joinedText(message?.content);
      if (firstUserText === null && value) firstUserText = value;
      for (const text of textBlocks(message?.content)) addText(texts, id, timestamp, "user", text);
    } else if (role === "assistant") {
      assistantMessages++;
      stopReason = typeof message?.stopReason === "string" ? message.stopReason : null;
      errorMessage = typeof message?.errorMessage === "string" ? message.errorMessage : null;
      model = typeof message?.model === "string" ? message.model : null;
      provider = typeof message?.provider === "string" ? message.provider : null;
      isError = stopReason === "error";
      if (model) models.add(provider ? `${provider}/${model}` : model);
      for (const text of textBlocks(message?.content)) addText(texts, id, timestamp, "assistant", text);
      if (errorMessage) addText(texts, id, timestamp, "assistant", errorMessage);
      for (const thinking of textBlocks(message?.content, "thinking")) {
        addText(texts, id, timestamp, "thinking", thinking);
      }

      let sequence = 0;
      for (const call of toolCallsIn(message?.content)) {
        const tool = typeof call.name === "string" ? call.name : "unknown";
        const args = object(call.arguments) ?? {};
        const pathRaw = extractPathArgument(tool, args);
        const normalized: NormalizedToolCall = {
          entryId: id,
          sequence: sequence++,
          tool,
          pathRaw,
          pathResolved: pathRaw ? normalizedPath(pathRaw, cwd, pathHome) : null,
          command: tool === "bash" && typeof args.command === "string" ? args.command : null,
          source: "toolCall",
          resultEntryId: null,
          exitError: null,
        };
        toolCalls.push(normalized);
        if (typeof call.id === "string") {
          const linked = callsById.get(call.id) ?? [];
          linked.push(normalized);
          callsById.set(call.id, linked);
        }
      }
    } else if (role === "toolResult") {
      toolResults++;
      isError = message?.isError === true;
      const linkedId = typeof message?.toolCallId === "string" ? message.toolCallId : null;
      if (linkedId) {
        for (const call of callsById.get(linkedId) ?? []) {
          call.resultEntryId = id;
          call.exitError = isError;
        }
      }
      for (const text of textBlocks(message?.content)) {
        addText(texts, id, timestamp, "tool_head", truncateUtf8(text, toolHeadBytes));
      }
    } else if (role === "bashExecution") {
      const command = typeof message?.command === "string" ? message.command : "";
      const exitCode = typeof message?.exitCode === "number" ? message.exitCode : null;
      toolCalls.push({
        entryId: id,
        sequence: 0,
        tool: "bash",
        pathRaw: null,
        pathResolved: null,
        command: command || null,
        source: "bashExecution",
        resultEntryId: id,
        exitError: exitCode === null ? null : exitCode !== 0,
      });
      if (typeof message?.output === "string") {
        addText(texts, id, timestamp, "tool_head", truncateUtf8(message.output, toolHeadBytes));
      }
      isError = exitCode !== null && exitCode !== 0;
    }

    if (type === "usage") {
      model = typeof entry.model === "string" ? entry.model : null;
      provider = typeof entry.provider === "string" ? entry.provider : null;
      if (model) models.add(provider ? `${provider}/${model}` : model);
    }
    if (type === "context_edit") {
      // Historical edit evidence, not rewritten user/assistant/tool evidence.
      addText(texts, id, timestamp, "context_edit", truncateUtf8(sourceEntryText(entry).text, toolHeadBytes));
    }
    if (type === "model_change") {
      const changedModel = typeof entry.modelId === "string" ? entry.modelId : null;
      const changedProvider = typeof entry.provider === "string" ? entry.provider : null;
      if (changedModel) models.add(changedProvider ? `${changedProvider}/${changedModel}` : changedModel);
    } else if (type === "compaction" || type === "branch_summary") {
      if (typeof entry.summary === "string") addText(texts, id, timestamp, "summary", entry.summary);
      const details = object(entry.details);
      const fileGroups: Array<[unknown, "read" | "edit"]> = [
        [details?.readFiles, "read"],
        [details?.modifiedFiles, "edit"],
      ];
      let sequence = 0;
      for (const [files, tool] of fileGroups) {
        if (!Array.isArray(files)) continue;
        for (const pathValue of files) {
          if (typeof pathValue !== "string") continue;
          toolCalls.push({
            entryId: id,
            sequence: sequence++,
            tool,
            pathRaw: pathValue,
            pathResolved: normalizedPath(pathValue, cwd, pathHome),
            command: null,
            source: "compaction_details",
            resultEntryId: null,
            exitError: null,
          });
        }
      }
    } else if (type === "session_info" && typeof entry.name === "string") {
      name = entry.name || null;
      if (name) addText(texts, id, timestamp, "name", name);
    }

    entries.push({
      id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      type,
      role,
      timestamp,
      onActivePath: activePath.has(id),
      childCount: childCounts.get(id) ?? 0,
      stopReason,
      errorMessage,
      isError,
      model,
      provider,
      ...usage,
    });
  }

  return {
    uuid,
    file,
    sessionDir: dirname(file),
    cwd,
    name,
    firstUserText,
    parentSession: typeof header.parentSession === "string" ? header.parentSession : null,
    created,
    lastActivity,
    entryCount: entries.length,
    userMessages,
    assistantMessages,
    toolResults,
    models: [...models].sort(),
    entries,
    toolCalls,
    texts,
    warnings,
    ...totals,
  };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const block = object(item);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(`[thinking] ${block.thinking}`);
    } else if (block.type === "toolCall") {
      const name = typeof block.name === "string" ? block.name : "tool";
      parts.push(`[tool] ${name}(${JSON.stringify(block.arguments ?? {})})`);
    } else if (block.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

export function sourceEntryText(entry: JsonObject): { role: string | null; text: string } {
  if (entry.type === "message") {
    const message = object(entry.message);
    const role = typeof message?.role === "string" ? message.role : null;
    if (role === "bashExecution") {
      return {
        role,
        text: `${String(message?.command ?? "")}\n${String(message?.output ?? "")}`,
      };
    }
    return { role, text: blockText(message?.content) };
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { role: String(entry.type), text: String(entry.summary ?? "") };
  }
  if (entry.type === "custom_message") {
    return { role: "custom", text: blockText(entry.content) };
  }
  if (entry.type === "context_edit") {
    const target = typeof entry.targetId === "string" ? entry.targetId : "[invalid target]";
    const action = entry.replacement === null ? "omit" : Object.hasOwn(entry, "replacement") ? "replace" : "[invalid replacement]";
    return { role: null, text: `context_edit ${action} target=${target}${action === "replace" ? "\n" + blockText(entry.replacement) : ""}` };
  }
  if (entry.type === "usage") {
    return { role: null, text: `usage kind=${String(entry.kind ?? "unknown")} provider=${String(entry.provider ?? "unknown")} model=${String(entry.model ?? "unknown")} cost=${usageFrom(entry.usage).cost}` };
  }
  if (entry.type === "session_info") return { role: null, text: `name: ${String(entry.name ?? "")}` };
  if (entry.type === "model_change") {
    return { role: null, text: `model: ${String(entry.provider ?? "")}/${String(entry.modelId ?? "")}` };
  }
  if (entry.type === "thinking_level_change") {
    return { role: null, text: `thinking level: ${String(entry.thinkingLevel ?? "")}` };
  }
  if (entry.type === "custom") {
    return { role: null, text: `custom: ${String(entry.customType ?? "")}` };
  }
  if (entry.type === "label") return { role: null, text: `label: ${String(entry.label ?? "")}` };
  return { role: null, text: String(entry.type ?? "entry") };
}
