// Independent final-review probes. Explicit-run evidence, not default-suite acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createArchive, createSandbox, fingerprint, userSession } from '../../tests/prepublication-support.ts';
import { type FixtureEntry } from '../../tests/fixtures.ts';
import { copyNode, copyRuntime, npmProbe, runNode, shellQuote, PI_NAME } from '../../tests/package-support.ts';
import { indexSessions } from '../../src/indexer.ts';
import type { CostReport } from '../../src/queries/reports.ts';

test('review: failed cross-root attempt followed by partial original-root refresh clears only observed file uncertainty', async t => {
  const a = await createArchive(t, {files:{'a.jsonl':userSession('fixture-final-a',['kept A']), 'b.jsonl':userSession('fixture-final-b',['kept B'])}});
  const source = join(a.sessionsDirectory,'a.jsonl'); const before=fingerprint(source);
  const writer = new DatabaseSync(a.databasePath);
  writer.prepare('UPDATE cache_metadata SET last_attempt=NULL').run();writer.close();
  const other=join(a.root,'other');mkdirSync(other);writeFileSync(join(other,'bad.jsonl'),'{broken\n');
  const failed=await indexSessions({databasePath:a.databasePath,sessionsDirectory:other,rebuild:true,rebind:true},a.parser);
  assert.equal(failed.committed,false);assert.equal(failed.coverage!.unverifiedFiles.length,2);
  writeFileSync(join(a.sessionsDirectory,'b.jsonl'),'{broken\n');
  const partial=await indexSessions({databasePath:a.databasePath,sessionsDirectory:a.sessionsDirectory},a.parser);
  assert.equal(partial.committed,true);assert.equal(partial.coverage!.lastAttempt!.status,'partial');
  assert.equal(partial.filesChanged,1);assert.equal(partial.filesUnchanged,0);
  assert.deepEqual(partial.coverage!.unverifiedFiles.map(v=>v.file),[join(a.sessionsDirectory,'b.jsonl')]);
  assert.equal(a.cli(['cite','fixture-final-a','00000001','--verify-source','--json']).status,0);
  assert.equal(a.cli(['cite','fixture-final-b','00000001','--verify-source','--json']).status,2);
  assert.deepEqual(fingerprint(source),before);
});

test('review: a substituted alias to another location within the bound root is also refused', async t => {
  const a=await createArchive(t,{files:{'source.jsonl':userSession('fixture-final-alias',['synthetic text'])}});
  const old=join(a.sessionsDirectory,'source.jsonl'), moved=join(a.sessionsDirectory,'relocated.jsonl');
  renameSync(old,moved);symlinkSync(moved,old);const before=fingerprint(moved),cache=fingerprint(a.databasePath);
  for (const args of [['show','--context','0'],['cite','--verify-source']]) {
    const [command,...flags]=args;const r=a.cli([command!,'fixture-final-alias','00000001',...flags,'--json']);
    assert.equal(r.status,2);assert.equal(JSON.parse(r.stdout).error.code,'SOURCE_UNSAFE_PATH');
  }
  assert.deepEqual(fingerprint(moved),before);assert.deepEqual(fingerprint(a.databasePath),cache);
});

test('review: plausible npm stdout does not override timeout or import the advertised package', t => {
  const a=createSandbox(t),node=copyNode(a.root),exe=copyRuntime(join(a.root,'app','node_modules','session-atlas'));
  const npmRoot=join(a.root,'reported root'),pi=join(npmRoot,PI_NAME),marker=join(a.root,'imported.marker'),pidFile=join(a.root,'probe.pid');
  mkdirSync(join(pi,'dist'),{recursive:true});
  writeFileSync(join(pi,'package.json'),JSON.stringify({name:PI_NAME,version:'0.85.1',type:'module'}));
  writeFileSync(join(pi,'dist','index.js'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');export const CURRENT_SESSION_VERSION=3;export function parseSessionEntries(){return []};export function migrateSessionEntries(){}`);
  const bin=npmProbe(a.root,`echo $$ > ${shellQuote(pidFile)}\nprintf '%s\\n' ${shellQuote(npmRoot)}\ntrap '' TERM\nexec /bin/sleep 4`);
  const start=performance.now();const r=runNode(node,[exe,'index','--json'],a.root,{...a.env,PATH:bin,ATLAS_PI_PACKAGE:undefined});
  assert.ok(performance.now()-start<3500);assert.equal(r.status,2);assert.equal(JSON.parse(r.stdout).error.code,'PI_PARSER_UNAVAILABLE');
  assert.equal(existsSync(marker),false);assert.equal(existsSync(a.databasePath),false);
  const pid=Number(readFileSync(pidFile,'utf8').trim());assert.ok(Number.isSafeInteger(pid)&&pid>0);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

type Row={uuid:string,cwd:string,ts:string,model:string,provider:string,cost:number,tokensIn:number,tokensOut:number,cacheRead:number,cacheWrite:number};
const metrics=['cost','tokensIn','tokensOut','cacheRead','cacheWrite'] as const;
function usage(r:Row) {return {input:r.tokensIn,output:r.tokensOut,cacheRead:r.cacheRead,cacheWrite:r.cacheWrite,cost:{total:r.cost}};}
function entry(r:Row,n:number):FixtureEntry {
  return {type:'message',id:String(n).padStart(8,'0'),parentId:n===1?null:String(n-1).padStart(8,'0'),timestamp:r.ts,
    message:{role:'assistant',model:r.model,provider:r.provider,content:[{type:'text',text:'synthetic time oracle'}],usage:usage(r)}};
}

test('review: canonical-UTC dated reports agree with an independent entry-array oracle across months and grouping dimensions', async t => {
  const files:Record<string,FixtureEntry[]>={},rows:Row[]=[];
  for(let s=0;s<4;s++) {
    const uuid='fixture-oracle-'+s,cwd='/workspace/group-'+s%2;
    const entries:FixtureEntry[]=[{type:'session',id:uuid,version:3,timestamp:'2026-08-01T00:00:00.000Z',cwd}];
    for(let n=1;n<=12;n++) {
      const r:Row={uuid,cwd,ts:new Date(Date.UTC(2026,7+(n%3),1+s*2+n,12,0,n)).toISOString(),model:'fixture-model-'+n%2,provider:'fixture-provider-'+s%2,cost:(s+1)*n/8,tokensIn:n, tokensOut:n*2,cacheRead:n%3,cacheWrite:n%4};
      rows.push(r);entries.push(entry(r,n));
    }
    const r:Row={uuid,cwd,ts:'2026-09-15T00:00:00.000Z',model:'(unattributed)',provider:'(unattributed)',cost:0.5,tokensIn:2,tokensOut:3,cacheRead:4,cacheWrite:5};
    rows.push(r);entries.push({type:'branch_summary',id:'00000013',parentId:'00000012',timestamp:r.ts,summary:'synthetic summary',usage:usage(r)});
    files[s+'.jsonl']=entries;
  }
  const a=await createArchive(t,{files});const before=Object.keys(files).map(f=>fingerprint(join(a.sessionsDirectory,f))),cache=fingerprint(a.databasePath);
  for(const since of ['2026-08-01','2026-09-01','2026-09-15','2026-10-01','2026-11-01']) for(const by of ['month','project','model','provider'] as const) {
    const selected=rows.filter(r=>Date.parse(r.ts)>=Date.parse(since));
    const result=a.cli(['report','cost','--since',since,'--by',by,'--top','10','--json']);assert.equal(result.status,0);
    const report=JSON.parse(result.stdout).results[0] as CostReport;
    const key=(r:Row)=>by==='month'?r.ts.slice(0,7):by==='project'?r.cwd:r[by];
    const expectedKeys=[...new Set(selected.map(key))].sort();assert.deepEqual(report.groups.map(g=>g.key).sort(),expectedKeys);
    for(const k of metrics) assert.equal(report.totals[k],selected.reduce((n,r)=>n+r[k],0),by+':'+since+':'+k);
    for(const group of report.groups) {
      const groupRows=selected.filter(r=>key(r)===group.key);assert.equal(group.sessions,new Set(groupRows.map(r=>r.uuid)).size);
      for(const k of metrics) assert.equal(group[k],groupRows.reduce((n,r)=>n+r[k],0));
    }
    assert.equal(report.topSessions.length,new Set(selected.map(r=>r.uuid)).size);
    for(const session of report.topSessions) {
      const sr=selected.filter(r=>r.uuid===session.sessionUuid);
      for(const k of ['cost','tokensIn','tokensOut'] as const) assert.equal(session[k],sr.reduce((n,r)=>n+r[k],0));
    }
    assert.deepEqual(report.topSessions.map(s=>s.cost),report.topSessions.map(s=>s.cost).sort((x,y)=>y-x));
  }
  assert.deepEqual(Object.keys(files).map(f=>fingerprint(join(a.sessionsDirectory,f))),before);assert.deepEqual(fingerprint(a.databasePath),cache);
});

for(const variant of ['offset','fraction-width'] as const) test(`review: accepted ISO source times use absolute chronological bounds (${variant})`,async t=>{
  const times=variant==='offset'?['2026-09-05T01:30:00+02:00','2026-09-04T23:00:00-02:00']:['2026-09-05T00:00:00Z','2026-09-05T00:00:01Z'];
  const since=variant==='offset'?'2026-09-05':'2026-09-05T00:00:00.500Z';
  const rows=times.map((ts,i):Row=>({uuid:'fixture-iso-'+variant,cwd:'/workspace/iso',ts,model:'fixture-model',provider:'fixture-provider',cost:i?1:10,tokensIn:1,tokensOut:1,cacheRead:0,cacheWrite:0}));
  const entries:FixtureEntry[]=[{type:'session',id:rows[0]!.uuid,version:3,timestamp:'2026-09-01T00:00:00.000Z',cwd:'/workspace/iso'},...rows.map((r,i)=>entry(r,i+1))];
  const a=await createArchive(t,{files:{'source.jsonl':entries}}),source=fingerprint(join(a.sessionsDirectory,'source.jsonl')),cache=fingerprint(a.databasePath);
  const r=a.cli(['report','cost','--since',since,'--by','month','--json']);assert.equal(r.status,0);
  const envelope=JSON.parse(r.stdout);const report=envelope.results[0] as CostReport;
  assert.equal(envelope.cache.lastAttempt.status,'success');assert.equal(envelope.cache.lastAttempt.parseWarnings,0);
  assert.deepEqual(envelope.cache.unverifiedFiles,[]);
  const expected=rows.filter(r=>Date.parse(r.ts)>=Date.parse(since)).reduce((n,r)=>n+r.cost,0);
  const search=a.cli(['search','synthetic time oracle','--exact','--since',since,'--json']);assert.equal(search.status,0);
  const canonicalEntries=entries.map(e=>({...e,timestamp:new Date(String(e.timestamp)).toISOString()}));
  const control=await createArchive(t,{files:{'source.jsonl':canonicalEntries}});
  const canonical=control.cli(['report','cost','--since',since,'--by','month','--json']);assert.equal(canonical.status,0);
  assert.equal(JSON.parse(canonical.stdout).results[0].totals.cost,expected,'same instants in canonical UTC must be the passing control');
  const canonicalSearch=control.cli(['search','synthetic time oracle','--exact','--since',since,'--json']);assert.equal(canonicalSearch.status,0);
  assert.deepEqual(JSON.parse(canonicalSearch.stdout).results.map((e:{entryId:string})=>e.entryId),['00000002']);
  console.log(JSON.stringify({variant,since,expectedCost:expected,actualCost:report.totals.cost,canonicalCost:JSON.parse(canonical.stdout).results[0].totals.cost,searchEntryIds:JSON.parse(search.stdout).results.map((e:{entryId:string})=>e.entryId),parseWarnings:envelope.cache.lastAttempt.parseWarnings}));
  assert.deepEqual(fingerprint(join(a.sessionsDirectory,'source.jsonl')),source);assert.deepEqual(fingerprint(a.databasePath),cache);
  assert.equal(report.totals.cost,expected,'accepted ISO source timestamps should not be compared as unnormalized strings');
});
