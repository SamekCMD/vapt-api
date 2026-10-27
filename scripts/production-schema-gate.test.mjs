import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const module=await import('./production-schema-gate.mjs').catch(error=>{
  if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;
  return {runProductionSchemaGate:undefined};
});
// This operator consumes the paired frontend repository's canonical migration tree.
const root=new URL('../../../infra/neon/',import.meta.url);
const names=['009_public_catalog_publication.sql','009_worker_production_catalog_grants.sql','010_tenant_foundation.sql','010_worker_production_tenant_grants.sql','011_organization_billing.sql','011_worker_production_billing_grants.sql','012_tenant_onboarding.sql','012_worker_production_onboarding_grants.sql'];
const files=await Promise.all(names.map(async name=>({name,bytes:await readFile(new URL(name,root))})));
const before={hash:'64ef36fbc2ce6cc263aa9596e9b67a2cf4136fdb16b850c428bc648800a7e096',tables:20,rows:0};
const after={hash:'b28390b5839143e11b99d9c82b427fc44f3b11aaadd237f8f8731cd0a32294fe',tables:30,rows:0};
const controls={httpClosed:true,queuePaused:true,cronRemoved:true,legacyDurableBusinessCommands:false};
function fixture() {
  const log=[];let snapshots=0,checks=0;
  return {log,ports:{files,
    journal:{claim:async()=>log.push('claim'),record:async phase=>log.push('journal:'+phase)},
    checkControls:async()=>{log.push('controls');checks++;return {...controls};},
    database:{query:async sql=>{log.push(sql==='COMMIT'||sql==='ROLLBACK'||sql.startsWith('BEGIN')?sql:sql.startsWith('LOCK TABLE')?'lock':sql.startsWith('SET LOCAL')?'settings':'migration');}},
    inspect:async()=>{log.push('inspect');snapshots++;return {...(snapshots===1?before:after),readAllStats:true,otherClients:0,preparedTransactions:0,unfinishedEffects:0};},
    verify:async()=>{log.push('verify');return {integrity:true,permissionMode:'effective_acl',roleLimited:true,allowedReadChecks:5,deniedChecks:9,invalidSessionDenied:true};},
  }};
}
async function run(f) {
  assert.equal(typeof module.runProductionSchemaGate,'function','production schema gate is missing');
  return module.runProductionSchemaGate(f.ports);
}
test('commits all eight reviewed SQL bodies once only after locked baseline, integrity, effective ACL and final admission checks',async()=>{
  const f=fixture(),r=await run(f);assert.equal(r.ok,true);assert.equal(r.committed,true);
  assert.equal(r.migrationsApplied,8);
  assert.equal(f.log.filter(x=>x==='migration').length,8);assert.equal(f.log.filter(x=>x==='COMMIT').length,1);
  assert(f.log.indexOf('claim')<f.log.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED'));
  assert(f.log.indexOf('lock')<f.log.indexOf('inspect'));
  assert(f.log.indexOf('verify')<f.log.lastIndexOf('controls'));
  assert(f.log.lastIndexOf('controls')<f.log.indexOf('journal:commit_attempt'));
  assert.equal(f.log.at(-1),'journal:commit_confirmed');
});
for(const [name,change] of [
  ['changed bytes',f=>{f.ports.files=files.map((x,i)=>i?x:{...x,bytes:Buffer.concat([x.bytes,Buffer.from(' ')])});}],
  ['missing grant',f=>{f.ports.files=files.slice(0,-1);}],
  ['preview substitute',f=>{f.ports.files=files.map((x,i)=>i!==1?x:{...x,name:'009_worker_preview_catalog_grants.sql'});}],
  ['wrong SQL order',f=>{f.ports.files=[files[1],files[0],...files.slice(2)];}],
])test('rejects '+name+' before journal claim or SQL',async()=>{
  const f=fixture();change(f);const r=await run(f);assert.equal(r.ok,false);assert.deepEqual(f.log,[]);
});
for(const key of ['httpClosed','queuePaused','cronRemoved'])test('refuses open '+key+' before beginning SQL',async()=>{
  const f=fixture();f.ports.checkControls=async()=>({...controls,[key]:false});
  const r=await run(f);assert.equal(r.ok,false);assert(!f.log.some(x=>x.startsWith('BEGIN')));
});
test('refuses accepted legacy durable business commands',async()=>{
  const f=fixture();f.ports.checkControls=async()=>({...controls,legacyDurableBusinessCommands:true});
  const r=await run(f);assert.equal(r.ok,false);assert(!f.log.includes('lock'));
});
test('existing one-shot marker prevents all remote work',async()=>{
  const f=fixture();f.ports.journal.claim=async()=>{throw Error('exists');};
  const r=await run(f);assert.equal(r.ok,false);assert.deepEqual(f.log,[]);
});
for(const [key,value] of [['hash','wrong'],['tables',19],['rows',1],['readAllStats',false],['otherClients',1],['preparedTransactions',1],['unfinishedEffects',1]])test('rolls back locked baseline '+key+' divergence without DDL',async()=>{
  const f=fixture();f.ports.inspect=async()=>({...before,readAllStats:true,otherClients:0,preparedTransactions:0,unfinishedEffects:0,[key]:value});
  const r=await run(f);assert.equal(r.ok,false);assert(f.log.includes('ROLLBACK'));assert(!f.log.includes('migration'));assert(!f.log.includes('COMMIT'));
});
test('lock timeout rolls back and never retries acquisition',async()=>{
  const f=fixture();let locks=0;
  const original=f.ports.database.query;f.ports.database.query=async sql=>{if(sql.startsWith('LOCK TABLE')){locks++;throw Error('timeout');}return original(sql);};
  const r=await run(f);assert.equal(r.ok,false);assert.equal(locks,1);assert(f.log.includes('ROLLBACK'));assert(!f.log.includes('migration'));
});
test('migration failure rolls back the whole transaction without replay',async()=>{
  const f=fixture(),original=f.ports.database.query;let ddl=0;
  f.ports.database.query=async sql=>{if(sql.includes('create sequence public.catalog_publication_version_seq')){ddl++;throw Error('DDL failed');}return original(sql);};
  const r=await run(f);assert.equal(r.ok,false);assert.equal(ddl,1);assert(f.log.includes('ROLLBACK'));assert(!f.log.includes('COMMIT'));
  assert.equal(r.migrationsApplied,0);
});
test('rolled-back eight statements are never reported as applied migrations',async()=>{
  const f=fixture();f.ports.verify=async()=>{throw Error('verification');};
  const r=await run(f);assert.equal(r.migrationsApplied,0);assert.equal(r.rolledBack,true);
});
for(const [key,value] of [['hash','wrong'],['tables',29],['rows',1]])test('postflight '+key+' divergence rolls back before commit',async()=>{
  const f=fixture();let n=0;f.ports.inspect=async()=>({...((++n===1)?before:{...after,[key]:value}),readAllStats:true,otherClients:0,preparedTransactions:0,unfinishedEffects:0});
  const r=await run(f);assert.equal(r.ok,false);assert(f.log.includes('ROLLBACK'));assert(!f.log.includes('COMMIT'));
});
test('effective ACL failure rolls back even with expected schema hash',async()=>{
  const f=fixture();f.ports.verify=async()=>({integrity:true,permissionMode:'effective_acl',roleLimited:true,allowedReadChecks:5,deniedChecks:8,invalidSessionDenied:true});
  const r=await run(f);assert.equal(r.ok,false);assert(f.log.includes('ROLLBACK'));assert(!f.log.includes('COMMIT'));
});
test('reopened admission during the transaction stops commit',async()=>{
  const f=fixture();let n=0;f.ports.checkControls=async()=>({...controls,httpClosed:++n===1});
  const r=await run(f);assert.equal(r.ok,false);assert(f.log.includes('ROLLBACK'));assert(!f.log.includes('COMMIT'));
});
test('uncertain COMMIT is never retried or described as successful rollback',async()=>{
  const f=fixture(),original=f.ports.database.query;let commits=0;
  f.ports.database.query=async sql=>{if(sql==='COMMIT'){commits++;throw Error('connection lost');}return original(sql);};
  const r=await run(f);assert.equal(r.ok,false);assert.equal(r.commitUncertain,true);assert.equal(commits,1);assert(!f.log.includes('ROLLBACK'));
});
test('receipt write failure after acknowledged COMMIT preserves confirmed database outcome',async()=>{
  const f=fixture(),original=f.ports.journal.record;
  f.ports.journal.record=async phase=>{if(phase==='commit_confirmed')throw Error('disk');return original(phase);};
  const r=await run(f);assert.equal(r.ok,false);assert.equal(r.committed,true);assert.equal(r.commitUncertain,false);assert(!f.log.includes('ROLLBACK'));
});
test('real durable journal refuses a second process and unrecognized phases',async()=>{
  assert.equal(typeof module.createProductionSchemaJournal,'function','schema journal is missing');
  const directory=await mkdtemp(join(tmpdir(),'vapt-schema-journal-'));
  const marker=join(directory,'attempt.json'),first=module.createProductionSchemaJournal(marker),second=module.createProductionSchemaJournal(marker);
  await assert.rejects(first.record('commit_attempt'));await first.claim();await assert.rejects(second.claim());
  await assert.rejects(first.record('../escape'));await first.record('commit_attempt');
  await assert.rejects(first.record('commit_attempt'));
  assert.equal(JSON.parse(await readFile(marker+'.commit_attempt.json','utf8')).phase,'commit_attempt');
});
