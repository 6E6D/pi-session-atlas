import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { indexSessions } from '../src/indexer.ts';
import { cacheCoverage } from '../src/cache.ts';
import { openQueryDatabase, resolveSession } from '../src/query-db.ts';
import { inspectSource } from '../src/source.ts';
import { toJsonl, type FixtureEntry } from './fixtures.ts';
import type { CostReport } from '../src/queries/reports.ts';
import { performance } from 'node:perf_hooks';
import { createArchive, createSandbox, fingerprint, userSession } from './prepublication-support.ts';
import { copyNode, copyRuntime, npmProbe, runNode, shellQuote } from './package-support.ts';

// Unit-7 review reproducers promoted into the normal acceptance suite.
// R4 entry-time filtering was explicitly approved before repair.
test('known root-A uncertainty survives failed explicit replacement with root B', async (t) => {
  const a = await createArchive(t, { files: { 'source.jsonl': userSession('fixture-review', ['review text']) } });
  const sourceBefore = fingerprint(join(a.sessionsDirectory, 'source.jsonl'));
  const db = new DatabaseSync(a.databasePath);
  const row = db.prepare('SELECT last_attempt FROM cache_metadata').get()!;
  const attempt = JSON.parse(String(row.last_attempt));
  attempt.status = 'running'; attempt.finishedAt = null; attempt.enumerationComplete = false;
  db.prepare('UPDATE cache_metadata SET last_attempt = ?').run(JSON.stringify(attempt)); db.close();
  const call = () => a.cli(['cite', 'fixture-review', '00000001', '--verify-source', '--json']);
  assert.equal(call().status, 2, 'known interrupted scan must initially prevent verification');
  const other = join(a.root, 'failed replacement root'); mkdirSync(other);
  writeFileSync(join(other, 'broken.jsonl'), '{broken\n');
  const replacement = a.cli(['index', '--rebuild', '--rebind', '--sessions-dir', other, '--json']);
  assert.equal(replacement.status, 2); assert.equal(JSON.parse(replacement.stdout).results[0].committed, false);
  const query = JSON.parse(a.cli(['sessions', '--json']).stdout);
  assert.equal(query.cache.identity.sourceRoot, a.sessionsDirectory);
  assert.deepEqual(fingerprint(join(a.sessionsDirectory, 'source.jsonl')), sourceBefore);
  const after = call();
  console.log(JSON.stringify({scenario:'failed-rebind', unverified:query.cache.unverifiedFiles.length, verificationExit:after.status}));
  assert.equal(after.status, 2, 'failed rebind must not erase previously known source uncertainty');
});

test('npm discovery timeout is a bound even when the child ignores SIGTERM', (t) => {
  const a = createSandbox(t); const node = copyNode(a.root);
  const executable = copyRuntime(join(a.root, 'app', 'node_modules', 'session-atlas'));
  // No persistent child: sleep always terminates itself after four seconds.
  const pidFile = join(a.root, "probe.pid");
  const bin = npmProbe(a.root, `echo $$ > ${shellQuote(pidFile)}\ntrap '' TERM\nexec /bin/sleep 4`);
  const start = performance.now();
  const result = runNode(node, [executable, 'index', '--json'], a.root, { ...a.env, ATLAS_PI_PACKAGE:undefined, PATH:bin });
  const elapsedMs = performance.now() - start;
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error.code, 'PI_PARSER_UNAVAILABLE');
  assert.equal(existsSync(a.databasePath), false);
  console.log(JSON.stringify({scenario:'npm-timeout', elapsedMs}));
  assert.ok(elapsedMs < 3500, 'documented two-second npm probe needs bounded termination, not only SIGTERM');
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), {code:'ESRCH'}, 'the owned probe is reaped');
});

test('source reads refuse a symlink replacing an indexed path instead of leaving the selected root', async (t) => {
  const a = await createArchive(t, { files: { 'source.jsonl':userSession('fixture-review', ['synthetic moved source']) } });
  const original = join(a.sessionsDirectory, 'source.jsonl'); const moved = join(a.root, 'outside-source-root.jsonl');
  renameSync(original, moved); symlinkSync(moved, original);
  const before = fingerprint(moved);
  const result = a.cli(['cite', 'fixture-review', '00000001', '--verify-source', '--json']);
  const display = a.cli(['show', 'fixture-review', '00000001', '--context', '0', '--json']);
  assert.deepEqual(fingerprint(moved), before);
  console.log(JSON.stringify({scenario:'source-alias', verifyExit:result.status, displayExit:display.status}));
  assert.equal(result.status, 2, 'reject a source alias before following it outside the selected root');
  assert.equal(display.status, 2);
  for (const r of [result, display]) assert.equal(JSON.parse(r.stdout).error.code, 'SOURCE_UNSAFE_PATH');
});

test('dated cost report uses the same time window for totals and month groups', async (t) => {
  const entries = userSession('fixture-cost-review', ['synthetic cost window']);
  entries[0]!.timestamp = '2026-09-01T00:00:00.000Z'; entries[1]!.timestamp = '2026-09-01T00:00:01.000Z';
  for (const [index, date, cost] of [[2, '2026-09-01T00:00:02.000Z', 10], [3, '2026-09-10T00:00:00.000Z', 1]] as const) {
    entries.push({type:'message', id:String(index).padStart(8,'0'), parentId:String(index-1).padStart(8,'0'), timestamp:date,
      message:{role:'assistant', content:[{type:'text',text:'synthetic answer'}], model:'fixture-model', provider:'fixture-provider', stopReason:'stop',
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:cost}}}});
  }
  const a = await createArchive(t, { files:{'cost.jsonl':entries} });
  const before = fingerprint(a.databasePath);
  const result = a.cli(['report','cost','--by','month','--since','2026-09-05','--json']);
  assert.equal(result.status,0);
  const report = JSON.parse(result.stdout).results[0];
  assert.deepEqual(fingerprint(a.databasePath),before);
  console.log(JSON.stringify({scenario:'cost-window',total:report.totals.cost,groups:report.groups.map((g:any)=>g.cost)}));
  assert.equal(report.totals.cost,1,'dated totals must not silently include earlier entry costs');
});

function storedCoverage(path: string) {
  const db = openQueryDatabase(path);
  try { return cacheCoverage(db); } finally { db.close(); }
}

for (const prior of ['running', 'failed', 'missing', 'incomplete', 'explicit'] as const) {
  test(`R1 preserves ${prior} uncertainty and reasons through rollback and exception until successful observation`, async (t) => {
    const a = await createArchive(t, { files: {
      'a.jsonl': userSession('fixture-prior-a', ['retained A']),
      'b.jsonl': userSession('fixture-prior-b', ['retained B']),
    } });
    const paths = ['a.jsonl', 'b.jsonl'].map((p) => join(a.sessionsDirectory, p));
    const before = paths.map(fingerprint);
    const db = new DatabaseSync(a.databasePath);
    try {
      const attempt = JSON.parse(String(db.prepare('SELECT last_attempt FROM cache_metadata').get()!.last_attempt));
      attempt.status = prior === 'running' ? 'running' : prior === 'failed' ? 'failed' : 'partial';
      attempt.finishedAt = prior === 'running' ? null : attempt.finishedAt;
      attempt.enumerationComplete = prior !== 'incomplete';
      db.prepare('UPDATE cache_metadata SET last_attempt=?').run(prior === 'missing' ? null : JSON.stringify(attempt));
      db.prepare('INSERT INTO file_health(file,message) VALUES(?,?)').run(paths[0]!, 'synthetic prior reason retained');
    } finally { db.close(); }
    const priorCoverage = storedCoverage(a.databasePath);
    const other = join(a.root, 'rejected replacement'); mkdirSync(other);
    writeFileSync(join(other, 'broken.jsonl'), '{broken\n');
    const badSourceBefore = fingerprint(join(other, 'broken.jsonl'));
    const replacement = a.cli(['index', '--rebuild', '--rebind', '--sessions-dir', other, '--json']);
    assert.equal(replacement.status, 2);
    assert.equal(JSON.parse(replacement.stdout).results[0].committed, false);
    let calls = 0;
    await assert.rejects(indexSessions({ databasePath:a.databasePath, sessionsDirectory:other, rebuild:true, rebind:true,
      now: () => { if (++calls === 2) throw new Error('synthetic finishing-clock failure'); return new Date(); },
    }, a.parser), /synthetic finishing-clock failure/);
    const after = storedCoverage(a.databasePath);
    assert.deepEqual(after.identity, priorCoverage.identity);
    assert.deepEqual(after.unverifiedFiles, priorCoverage.unverifiedFiles);
    assert.equal(after.lastSuccessfulScan, priorCoverage.lastSuccessfulScan);
    assert.equal(after.lastAttempt?.sourceRoot, other);
    assert.equal(after.lastAttempt?.status, 'failed');
    assert.equal(a.cli(['cite', 'fixture-prior-a', '00000001', '--verify-source', '--json']).status, 2);
    assert.equal(a.cli(['cite', 'fixture-prior-b', '00000001', '--verify-source', '--json']).status, prior === 'explicit' ? 0 : 2);
    const refreshed = await indexSessions({ databasePath:a.databasePath, sessionsDirectory:a.sessionsDirectory }, a.parser);
    assert.deepEqual(refreshed.failures, []);
    assert.equal(refreshed.filesChanged, priorCoverage.unverifiedFiles.length);
    assert.equal(refreshed.filesUnchanged, 2 - priorCoverage.unverifiedFiles.length);
    assert.deepEqual(refreshed.coverage?.unverifiedFiles, []);
    assert.equal(a.cli(['cite', 'fixture-prior-a', '00000001', '--verify-source', '--json']).status, 0);
    assert.deepEqual(paths.map(fingerprint), before);
    assert.deepEqual(fingerprint(join(other, 'broken.jsonl')), badSourceBefore);
  });
}

test('R1 leaves a healthy unrelated root trusted on failed rebind and clears old health on successful replacement', async (t) => {
  const a = await createArchive(t, {files:{'a.jsonl':userSession('fixture-healthy', ['healthy source'])}});
  const source = join(a.sessionsDirectory, 'a.jsonl'); const before = fingerprint(source);
  const other = join(a.root, 'other root'); mkdirSync(other); const replacement = join(other, 'source.jsonl');
  writeFileSync(replacement, '{broken\n');
  const options = {databasePath:a.databasePath, sessionsDirectory:other, rebuild:true, rebind:true};
  assert.equal((await indexSessions(options, a.parser)).committed, false);
  assert.deepEqual(storedCoverage(a.databasePath).unverifiedFiles, []);
  assert.equal(a.cli(['cite', 'fixture-healthy', '00000001', '--verify-source', '--json']).status, 0);
  const db = new DatabaseSync(a.databasePath);
  db.prepare('INSERT INTO file_health(file,message) VALUES(?,?)').run(source, 'synthetic prior uncertainty'); db.close();
  writeFileSync(replacement, toJsonl(userSession('fixture-replacement', ['new source'])));
  const otherBefore = fingerprint(replacement);
  const result = await indexSessions(options, a.parser);
  assert.equal(result.committed, true); assert.equal(result.coverage?.identity.sourceRoot, other);
  assert.deepEqual(result.coverage?.unverifiedFiles, []);
  assert.equal(a.cli(['cite', 'fixture-replacement', '00000001', '--verify-source', '--json']).status, 0);
  assert.deepEqual(fingerprint(source), before); assert.deepEqual(fingerprint(replacement), otherBefore);
});

async function nestedArchive(t: TestContext, uuid: string) {
  const a = await createArchive(t, {files:{'source.jsonl':userSession(uuid, ['scoped source'])}});
  mkdirSync(join(a.sessionsDirectory, 'nested'));
  renameSync(join(a.sessionsDirectory, 'source.jsonl'), join(a.sessionsDirectory, 'nested', 'source.jsonl'));
  const result = await indexSessions({databasePath:a.databasePath, sessionsDirectory:a.sessionsDirectory}, a.parser);
  assert.deepEqual(result.failures, []);
  return a;
}

for (const kind of ['parent', 'root', 'outside-catalog'] as const) {
  test(`R2 refuses ${kind} substitutions before opening a source`, async (t) => {
    const a = await nestedArchive(t, 'fixture-scope');
    const file = join(a.sessionsDirectory, 'nested', 'source.jsonl');
    let moved: string;
    if (kind === 'outside-catalog') {
      moved = join(a.root, 'outside.jsonl'); renameSync(file, moved);
      const writer = new DatabaseSync(a.databasePath);
      writer.prepare('UPDATE sessions SET file=?').run(moved);
      writer.prepare('UPDATE catalog SET file=?').run(moved); writer.close();
    } else {
      const original = kind === 'root' ? a.sessionsDirectory : join(a.sessionsDirectory, 'nested');
      const target = join(a.root, 'moved directory'); renameSync(original, target); symlinkSync(target, original);
      moved = kind === 'root' ? join(target, 'nested', 'source.jsonl') : join(target, 'source.jsonl');
    }
    const before = fingerprint(moved); const cacheBefore = fingerprint(a.databasePath);
    const open = fsp.open; let opened = 0; let visits = 0;
    const mock = t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
      opened++; return Reflect.apply(open, fsp, args);
    }); syncBuiltinESMExports();
    const db = openQueryDatabase(a.databasePath);
    try {
      await assert.rejects(inspectSource(db, resolveSession(db, 'fixture-scope'), '00000001', () => { visits++; }), {code:'SOURCE_UNSAFE_PATH'});
      assert.equal(opened, 0); assert.equal(visits, 0);
    } finally { db.close(); mock.mock.restore(); syncBuiltinESMExports(); }
    for (const args of [['show', '--context', '0'], ['show', '--context', '1'], ['cite', '--verify-source']]) {
      const [command, ...flags] = args;
      const r = a.cli([command!, 'fixture-scope', '00000001', ...flags, '--json']);
      assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).error.code, 'SOURCE_UNSAFE_PATH');
    }
    assert.equal(a.cli(['cite', 'fixture-scope', '00000001', '--json']).status, 0, 'default citation stays index-only');
    assert.deepEqual(fingerprint(moved), before); assert.deepEqual(fingerprint(a.databasePath), cacheBefore);
  });
}

test('R2 detects ancestor substitution between validation and first read, and during a visitor', async (t) => {
  for (const timing of ['after-open', 'during-read']) {
    const a = await nestedArchive(t, 'fixture-race-alias');
    const parent = join(a.sessionsDirectory, 'nested'); const moved = join(a.root, 'moved parent');
    const file = join(parent, 'source.jsonl'); let changed = false; let visits = 0;
    const substitute = () => { if (!changed) { renameSync(parent, moved); symlinkSync(moved, parent); changed = true; } };
    const originalOpen = fsp.open;
    const mock = t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
      const handle = await Reflect.apply(originalOpen, fsp, args);
      if (timing === 'after-open' && args[0] === file) substitute();
      return handle;
    }); syncBuiltinESMExports();
    const before = fingerprint(file); const db = openQueryDatabase(a.databasePath);
    try {
      await assert.rejects(inspectSource(db, resolveSession(db, 'fixture-race-alias'), '00000001', () => {
        visits++; if (timing === 'during-read') substitute();
      }), {code:'SOURCE_CHANGED_DURING_READ'});
      if (timing === 'after-open') assert.equal(visits, 0);
      assert.deepEqual(fingerprint(join(moved, 'source.jsonl')), before);
    } finally { db.close(); mock.mock.restore(); syncBuiltinESMExports(); }
  }
});

function costs(uuid: string, rows: Array<[string, number, number, number, number, number, string]>, cwd = '/workspace/cost-window'): FixtureEntry[] {
  const entries: FixtureEntry[] = [{type:'session',version:3,id:uuid,timestamp:'2026-09-01T00:00:00.000Z',cwd}];
  rows.forEach(([timestamp, cost, input, output, cacheRead, cacheWrite, model], index) => {
    entries.push({type:'message', id:String(index + 1).padStart(8,'0'), parentId:index ? String(index).padStart(8,'0') : null, timestamp,
      message:{role:'assistant',content:[{type:'text',text:'synthetic cost observation'}], model, provider:'fixture-provider', stopReason:'stop',
        usage:{input,output,cacheRead,cacheWrite,cost:{total:cost}}}});
  }); return entries;
}

test('R4 applies one inclusive entry window across all usage metrics, groupings, counts, ranking and empty results', async (t) => {
  const a = await createArchive(t, {files:{
    'a.jsonl':costs('fixture-window-a', [
      ['2026-09-01T00:00:01.000Z', 100, 100, 100, 100, 100, 'fixture-old'],
      ['2026-09-05T00:00:00.000Z', 2, 2, 3, 4, 5, 'fixture-current'],
      ['2026-09-10T00:00:00.000Z', 3, 6, 7, 8, 9, 'fixture-current'],
    ]),
    'b.jsonl':costs('fixture-window-b', [
      ['2026-09-01T00:00:01.000Z', 200, 200, 200, 200, 200, 'fixture-old'],
      ['2026-09-06T00:00:00.000Z', 4, 10, 11, 12, 13, 'fixture-current'],
    ]),
    'cache.jsonl':costs('fixture-window-cache', [['2026-09-06T00:00:00.000Z', 0, 0, 0, 7, 9, 'fixture-cache-only']]),
    'write.jsonl':costs('fixture-window-write', [['2026-09-06T00:00:00.000Z', 0, 0, 0, 0, 17, 'fixture-write-only']]),
    'old.jsonl':costs('fixture-window-old', [['2026-09-02T00:00:00.000Z', 999, 999, 999, 999, 999, 'fixture-old-only']], '/workspace/old-only'),
    'header.jsonl':[{type:'session',version:3,id:'fixture-header-only',timestamp:'2026-09-20T00:00:00.000Z',cwd:'/workspace/header-only'}],
  }});
  const files = ['a.jsonl','b.jsonl','cache.jsonl','write.jsonl','old.jsonl','header.jsonl'].map((p) => join(a.sessionsDirectory,p));
  const before = files.map(fingerprint); const dbBefore = fingerprint(a.databasePath);
  const metrics = {cost:9,tokensIn:18,tokensOut:21,cacheRead:31,cacheWrite:53};
  for (const by of ['month', 'project', 'model', 'provider']) {
    for (const since of ['2026-09-05', '2026-09-05T02:00:00+02:00']) {
      const r = a.cli(['report','cost','--by',by,'--since',since,'--top','2','--json']);
      assert.equal(r.status,0);
      const report = JSON.parse(r.stdout).results[0] as CostReport;
      assert.equal(report.since,'2026-09-05T00:00:00.000Z');
      for (const [key, value] of Object.entries(metrics)) {
        const k = key as keyof typeof metrics;
        assert.equal(report.totals[k], value, by + ':' + key);
        assert.equal(report.groups.reduce((n,g) => n + g[k],0), value, by + ' group sum:' + key);
      }
      assert.equal(report.totals.cacheRate,31/49);
      assert.deepEqual(report.topSessions.map((s) => [s.sessionUuid,s.cost,s.tokensIn,s.tokensOut]), [
        ['fixture-window-a',5,8,10], ['fixture-window-b',4,10,11],
      ]);
      assert.equal(report.topSessions[0]!.lastActivity,'2026-09-10T00:00:00.000Z');
      for (const s of report.topSessions) assert.equal(s.citation,JSON.parse(a.cli(['cite',s.sessionUuid,'--json']).stdout).results[0].citation);
      if (by === 'project') { assert.equal(report.groups.length,1); assert.equal(report.groups[0]!.sessions,4); }
      if (by === 'model') {
        assert.ok(report.groups.some((g) => g.key === 'fixture-cache-only' && g.cacheRead === 7 && g.cacheWrite === 9));
        assert.ok(report.groups.some((g) => g.key === 'fixture-write-only' && g.cacheRead === 0 && g.cacheWrite === 17));
      }
    }
    const empty = JSON.parse(a.cli(['report','cost','--by',by,'--since','2030-01-01','--json']).stdout).results[0] as CostReport;
    assert.deepEqual(empty.groups,[]); assert.deepEqual(empty.topSessions,[]);
    assert.deepEqual(empty.totals,{cost:0,tokensIn:0,tokensOut:0,cacheRead:0,cacheWrite:0,cacheRate:0});
  }
  const all = JSON.parse(a.cli(['report','cost','--by','project','--json']).stdout).results[0] as CostReport;
  assert.equal(all.totals.cost,1308);
  assert.ok(all.groups.some((g) => g.key === '/workspace/header-only' && g.sessions === 1 && g.cost === 0), 'unbounded session inventory stays intact');
  assert.deepEqual(files.map(fingerprint), before); assert.deepEqual(fingerprint(a.databasePath), dbBefore);
});

test('R2 refuses a cyclic leaf and a leaf swapped immediately before open without visiting source records', async (t) => {
  for (const kind of ['cycle', 'open-race']) {
    const a = await createArchive(t, {files:{'source.jsonl':userSession('fixture-leaf', ['ordinary source'])}});
    const file = join(a.sessionsDirectory, 'source.jsonl'); const retained = join(a.root, 'retained.jsonl');
    const before = fingerprint(file);
    if (kind === 'cycle') { renameSync(file, retained); symlinkSync(file, file); }
    const originalOpen = fsp.open; let visits = 0;
    const mock = t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
      if (kind === 'open-race' && args[0] === file) { renameSync(file, retained); symlinkSync(retained, file); }
      return Reflect.apply(originalOpen, fsp, args);
    }); syncBuiltinESMExports();
    const db = openQueryDatabase(a.databasePath);
    try {
      await assert.rejects(inspectSource(db, resolveSession(db, 'fixture-leaf'), '00000001', () => { visits++; }), {code:'SOURCE_UNSAFE_PATH'});
      assert.equal(visits, 0); assert.deepEqual(fingerprint(retained), before);
    } finally { db.close(); mock.mock.restore(); syncBuiltinESMExports(); }
  }
});

test('R3 npm output overflow terminates the owned SIGTERM-ignoring child without a fallback or cache', (t) => {
  const a = createSandbox(t); const node = copyNode(a.root);
  const executable = copyRuntime(join(a.root, 'app', 'node_modules', 'session-atlas'));
  const pidFile = join(a.root, 'probe.pid');
  const script = "process.on('SIGTERM',()=>{}); process.stdout.write('x'.repeat(80*1024)); setTimeout(()=>{},4000);";
  const bin = npmProbe(a.root, `echo $$ > ${shellQuote(pidFile)}\nexec ${shellQuote(node)} -e ${shellQuote(script)}`);
  const start = performance.now();
  const result = runNode(node, [executable, 'index', '--json'], a.root, {...a.env, ATLAS_PI_PACKAGE:undefined, PATH:bin});
  assert.ok(performance.now()-start < 3500);
  assert.equal(result.status,2); assert.equal(JSON.parse(result.stdout).error.code,'PI_PARSER_UNAVAILABLE');
  assert.equal(existsSync(a.databasePath),false);
  const pid = Number(readFileSync(pidFile,'utf8').trim()); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid,0), {code:'ESRCH'});
});
