import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { createArchive, createSandbox, fingerprint, userSession } from '../../tests/prepublication-support.ts';
import { copyNode, copyRuntime, npmProbe, runNode } from '../../tests/package-support.ts';

// Independent review probes, intentionally outside the default suite until
// findings are adjudicated. No TODO/skip; each expectation actually executes.
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
  const bin = npmProbe(a.root, "trap '' TERM\nexec /bin/sleep 4");
  const start = performance.now();
  const result = runNode(node, [executable, 'index', '--json'], a.root, { ...a.env, ATLAS_PI_PACKAGE:undefined, PATH:bin });
  const elapsedMs = performance.now() - start;
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error.code, 'PI_PARSER_UNAVAILABLE');
  assert.equal(existsSync(a.databasePath), false);
  console.log(JSON.stringify({scenario:'npm-timeout', elapsedMs}));
  assert.ok(elapsedMs < 3500, 'documented two-second npm probe needs bounded termination, not only SIGTERM');
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
