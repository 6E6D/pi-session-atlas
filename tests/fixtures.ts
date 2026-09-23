import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FixtureEntry = Record<string, unknown>;

export function usage(cost = 0.01): Record<string, unknown> {
  return {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 10,
    totalTokens: 180,
    cost: {
      input: cost / 2,
      output: cost / 2,
      cacheRead: 0,
      cacheWrite: 0,
      total: cost,
    },
  };
}

export function branchedSessionFixture(): FixtureEntry[] {
  const t = (second: number): string => `2026-08-23T10:00:${String(second).padStart(2, "0")}.000Z`;
  return [
    {
      type: "session",
      version: 3,
      id: "fixture-session-alpha",
      timestamp: t(0),
      cwd: "/workspace/project",
    },
    {
      type: "message",
      id: "00000001",
      parentId: null,
      timestamp: t(1),
      message: { role: "user", content: "Investigate Atlas branches", timestamp: 1 },
    },
    {
      type: "message",
      id: "00000002",
      parentId: "00000001",
      timestamp: t(2),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect the tree deterministically." },
          { type: "text", text: "I will inspect the project." },
          { type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/main.ts" } },
          { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "npm test" } },
        ],
        api: "messages",
        provider: "test-provider",
        model: "test-model",
        usage: usage(0.02),
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "00000003",
      parentId: "00000002",
      timestamp: t(3),
      message: {
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: [{ type: "text", text: `${"x".repeat(80)}🙂tail` }],
        isError: false,
        timestamp: 3,
      },
    },
    {
      type: "message",
      id: "00000004",
      parentId: "00000003",
      timestamp: t(4),
      message: {
        role: "toolResult",
        toolCallId: "call-bash",
        toolName: "bash",
        content: [{ type: "text", text: "Tests failed: expected 1, got 2" }],
        isError: true,
        timestamp: 4,
      },
    },
    {
      type: "message",
      id: "00000005",
      parentId: "00000004",
      timestamp: t(5),
      message: { role: "user", content: "Try the abandoned approach", timestamp: 5 },
    },
    {
      type: "message",
      id: "00000006",
      parentId: "00000005",
      timestamp: t(6),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "This path was interrupted." }],
        api: "messages",
        provider: "test-provider",
        model: "test-model",
        usage: usage(0.01),
        stopReason: "aborted",
        timestamp: 6,
      },
    },
    {
      type: "message",
      id: "00000007",
      parentId: "00000004",
      timestamp: t(7),
      message: { role: "user", content: "Use the active approach", timestamp: 7 },
    },
    {
      type: "message",
      id: "00000008",
      parentId: "00000007",
      timestamp: t(8),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The active branch is complete." }],
        api: "messages",
        provider: "test-provider",
        model: "test-model",
        usage: usage(0.03),
        stopReason: "stop",
        timestamp: 8,
      },
    },
    {
      type: "compaction",
      id: "00000009",
      parentId: "00000008",
      timestamp: t(9),
      summary: "The active branch was selected.",
      firstKeptEntryId: "00000007",
      tokensBefore: 1000,
      usage: usage(0.005),
      details: { readFiles: ["docs/input.md"], modifiedFiles: ["src/output.ts"] },
    },
    {
      type: "session_info",
      id: "0000000a",
      parentId: "00000009",
      timestamp: t(10),
      name: "Fixture Atlas investigation",
    },
    {
      type: "custom",
      id: "0000000b",
      parentId: "0000000a",
      timestamp: t(11),
      customType: "pi-handoff/packet-v1",
      data: { state: "fixture" },
    },
  ];
}

export function linearLegacyV1Fixture(): FixtureEntry[] {
  return [
    {
      type: "session",
      version: 1,
      id: "fixture-legacy-v1",
      timestamp: "2025-01-01T00:00:00.000Z",
      cwd: "/legacy",
    },
    {
      type: "message",
      timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "user", content: "Legacy prompt", timestamp: 1 },
    },
    {
      type: "message",
      timestamp: "2025-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Legacy answer" }],
        provider: "test-provider",
        model: "test-model",
        usage: usage(),
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
}

export function toJsonl(entries: FixtureEntry[], malformedTrailingLine = false): string {
  const lines = entries.map((entry) => JSON.stringify(entry));
  if (malformedTrailingLine) lines.push('{"type":"message","id":"partial"');
  return `${lines.join("\n")}\n`;
}

export function writeFixture(
  directory: string,
  filename: string,
  entries: FixtureEntry[],
  malformedTrailingLine = false,
): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, toJsonl(entries, malformedTrailingLine), { mode: 0o600 });
  return path;
}
