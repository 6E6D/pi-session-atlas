// Review-only, explicit-run probes. Not part of the normal 159-test suite.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractSession } from '../../src/extract.ts';
import { sourceTimestamp } from '../../src/timestamps.ts';
import { resolvePiParser } from '../../src/resolve-pi.ts';
import { createArchive, createSandbox, fingerprint } from '../prepublication-support.ts';
import { toJsonl, writeFixture, type FixtureEntry } from '../fixtures.ts';

// Integer Gregorian civil-day arithmetic, independent of source-string parsing.
function civilDays(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0), era = Math.floor(y / 400), yo = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146097 + yo * 365 + Math.floor(yo / 4) - Math.floor(yo / 100) + doy - 719468;
}
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
test('successor review: every four-digit year agrees with integer calendar arithmetic across offsets and fractional precision', () => {
  const fractions = ['', '.0000001', '.9999999', '.12', '.007'], millis = [0, 0, 999, 120, 7];
  const offsets = [-1439, -720, -1, 0, 1, 345, 1439];
  function check(y: number, m: number, d: number, h: number, min: number, sec: number, i: number, offset: number) {
    const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    const source = `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(sec)}${fractions[i]}${zone}`;
    const expected = civilDays(y, m, d) * 86400000 + h * 3600000 + min * 60000 + sec * 1000 + millis[i]! - offset * 60000;
    assert.ok(Number.isSafeInteger(expected));
    if (expected < civilDays(0, 1, 1) * 86400000 || expected >= civilDays(10000, 1, 1) * 86400000) assert.throws(() => sourceTimestamp(source), /four-digit/);
    else assert.equal(sourceTimestamp(source), new Date(expected).toISOString(), source);
  }
  for (let y = 0; y < 10000; y++) {
    check(y, y % 12 + 1, y % 28 + 1, y % 24, y * 7 % 60, y * 11 % 60, y % 5, offsets[y % offsets.length]!);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0), feb = `${pad(y, 4)}-02-29T00:00:00Z`;
    if (leap) assert.equal(sourceTimestamp(feb), `${pad(y, 4)}-02-29T00:00:00.000Z`);
    else assert.throws(() => sourceTimestamp(feb), /calendar/);
  }
  for (const offset of offsets) { check(0, 1, 1, 0, 0, 0, 0, offset); check(9999, 12, 31, 23, 59, 59, 2, offset); }
});

function events(uuid: string, times: string[]): FixtureEntry[] {
  return [{ type: 'session', id: uuid, version: 3, cwd: '/workspace/fixture', timestamp: '2026-01-01T00:00:00Z' },
    ...times.map((timestamp, i) => ({ type: 'message', id: pad(i + 1, 8), parentId: i ? pad(i, 8) : null, timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic successor evidence' }, { type: 'toolCall', name: 'bash', id: `call-${i}`, arguments: { command: 'successor-check' } }], usage: { cost: { total: i ? 1 : 10 } } } }))];
}
function result(a: ReturnType<typeof createSandbox>, args: string[], executable?: string, status = 0): any {
  const r = a.cli([...args, '--json'], { executable }); assert.equal(r.status, status, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout); assert.equal(parsed.ok, status === 0); return parsed;
}
function oldBin(): string { const bin = process.env.ATLAS_REVIEW_LEGACY_BIN; assert.ok(bin, 'explicit verified legacy artifact launcher required'); return bin; }
function snapshot(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(['sessions', 'entries', 'text_fts', 'tool_calls', 'catalog'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}

test('successor review: a genuine prior compiled v1 cache refuses reuse and queries, then explicitly rebuilds into v3', t => {
  const a = createSandbox(t), entries = events('fixture-prior-artifact', ['2026-09-05T01:30:00+02:00', '2026-09-04T23:00:00-02:00']);
  const file = writeFixture(a.sessionsDirectory, 'source.jsonl', entries), before = fingerprint(file);
  const initial = result(a, ['index'], oldBin()); assert.equal(initial.results[0].coverage.identity.extractionVersion, 1);
  assert.equal(result(a, ['report', 'cost', '--since', '2026-09-05'], oldBin()).results[0].totals.cost, 10);
  const old = fingerprint(a.databasePath);
  for (const args of [['sessions'], ['cite', 'fixture-prior-artifact', '00000002']]) assert.equal(result(a, args, undefined, 2).error.code, 'CACHE_EXTRACTION_MISMATCH');
  assert.equal(result(a, ['index'], undefined, 2).error.code, 'CACHE_IDENTITY_MISMATCH'); assert.deepEqual(fingerprint(a.databasePath), old);
  const rebuilt = result(a, ['index', '--rebuild']); assert.equal(rebuilt.results[0].committed, true);
  assert.equal(rebuilt.results[0].coverage.identity.extractionVersion, 3); assert.equal(rebuilt.results[0].filesChanged, 1);
  assert.equal(result(a, ['report', 'cost', '--since', '2026-09-05']).results[0].totals.cost, 1);
  assert.equal(result(a, ['cite', 'fixture-prior-artifact', '00000002', '--verify-source']).results[0].timestamp, '2026-09-05T01:00:00.000Z');
  assert.deepEqual(result(a, ['show', 'fixture-prior-artifact', '00000002', '--context', '0']).results[0].entries[0].raw, entries[2]);
  assert.deepEqual(fingerprint(file), before);
});

test('successor review: genuine v1 multi-file replacement rolls back already normalized rows when another source has invalid time', t => {
  const a = createSandbox(t), times = ['2026-09-05T01:30:00+02:00', '2026-09-04T23:00:00-02:00'];
  const first = events('fixture-first', times), second = events('fixture-second', times);
  const good = writeFixture(a.sessionsDirectory, 'a.jsonl', first); writeFixture(a.sessionsDirectory, 'z.jsonl', second);
  const initial = result(a, ['index'], oldBin()).results[0].coverage, corpus = snapshot(a.databasePath), goodBefore = fingerprint(good);
  second[1]!.timestamp = false; const invalid = writeFixture(a.sessionsDirectory, 'z.jsonl', second), invalidBefore = fingerprint(invalid);
  const rejected = result(a, ['index', '--rebuild'], undefined, 2).results[0];
  assert.equal(rejected.committed, false); assert.equal(rejected.filesChanged, 0); assert.equal(rejected.failures.length, 1);
  assert.deepEqual(rejected.coverage.identity, initial.identity); assert.equal(rejected.coverage.lastSuccessfulScan, initial.lastSuccessfulScan);
  assert.deepEqual(snapshot(a.databasePath), corpus); assert.equal(result(a, ['sessions'], undefined, 2).error.code, 'CACHE_EXTRACTION_MISMATCH');
  assert.deepEqual(fingerprint(good), goodBefore); assert.deepEqual(fingerprint(invalid), invalidBefore);
});

test('successor review: timestamp interpretation applies to non-message records and all indexed text kinds without changing payloads', async t => {
  const a = createSandbox(t), parser = (await resolvePiParser()).api, entries = events('fixture-event-kinds', []);
  for (const [i, type] of ['model_change', 'thinking_level_change', 'session_info', 'compaction', 'branch_summary', 'custom', 'custom_message', 'label'].entries()) {
    entries.push({ type, id: pad(i + 1, 8), parentId: i ? pad(i, 8) : null, timestamp: '2026-09-01T01:00:00.007123+02:00',
      name: 'synthetic title', summary: 'synthetic summary', customType: 'fixture', label: 'synthetic label', modelId: 'fixture-model', provider: 'fixture-provider', usage: { cost: { total: 1 } } });
  }
  const bytes = toJsonl(entries), normalized = extractSession(bytes, join(a.sessionsDirectory, 'source.jsonl'), parser);
  assert.equal(normalized.entries.length, 8); assert.equal(normalized.lastActivity, '2026-08-31T23:00:00.007Z');
  for (const row of [...normalized.entries, ...normalized.texts]) assert.equal(row.timestamp, '2026-08-31T23:00:00.007Z');
  assert.equal(normalized.cost, 2); assert.deepEqual(normalized.texts.map(v => v.kind), ['name', 'summary', 'summary']);
  assert.equal(toJsonl(entries), bytes);
});

test('successor review: equivalent instants and submillisecond collapse retain inclusive windows and deterministic command ties', async t => {
  const entries = events('fixture-precision-ties', ['2026-09-01T05:30:00.123999+05:30', '2026-09-01T00:00:00.1230001Z', '2026-09-01T00:00:00.122999Z']);
  const a = await createArchive(t, { files: { 'source.jsonl': entries } }), before = fingerprint(a.databasePath), source = fingerprint(join(a.sessionsDirectory, 'source.jsonl'));
  const args = ['cmd', 'successor-check', '--since', '2026-09-01T00:00:00.123999Z', '--until', '2026-09-01T00:00:00.1230001Z'];
  for (let i = 0; i < 3; i++) assert.deepEqual(result(a, args).results.map((r: any) => [r.entryId, r.timestamp]), [['00000001', '2026-09-01T00:00:00.123Z'], ['00000002', '2026-09-01T00:00:00.123Z']]);
  assert.equal(result(a, ['report', 'cost', '--since', '2026-09-01T00:00:00.123Z']).results[0].totals.cost, 11);
  assert.deepEqual(fingerprint(a.databasePath), before); assert.deepEqual(fingerprint(join(a.sessionsDirectory, 'source.jsonl')), source);
});
