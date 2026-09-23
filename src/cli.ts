#!/usr/bin/env node
import { homedir } from "node:os";
import { cacheCoverage } from "./cache.ts";
import type { CacheCoverage } from "./types.ts";
let queryCoverage: CacheCoverage | undefined;
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { failureFor, UsageError, type ErrorDetail } from "./errors.ts";
import { indexSessions } from "./indexer.ts";
import { openQueryDatabase } from "./query-db.ts";
import { findBranches } from "./queries/branches.ts";
import { cite, verifyCitation } from "./queries/cite.ts";
import { searchCommands } from "./queries/commands.ts";
import { costReport, errorReport, type CostGrouping, type ErrorGrouping } from "./queries/reports.ts";
import { prepareSearchQuery, search } from "./queries/search.ts";
import { listSessions } from "./queries/sessions.ts";
import { showSession } from "./queries/show.ts";
import { traceFile } from "./queries/trace.ts";
import { findUnfinished } from "./queries/unfinished.ts";
import { DEFAULT_TOOL_HEAD_BYTES, type TextKind } from "./types.ts";
import type { SourceEvidence } from "./source.ts";
import { sourceTimestamp } from "./timestamps.ts";

const HELP = `Session Atlas — deterministic local index and query CLI over Pi sessions

Usage:
  atlas index [--rebuild [--rebind]] [--tool-head-bytes N] [--sessions-dir PATH]
              [--path-home PATH]
  atlas search <query> [--kind KIND] [--exact | --fts] [--dir GLOB] [--cwd GLOB]
                       [--since DATE] [--until DATE] [--limit N]
  atlas sessions [--dir GLOB] [--cwd GLOB] [--since DATE] [--name PATTERN]
  atlas show <session> [entry] [--context N]
  atlas trace --file PATH [--glob] [--since DATE]
  atlas branches [--abandoned] [--session SESSION]
  atlas unfinished [--since DATE]
  atlas cmd <pattern> [--failed] [--cwd GLOB] [--since DATE] [--until DATE]
  atlas report cost [--by month|project|model|provider] [--since DATE] [--top N]
  atlas report errors [--by tool|signature] [--since DATE]
  atlas cite <session> [entry] [--verify-source]

Global query options: --db PATH, --json, --limit N

Search modes (pre-1.0 compatibility change):
  Default: whitespace-separated literal chunks, quoted and joined with AND.
           Punctuation is passed to FTS tokenization; each chunk needs text.
  --fts:   explicit FTS5 expressions, including OR, NOT and prefix queries.
           Existing operator-based scripts must add --fts.
  --exact: case-sensitive substring, including punctuation and original spacing.
  Empty/whitespace-only input is rejected. --fts and --exact cannot be combined.
  Use -- before literal arguments such as --help or --json.

Source evidence:
  show --context 0 returns full target text and, under --json, original raw JSON
  values (including images/private fields). Bounded output has no raw entries,
  normalizes display whitespace and marks text truncation. Source evidence
  reports whether size/mtime match the index; that is not a content-hash check.
  Modern v3 display streams. Legacy v1/v2 normalization is limited to 16 MiB
  and 100,000 parsed records; it requires Pi's tested session-format version 3.
  cite is index-only by default. --verify-source checks current session/entry
  identity and refuses changed/missing index metadata. Neither mode verifies
  factual truth or approval. Queries do not alter source sessions or logical
  Atlas records. SQLite may access or update WAL/SHM sidecar metadata.

Cache safety and coverage:
  Indexing binds one canonical source root, path-expansion home, parser and
  extraction settings. --file is literal by default; --glob is explicit.
  Incompatible recognized caches require explicit --rebuild. Root changes and
  legacy-v3 binding additionally require --rebind and explicit --sessions-dir.
  Unknown/extended databases, unsafe paths and nonempty WAL/journal state are
  refused without repair. Choose a new private cache path if recognition fails.
  Queries report indexed observations, not current archive freshness; they do
  not refresh/rebuild. Retained failed-file evidence is marked unverified.
  JSON query envelopes add cache provenance/coverage, leaving results intact.

Output: --json emits success/failure envelopes with error.code/error.message
        on failure, preserving partial-index results. Help remains plain text.
Exit:   0 success, 1 invalid usage, 2 operation or output failure.
        Closed stdout pipes are quiet but never clear a known operation failure.
Dates:  YYYY-MM-DD uses inclusive UTC day bounds. Timestamps require an explicit
        Z or ±HH:mm zone and are normalized to UTC; zone-free timestamps fail.

Environment:
  ATLAS_HOME          Store directory (default: ~/.pi/agent/atlas)
  ATLAS_SESSIONS_DIR  Session archive (default: ~/.pi/agent/sessions)
  ATLAS_PI_PACKAGE    Pi package root or dist/index.js override
`;

interface CommandOutcome {
  results: unknown[];
  ok: boolean;
  json: boolean;
  help?: boolean;
  error?: ErrorDetail;
}

let stdoutFailed = false;
function stdoutError(error: unknown): void {
  stdoutFailed = true;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE") return;
  if (!process.exitCode) process.exitCode = 2;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`atlas: [OUTPUT_FAILED] stdout: ${message}\n`);
}

function writeStdout(text: string): void {
  if (stdoutFailed) return;
  try {
    process.stdout.write(text);
  } catch (error) {
    stdoutError(error);
  }
}
process.stdout.on("error", stdoutError);

// Recognize output intent even if option parsing fails first. A token after
// the first -- is data, not a flag; inline values of other options stay data.
function wantsJson(args: string[]): boolean {
  for (const argument of args) {
    if (argument === "--") break;
    if (argument === "--json" || argument.startsWith("--json=")) return true;
  }
  return false;
}

type OptionKind = "boolean" | "string";
interface OptionSpec {
  kind: OptionKind;
  repeat?: boolean;
}
interface ParsedOptions {
  positionals: string[];
  values: Map<string, boolean | string | string[]>;
}

const COMMON_QUERY_OPTIONS: Record<string, OptionSpec> = {
  "--db": { kind: "string" },
  "--json": { kind: "boolean" },
  "--limit": { kind: "string" },
};

function parseOptions(args: string[], specs: Record<string, OptionSpec>): ParsedOptions {
  const positionals: string[] = [];
  const values = new Map<string, boolean | string | string[]>();
  let positionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    let argument = args[index]!;
    if (positionalOnly) {
      positionals.push(argument);
      continue;
    }
    if (argument === "-h") argument = "--help";
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    const inlineValue = equals >= 0 ? argument.slice(equals + 1) : undefined;
    const spec: OptionSpec | undefined = name === "--help" ? { kind: "boolean" } : specs[name];
    if (!spec) throw new UsageError(`unknown option: ${name}`);
    if (spec.kind === "boolean") {
      if (inlineValue !== undefined) throw new UsageError(`${name} does not take a value`);
      values.set(name, true);
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value === undefined || value.length === 0 || (inlineValue === undefined && value.startsWith("--"))) {
      throw new UsageError(`${name} requires a value`);
    }
    if (spec.repeat) {
      const prior = values.get(name);
      values.set(name, [...(Array.isArray(prior) ? prior : []), value]);
    } else {
      values.set(name, value);
    }
  }
  return { positionals, values };
}

function stringOption(parsed: ParsedOptions, name: string): string | undefined {
  const value = parsed.values.get(name);
  return typeof value === "string" ? value : undefined;
}

function stringOptions(parsed: ParsedOptions, name: string): string[] {
  const value = parsed.values.get(name);
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

function booleanOption(parsed: ParsedOptions, name: string): boolean {
  return parsed.values.get(name) === true;
}

function integerOption(
  parsed: ParsedOptions,
  name: string,
  fallback: number,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = stringOption(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new UsageError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function databasePath(parsed: ParsedOptions): string {
  const home = resolve(process.env.ATLAS_HOME ?? join(homedir(), ".pi", "agent", "atlas"));
  return resolve(stringOption(parsed, "--db") ?? join(home, "atlas.db"));
}

function dateBound(value: string | undefined, endOfDay: boolean): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return sourceTimestamp(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    }
    return sourceTimestamp(value);
  } catch {
    throw new UsageError(`date must be YYYY-MM-DD or a valid zone-explicit ISO timestamp: ${value}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function printJson(command: string, ok: boolean, results: unknown[], error?: ErrorDetail): void {
  writeStdout(
    `${JSON.stringify({ ok, command, generatedAt: new Date().toISOString(), results, ...(queryCoverage ? { cache: queryCoverage } : {}), ...(error ? { error } : {}) }, null, 2)}\n`,
  );
}

function printCacheNote(cache: CacheCoverage | null | undefined): void {
  if (!cache || (cache.lastAttempt?.status === "success" && !cache.lastAttempt.parseWarnings && !cache.unverifiedFiles.length)) return;
  writeStdout(`Cache: indexed observations, last successful scan ${cache.lastSuccessfulScan ?? "none"}; latest attempt ${cache.lastAttempt?.status ?? "none"}; ${cache.unverifiedFiles.length} unverified file(s), ${cache.lastAttempt?.parseWarnings ?? 0} parse warning(s).\n`);
  if (cache.unverifiedFiles.length) writeStdout("Retained evidence may be stale; inspect JSON cache.unverifiedFiles for affected paths and reasons.\n");
}

function printHuman(command: string, results: unknown[]): void {
  if (command === "index") {
    const result = results[0] as Record<string, unknown>;
    printCacheNote(result.coverage as CacheCoverage | null);
    writeStdout(
      [
        `Atlas index ${Array.isArray(result.failures) && result.failures.length ? "completed with failures" : "complete"}`,
        `  database: ${String(result.databasePath)} (${formatBytes(Number(result.databaseBytes))})`,
        `  sessions: ${String(result.sessionsDirectory)}`,
        `  files: ${String(result.filesScanned)} scanned, ${String(result.filesChanged)} changed, ${String(result.filesUnchanged)} unchanged, ${String(result.filesRemoved)} removed`,
        `  indexed: ${String(result.sessionsIndexed)} session(s), ${String(result.entriesIndexed)} entries`,
        `  warnings: ${String(result.parseWarnings)}; failures: ${(result.failures as unknown[]).length}`,
        `  duration: ${Number(result.durationMs).toFixed(2)} ms`,
      ].join("\n") + "\n",
    );
    return;
  }
  if (command === "search") {
    for (const item of results as Array<Record<string, unknown>>) {
      writeStdout(`${String(item.citation)}\n  [${String(item.kind)}] ${String(item.timestamp)}\n  ${String(item.snippet)}\n`);
    }
  } else if (command === "sessions") {
    for (const item of results as Array<Record<string, unknown>>) {
      writeStdout(
        `${String(item.lastActivity).slice(0, 10)}  ${String(item.uuid)}  ${String(item.name ?? "(unnamed)")}\n  ${String(item.cwd)}  ${Number(item.cost).toFixed(4)} cost\n`,
      );
    }
  } else if (command === "show") {
    const shown = results[0] as { entries?: Array<Record<string, unknown>>; evidence?: SourceEvidence; contextHistory?: { limitation: string; entries: Array<{ entryId: string; latestValidEditOnObservedBranch: string | null; editAction: string | null }> } };
    if (shown.contextHistory) {
      writeStdout(`Context note: ${shown.contextHistory.limitation}\n`);
      for (const item of shown.contextHistory.entries) {
        if (item.latestValidEditOnObservedBranch) writeStdout(`  ${item.entryId}: ${item.editAction} by ${item.latestValidEditOnObservedBranch} on observed branch; original history follows.\n`);
      }
    }
    if (shown.evidence && shown.evidence.indexState !== "metadata-match") {
      writeStdout(`Source note: ${shown.evidence.indexState}; displaying the current source, not confirming indexed content.\n`);
    }
    if (shown.evidence?.skippedRecords) {
      writeStdout(`Source note: ${shown.evidence.skippedRecords} malformed or unusable source record(s) skipped.\n`);
    }
    for (const entry of shown.entries ?? []) {
      writeStdout(
        `${entry.id === (results[0] as Record<string, unknown>).targetEntryId ? ">" : " "} ${String(entry.timestamp)} ${String(entry.id)} ${String(entry.role ?? entry.type)}\n  ${String(entry.text)}\n`,
      );
    }
  } else if (command === "cite") {
    writeStdout(`${String((results[0] as Record<string, unknown>).citation)}\n`);
  } else if (command === "trace") {
    for (const item of results as Array<Record<string, unknown>>) {
      writeStdout(`${String(item.timestamp)} ${String(item.tool)} ${String(item.pathResolved)}\n  ${String(item.citation)}\n`);
    }
  } else if (command === "branches") {
    for (const item of results as Array<Record<string, unknown>>) {
      writeStdout(`${item.abandoned ? "abandoned" : "active"} ${String(item.tipTimestamp)} ${String(item.tipEntryId)}\n  branch: ${String(item.branchPointId)}; ${String(item.snippet)}\n  ${String(item.citation)}\n`);
    }
  } else if (command === "unfinished") {
    for (const item of results as Array<Record<string, unknown>>) {
      writeStdout(`${String(item.lastActivity)} ${String((item.reasons as unknown[]).join(", "))}\n  ${String(item.snippet)}\n  ${String(item.citation)}\n`);
    }
  } else if (command === "cmd") {
    for (const item of results as Array<Record<string, unknown>>) {
      writeStdout(`${String(item.timestamp)}${item.failed === true ? " [failed]" : ""} $ ${String(item.command)}\n  ${String(item.outputHead ?? "")}\n  ${String(item.citation)}\n`);
    }
  } else if (command === "report") {
    const report = results[0] as Record<string, unknown>;
    if ("totals" in report) {
      const totals = report.totals as Record<string, unknown>;
      writeStdout(`Cost: ${Number(totals.cost).toFixed(6)}; input ${String(totals.tokensIn)}; output ${String(totals.tokensOut)}; cache read ${String(totals.cacheRead)}\n`);
      for (const group of report.groups as Array<Record<string, unknown>>) {
        writeStdout(`  ${String(group.key)}: ${Number(group.cost).toFixed(6)} (${String(group.sessions)} session(s))\n`);
      }
    } else {
      writeStdout(`Tool failures: ${String(report.toolFailures)}; assistant errors: ${String(report.assistantErrors)}; assistant aborts: ${String(report.assistantAborts)}\n`);
      for (const group of report.groups as Array<Record<string, unknown>>) {
        writeStdout(`  ${String(group.key)}: ${String(group.count)}\n`);
      }
    }
  }
  if (results.length === 0) writeStdout("No results.\n");
}

async function runIndex(args: string[]): Promise<CommandOutcome> {
  const parsed = parseOptions(args, {
    "--rebuild": { kind: "boolean" },
    "--rebind": { kind: "boolean" },
    "--tool-head-bytes": { kind: "string" },
    "--sessions-dir": { kind: "string" },
    "--path-home": { kind: "string" },
    "--db": { kind: "string" },
    "--json": { kind: "boolean" },
  });
  if (booleanOption(parsed, "--help")) return { results: [], ok: true, json: false, help: true };
  if (parsed.positionals.length > 0) throw new UsageError("index takes no positional arguments");
  if (booleanOption(parsed, "--rebind") && (!booleanOption(parsed, "--rebuild") || !stringOption(parsed, "--sessions-dir"))) {
    throw new UsageError("--rebind requires --rebuild and an explicit --sessions-dir PATH");
  }
  const result = await indexSessions({
    databasePath: databasePath(parsed),
    sessionsDirectory: resolve(
      stringOption(parsed, "--sessions-dir") ??
        process.env.ATLAS_SESSIONS_DIR ??
        join(homedir(), ".pi", "agent", "sessions"),
    ),
    pathHome: resolve(stringOption(parsed, "--path-home") ?? homedir()),
    rebuild: booleanOption(parsed, "--rebuild"),
    rebind: booleanOption(parsed, "--rebind"),
    toolHeadBytes: integerOption(parsed, "--tool-head-bytes", DEFAULT_TOOL_HEAD_BYTES),
  });
  const ok = result.failures.length === 0;
  return {
    results: [result], ok, json: booleanOption(parsed, "--json"),
    error: ok ? undefined : { code: "INDEX_PARTIAL_FAILURE", message: `Index completed with ${result.failures.length} file failure(s)` },
  };
}

async function runQueryCommand(
  command: string,
  args: string[],
): Promise<CommandOutcome> {
  if (!["search", "sessions", "show", "trace", "branches", "unfinished", "cmd", "report", "cite"].includes(command)) {
    throw new UsageError(`unknown command: ${command}`);
  }
  let specs: Record<string, OptionSpec> = { ...COMMON_QUERY_OPTIONS };
  if (command === "search") {
    specs = {
      ...specs,
      "--kind": { kind: "string", repeat: true },
      "--exact": { kind: "boolean" },
      "--fts": { kind: "boolean" },
      "--dir": { kind: "string" },
      "--cwd": { kind: "string" },
      "--since": { kind: "string" },
      "--until": { kind: "string" },
    };
  } else if (command === "sessions") {
    specs = {
      ...specs,
      "--dir": { kind: "string" },
      "--cwd": { kind: "string" },
      "--since": { kind: "string" },
      "--name": { kind: "string" },
    };
  } else if (command === "show") {
    specs = { ...specs, "--context": { kind: "string" } };
  } else if (command === "cite") {
    specs = { ...specs, "--verify-source": { kind: "boolean" } };
  } else if (command === "trace") {
    specs = { ...specs, "--file": { kind: "string" }, "--glob": { kind: "boolean" }, "--since": { kind: "string" } };
  } else if (command === "branches") {
    specs = { ...specs, "--abandoned": { kind: "boolean" }, "--session": { kind: "string" } };
  } else if (command === "unfinished") {
    specs = { ...specs, "--since": { kind: "string" } };
  } else if (command === "cmd") {
    specs = { ...specs, "--failed": { kind: "boolean" }, "--cwd": { kind: "string" },
      "--since": { kind: "string" }, "--until": { kind: "string" } };
  } else if (command === "report") {
    specs = {
      ...specs,
      "--by": { kind: "string" },
      "--since": { kind: "string" },
      "--top": { kind: "string" },
    };
  }
  const parsed = parseOptions(args, specs);
  if (booleanOption(parsed, "--help")) return { results: [], ok: true, json: false, help: true };
  if (parsed.positionals.some((value) => !value.trim())) throw new UsageError("positional arguments must not be empty");
  const json = booleanOption(parsed, "--json");
  const limit = integerOption(parsed, "--limit", 20, 1, 10_000);
  const since = dateBound(stringOption(parsed, "--since"), false);
  const until = dateBound(stringOption(parsed, "--until"), true);
  if (since && until && since > until) throw new UsageError("--since must not be later than --until");
  const context = integerOption(parsed, "--context", 3, 0, 100);
  const top = integerOption(parsed, "--top", 10, 1, 1_000);
  // Validate usage before opening a cache. A missing DB must not hide bad args.
  let database: DatabaseSync | undefined;
  const getDatabase = (): DatabaseSync => {
    if (!database) { database = openQueryDatabase(databasePath(parsed)); queryCoverage = cacheCoverage(database); }
    return database;
  };
  try {
    if (command === "search") {
      if (parsed.positionals.length === 0) throw new UsageError("search requires a query");
      const allowedKinds = new Set<TextKind>([
        "user",
        "assistant",
        "thinking",
        "tool_head",
        "context_edit",
        "summary",
        "name",
      ]);
      const kinds = stringOptions(parsed, "--kind");
      for (const kind of kinds) {
        if (!allowedKinds.has(kind as TextKind)) throw new UsageError(`unknown text kind: ${kind}`);
      }
      const options = {
        query: parsed.positionals.join(" "),
        kinds: kinds as TextKind[],
        exact: booleanOption(parsed, "--exact"),
        fts: booleanOption(parsed, "--fts"),
        sessionDirectoryGlob: stringOption(parsed, "--dir"),
        cwdGlob: stringOption(parsed, "--cwd"),
        since, until, limit,
      };
      prepareSearchQuery(options);
      return { results: search(getDatabase(), options), ok: true, json };
    }
    if (command === "sessions") {
      if (parsed.positionals.length > 0) throw new UsageError("sessions takes no positional arguments");
      return {
        results: listSessions(getDatabase(), {
          sessionDirectoryGlob: stringOption(parsed, "--dir"),
          cwdGlob: stringOption(parsed, "--cwd"),
          since,
          namePattern: stringOption(parsed, "--name"),
          limit,
        }),
        ok: true,
        json,
      };
    }
    if (command === "show") {
      if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
        throw new UsageError("show requires <session> and optional [entry]");
      }
      const result = await showSession(
        getDatabase(),
        parsed.positionals[0]!,
        parsed.positionals[1],
        context,
      );
      return { results: [result], ok: true, json };
    }
    if (command === "trace") {
      if (parsed.positionals.length > 0) throw new UsageError("trace takes --file PATH, not positional arguments");
      const file = stringOption(parsed, "--file");
      if (!file) throw new UsageError("trace requires --file PATH");
      return {
        results: traceFile(getDatabase(), {
          file,
          glob: booleanOption(parsed, "--glob"),
          since,
          limit,
        }),
        ok: true,
        json,
      };
    }
    if (command === "branches") {
      if (parsed.positionals.length > 0) throw new UsageError("branches takes no positional arguments");
      return {
        results: findBranches(getDatabase(), {
          abandonedOnly: booleanOption(parsed, "--abandoned"),
          sessionReference: stringOption(parsed, "--session"),
          limit,
        }),
        ok: true,
        json,
      };
    }
    if (command === "unfinished") {
      if (parsed.positionals.length > 0) throw new UsageError("unfinished takes no positional arguments");
      return {
        results: findUnfinished(getDatabase(), {
          since,
          limit,
        }),
        ok: true,
        json,
      };
    }
    if (command === "cmd") {
      if (parsed.positionals.length === 0) throw new UsageError("cmd requires a pattern");
      return {
        results: searchCommands(getDatabase(), {
          pattern: parsed.positionals.join(" "),
          failed: booleanOption(parsed, "--failed"),
          cwdGlob: stringOption(parsed, "--cwd"),
          since, until, limit,
        }),
        ok: true,
        json,
      };
    }
    if (command === "report") {
      if (parsed.positionals.length !== 1) throw new UsageError("report requires 'cost' or 'errors'");
      const reportType = parsed.positionals[0];
      if (reportType === "cost") {
        const by = stringOption(parsed, "--by") ?? "month";
        if (!["month", "project", "model", "provider"].includes(by)) {
          throw new UsageError(`invalid cost grouping: ${by}`);
        }
        return {
          results: [costReport(getDatabase(), {
            by: by as CostGrouping,
            since,
            top,
          })],
          ok: true,
          json,
        };
      }
      if (reportType === "errors") {
        const by = stringOption(parsed, "--by") ?? "tool";
        if (!["tool", "signature"].includes(by)) throw new UsageError(`invalid error grouping: ${by}`);
        return {
          results: [errorReport(getDatabase(), {
            by: by as ErrorGrouping,
            since,
            limit,
          })],
          ok: true,
          json,
        };
      }
      throw new UsageError(`unknown report: ${reportType}`);
    }
    if (command === "cite") {
      if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
        throw new UsageError("cite requires <session> and optional [entry]");
      }
      return {
        results: [booleanOption(parsed, "--verify-source")
          ? await verifyCitation(getDatabase(), parsed.positionals[0]!, parsed.positionals[1])
          : cite(getDatabase(), parsed.positionals[0]!, parsed.positionals[1])],
        ok: true,
        json,
      };
    }
    throw new UsageError(`unknown command: ${command}`);
  } finally {
    database?.close();
  }
}

const argv = process.argv.slice(2);
async function main(): Promise<void> {
  const args = [...argv];
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    writeStdout(HELP);
    return;
  }
  const command = args.shift()!;
  const outcome =
    command === "index"
      ? await runIndex(args)
      : await runQueryCommand(command, args);
  if (!outcome.ok) process.exitCode = 2;
  if (outcome.help) writeStdout(HELP);
  else if (outcome.json) printJson(command, outcome.ok, outcome.results, outcome.error);
  else { printCacheNote(queryCoverage); printHuman(command, outcome.results); }
}

main().catch((error: unknown) => {
  const failure = failureFor(error);
  // Set the operation status before writing: EPIPE must not turn failure into success.
  process.exitCode = failure.exitCode;
  if (wantsJson(argv)) {
    printJson(argv[0] ?? "", false, [], failure.error);
  } else {
    process.stderr.write(`atlas: ${failure.error.message}\n`);
    if (failure.error.candidates) process.stderr.write(`tried: ${failure.error.candidates.join(", ")}\n`);
    if (failure.exitCode === 1) process.stderr.write("Run 'atlas --help' for usage.\n");
  }
});
