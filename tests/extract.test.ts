import assert from "node:assert/strict";
import { test } from "node:test";

import { extractSession } from "../src/extract.ts";
import { resolvePiParser } from "../src/resolve-pi.ts";
import { branchedSessionFixture, linearLegacyV1Fixture, toJsonl, usage } from "./fixtures.ts";

test("extracts tree, text, provenance, usage, and warnings deterministically", async () => {
  const parser = (await resolvePiParser()).api;
  const session = extractSession(
    toJsonl(branchedSessionFixture(), true),
    "/tmp/sessions/project/fixture.jsonl",
    parser,
    { toolHeadBytes: 32 },
  );

  assert.equal(session.uuid, "fixture-session-alpha");
  assert.equal(session.name, "Fixture Atlas investigation");
  assert.equal(session.entryCount, 11);
  assert.equal(session.userMessages, 3);
  assert.equal(session.assistantMessages, 3);
  assert.equal(session.toolResults, 2);
  assert.equal(session.firstUserText, "Investigate Atlas branches");
  assert.deepEqual(session.models, ["test-provider/test-model"]);
  assert.equal(session.cost, 0.065);
  assert.equal(session.warnings.length, 1);
  assert.match(session.warnings[0]!, /1 malformed/);

  const branchPoint = session.entries.find((entry) => entry.id === "00000004");
  assert.equal(branchPoint?.childCount, 2);
  assert.equal(branchPoint?.onActivePath, true);
  assert.equal(session.entries.find((entry) => entry.id === "00000006")?.onActivePath, false);
  assert.equal(session.entries.find((entry) => entry.id === "0000000b")?.onActivePath, true);

  const readCall = session.toolCalls.find((call) => call.tool === "read" && call.source === "toolCall");
  assert.equal(readCall?.pathRaw, "src/main.ts");
  assert.equal(readCall?.pathResolved, "/workspace/project/src/main.ts");
  assert.equal(readCall?.exitError, false);

  const bashCall = session.toolCalls.find((call) => call.tool === "bash");
  assert.equal(bashCall?.command, "npm test");
  assert.equal(bashCall?.exitError, true);

  const compactedEdit = session.toolCalls.find(
    (call) => call.source === "compaction_details" && call.tool === "edit",
  );
  assert.equal(compactedEdit?.pathResolved, "/workspace/project/src/output.ts");

  const longHead = session.texts.find(
    (text) => text.kind === "tool_head" && text.content.startsWith("x"),
  );
  assert.ok(longHead);
  assert.ok(Buffer.byteLength(longHead.content, "utf8") <= 32);
  assert.equal(longHead.content.includes("�"), false);
  assert.ok(session.texts.some((text) => text.kind === "summary"));
  assert.ok(session.texts.some((text) => text.kind === "name"));
});

test("modern retainedTail compactions do not duplicate retained messages", async () => {
  const parser = (await resolvePiParser()).api;
  const fixture = branchedSessionFixture();
  const compaction = fixture.find((entry) => entry.type === "compaction");
  assert.ok(compaction);
  compaction.retainedTail = [
    { role: "user", content: "Use the active approach", timestamp: 7 },
    {
      role: "assistant",
      content: [{ type: "text", text: "The active branch is complete." }],
      provider: "test-provider",
      model: "test-model",
      usage: usage(0.03),
      stopReason: "stop",
      timestamp: 8,
    },
  ];
  const session = extractSession(toJsonl(fixture), "/tmp/retained-tail.jsonl", parser);
  assert.equal(
    session.texts.filter((text) => text.content === "Use the active approach").length,
    1,
  );
  assert.equal(session.texts.filter((text) => text.kind === "summary").length, 1);
});

test("legacy v1 synthetic IDs are stable across rebuilds", async () => {
  const parser = (await resolvePiParser()).api;
  const content = toJsonl(linearLegacyV1Fixture());
  const first = extractSession(content, "/tmp/legacy.jsonl", parser);
  const second = extractSession(content, "/tmp/legacy.jsonl", parser);

  assert.deepEqual(
    first.entries.map(({ id, parentId }) => ({ id, parentId })),
    second.entries.map(({ id, parentId }) => ({ id, parentId })),
  );
  assert.match(first.entries[0]!.id, /^v1-[0-9a-f]{12}$/);
  assert.equal(first.entries[1]!.parentId, first.entries[0]!.id);
});
