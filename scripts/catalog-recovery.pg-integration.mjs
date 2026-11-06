// Disposable PostgreSQL + real local workerd SQLite/R2. Never a cloud test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withTenantFixture} from '../src/modules/tenancy/pg-test-support.ts';
async function feature(){const m=await import('./catalog-recovery-harness.mjs').catch(()=>({}));assert.equal(typeof m.createLocalCatalogRecoveryHarness,'function','composed local recovery harness missing');return m.createLocalCatalogRecoveryHarness;}
async function scenario(fault,work){
  const create=await feature();await withTenantFixture(async f=>{
    // Independent observation of committed domain effects, not a simulated journal.
    await f.pool.query(`create table public.local_recovery_audit(touches int not null);insert into public.local_recovery_audit values(0);
      create function public.local_recovery_count() returns trigger language plpgsql as $$begin update public.local_recovery_audit set touches=touches+1;return NEW;end$$;
      create trigger local_recovery_count after update on public.restaurants for each row execute function public.local_recovery_count()`);
    await f.pool.query("select setval('public.catalog_publication_version_seq',9007199254740993,false)");
    const command={operationId:randomUUID(),restaurantId:f.restA,actor:f.ownerActor,mutation:{type:'restaurant.patch',input:{name:'Recovered catalog',cnpj:'synthetic-private'}}};
    const harness=await create({database:f.pool,command,fault});
    const counts=async()=>{const result=await f.pool.query(`select (select touches from public.local_recovery_audit) touches,
      (select count(*)::int from public.catalog_publication_operations where operation_id=$1) journal,
      (select version::text from public.catalog_publication_revisions where restaurant_id=$2) version`,[command.operationId,f.restA]);return result.rows[0];};
    try{await work({f,command,harness,counts});}finally{await harness.close();}
  });
}
for(const [fault,phase]of [['accepted','accepted'],['committed','accepted'],['projection','committed'],['signal','ready']])test('actual PostgreSQL/SQLite/R2 recover after '+fault+' without a duplicate mutation',{timeout:120000},async()=>scenario(fault,async({command,harness,counts})=>{
  const first=await harness.begin();assert.equal(first.status,fault==='signal'?200:202);
  const pending=await first.json();assert.equal(pending.receipt.phase,phase);assert.equal(pending.receipt.operationId,command.operationId);
  assert.notEqual(pending.work,'none');assert.notEqual(pending.alarm,null);assert.equal(pending.durableBeforeSql,true);
  const before=await counts();assert.equal(before.touches,fault==='accepted'?0:1);assert.equal(before.journal,fault==='accepted'?0:1);
  const status=await harness.status();assert.equal(status.status,200);assert.equal((await status.json()).receipt.phase,phase);assert.deepEqual(await counts(),before,'status must not apply or repair');
  await harness.evict();const recovered=await harness.alarm();assert.equal(recovered.receipt.phase,'ready');assert.equal(recovered.receipt.version,'9007199254740993');
  assert.equal(recovered.work,'none');assert(recovered.constructors>=2);assert.equal(recovered.privateChunks,0);
  assert.deepEqual(await counts(),{touches:1,journal:1,version:'9007199254740993'});
  const read=await harness.readCatalog();assert.equal(read.status,200);const catalog=await read.json();
  assert.equal(catalog.version,'9007199254740993');assert.equal(catalog.catalog.restaurant.id,command.restaurantId);assert.equal(catalog.catalog.restaurant.name,'Recovered catalog');
  assert.doesNotMatch(JSON.stringify(catalog),/synthetic-private|cnpj|sessionId|ownerId/);
  const prior=harness.statistics();for(let i=0;i<3;i++)await harness.alarm();assert.deepEqual(harness.statistics(),prior,'idle alarms must not touch PostgreSQL, including authorization');
  for(const response of await Promise.all([harness.retry(),harness.retry()]))assert.equal(response.status,200);
  assert.deepEqual(await counts(),{touches:1,journal:1,version:'9007199254740993'});
  const stats=harness.statistics();assert.equal(stats.domainApplyCalls,1);if(fault==='committed')assert.equal(stats.applyRequests,1,'ambiguous commit must be found before another apply');
}));

test('revoked session before pending application blocks without SQL mutation or R2 publication',{timeout:120000},async()=>scenario('accepted',async({f,harness,counts})=>{
  assert.equal((await harness.begin()).status,202);await f.pool.query('delete from better_auth.session where id=$1',[f.ownerActor.sessionId]);
  await harness.evict();const blocked=await harness.alarm();assert.equal(blocked.receipt.phase,'blocked');assert.equal(blocked.receipt.committed,false);
  assert.deepEqual(await counts(),{touches:0,journal:0,version:null});assert.equal((await harness.status()).status,401);assert.equal((await harness.retry()).status,401);
  assert.equal((await harness.readCatalog()).status,404);const before=harness.statistics();await harness.alarm();assert.deepEqual(harness.statistics(),before);
}));

test('revoked session after ambiguous COMMIT cannot prevent publication recovery or expose private result',{timeout:120000},async()=>scenario('committed',async({f,harness,counts})=>{
  assert.equal((await harness.begin()).status,202);assert.equal((await counts()).journal,1);
  await f.pool.query('delete from better_auth.session where id=$1',[f.ownerActor.sessionId]);await harness.evict();
  const recovered=await harness.alarm();assert.equal(recovered.receipt.phase,'ready');assert.equal(recovered.privateChunks,0);
  assert.equal((await harness.status()).status,401);assert.equal((await harness.retry()).status,401);
  const publicRead=await harness.readCatalog();assert.equal(publicRead.status,200);assert.doesNotMatch(await publicRead.text(),/synthetic-private|cnpj|sessionId|ownerId/);
  assert.deepEqual(await counts(),{touches:1,journal:1,version:'9007199254740993'});assert.equal(harness.statistics().domainApplyCalls,1);
}));
