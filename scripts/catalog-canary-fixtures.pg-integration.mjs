// Genuine local PostgreSQL; only the external TLS/owner identity boundary is substituted.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {withLocalDatabase} from '../src/modules/tenancy/pg-test-support.ts';
import {buildPublicCatalog} from '../src/modules/catalog/repository.ts';
import {createTenantFixtureDriver} from './tenant-preview-fixtures.mjs';
const feature=()=>import('./catalog-canary-fixtures.mjs').catch(()=>({}));
async function scenario(work){await withLocalDatabase(async pool=>{
  const adapter={options:{host:'ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech',database:'vapt',user:'neondb_owner',ssl:{rejectUnauthorized:true},max:1},
    query:async(sql,p)=>sql.includes('current_database()')?{rows:[{database:'vapt',role:'neondb_owner'}]}:pool.query(sql,p),connect:()=>pool.connect(),async end(){}};
  const driver=await createTenantFixtureDriver({ownerUrl:'postgresql://neondb_owner:synthetic-only@ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full',
    tag:'tenant-smoke-'+randomUUID(),createPool:()=>adapter,hash:async()=> 'test-hash-not-a-login'});
  try{await driver.seed();await work({pool,adapter,driver,manifest:driver.identifiers(),operationId:randomUUID()});}finally{await driver.close();}
});}
async function commitJournal(f,prepared){
  const state={version:prepared.version,catalog:await buildPublicCatalog(f.pool,prepared.restaurantId)};
  const allocated=(await f.pool.query("select nextval('public.catalog_publication_version_seq')::text version")).rows[0].version;assert.equal(allocated,prepared.version);
  await f.pool.query('insert into public.catalog_publication_revisions(restaurant_id,version) values($1,$2)',[prepared.restaurantId,prepared.version]);
  await f.pool.query(`insert into public.catalog_publication_operations(operation_id,actor_id,restaurant_id,fingerprint,version,snapshot,result,previous_slug)
    values($1,$2,$3,$4,$5,$6::jsonb,'{}'::jsonb,$7)`,[prepared.operationId,prepared.actorId,prepared.restaurantId,'f'.repeat(64),prepared.version,JSON.stringify(state),prepared.slug]);
  return {operationId:prepared.operationId,restaurantId:prepared.restaurantId,version:prepared.version,phase:'ready',committed:true,retryable:false};
}
function retired(p){return{restaurantId:p.restaurantId,version:p.version,readbackConfirmed:true,retainedFenceBytes:400,keys:[`catalog/v1/preview/slugs/${p.slug}.json`,`catalog/v1/preview/restaurants/${p.restaurantId}/manifest.json`,`catalog/v1/preview/restaurants/${p.restaurantId}/snapshots/${p.version}.json`]};}
test('prepare generates exactly8MiB using the real catalog DTO and rejects a second preparation',async()=>scenario(async f=>{
  const {prepareCatalogCanaryBoundary}=await feature();assert.equal(typeof prepareCatalogCanaryBoundary,'function');
  const p=await prepareCatalogCanaryBoundary({...f,buildCatalog:buildPublicCatalog,pool:f.adapter});
  const state={version:p.version,catalog:await buildPublicCatalog(f.pool,p.restaurantId)};
  assert.equal(Buffer.byteLength(JSON.stringify(state)),8388608);assert.equal(p.bytes,8388608);
  await assert.rejects(()=>prepareCatalogCanaryBoundary({...f,buildCatalog:buildPublicCatalog,pool:f.adapter}));
  assert.deepEqual(await f.driver.cleanup(),{rows:0});
}));
test('terminal journal cleanup then existing strict tenant cleanup removes only owned rows',async()=>scenario(async f=>{
  const {prepareCatalogCanaryBoundary,cleanupCatalogCanaryJournal}=await feature();assert.equal(typeof cleanupCatalogCanaryJournal,'function');
  const p=await prepareCatalogCanaryBoundary({...f,buildCatalog:buildPublicCatalog,pool:f.adapter});const receipt=await commitJournal(f,p);
  await assert.rejects(()=>f.driver.cleanup(),'old guard must still reject the catalog journal');
  assert.deepEqual(await cleanupCatalogCanaryJournal({pool:f.adapter,manifest:f.manifest,prepared:p,receipt,admissionClosed:true,retired:retired(p)}),{journalRows:0});
  assert.deepEqual(await f.driver.cleanup(),{rows:0});
  assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_revisions')).rows[0].n,0);
}));
for(const [name,change]of [['pending',p=>({phase:'committed'})],['wrong revision',p=>({version:(BigInt(p.version)+1n).toString()})],['retryable',p=>({retryable:true})]])
test(`SQL cleanup rejects ${name} and retains the journal`,async()=>scenario(async f=>{
  const {prepareCatalogCanaryBoundary,cleanupCatalogCanaryJournal}=await feature();assert.equal(typeof cleanupCatalogCanaryJournal,'function');
  const p=await prepareCatalogCanaryBoundary({...f,buildCatalog:buildPublicCatalog,pool:f.adapter});const receipt=await commitJournal(f,p);
  await assert.rejects(()=>cleanupCatalogCanaryJournal({pool:f.adapter,manifest:f.manifest,prepared:p,receipt:{...receipt,...change(p)},admissionClosed:true,retired:retired(p)}));
  assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations')).rows[0].n,1);
}));
test('unexpected second journal aborts before deleting the known command',async()=>scenario(async f=>{
  const {prepareCatalogCanaryBoundary,cleanupCatalogCanaryJournal}=await feature();assert.equal(typeof cleanupCatalogCanaryJournal,'function');
  const p=await prepareCatalogCanaryBoundary({...f,buildCatalog:buildPublicCatalog,pool:f.adapter});const receipt=await commitJournal(f,p);
  await f.pool.query(`insert into public.catalog_publication_operations(operation_id,actor_id,restaurant_id,fingerprint,version,snapshot,result,previous_slug)
    select $1,actor_id,restaurant_id,fingerprint,version,snapshot,result,previous_slug from public.catalog_publication_operations where operation_id=$2`,[randomUUID(),p.operationId]);
  await assert.rejects(()=>cleanupCatalogCanaryJournal({pool:f.adapter,manifest:f.manifest,prepared:p,receipt,admissionClosed:true,retired:retired(p)}));
  assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations')).rows[0].n,2);
}));
test('unconfirmed artifact retirement or open admission never deletes a committed journal',async()=>scenario(async f=>{
  const {prepareCatalogCanaryBoundary,cleanupCatalogCanaryJournal}=await feature();
  const p=await prepareCatalogCanaryBoundary({...f,buildCatalog:buildPublicCatalog,pool:f.adapter});const receipt=await commitJournal(f,p);
  for(const proof of [{admissionClosed:false,retired:retired(p)},{admissionClosed:true,retired:{...retired(p),readbackConfirmed:false}},
    {admissionClosed:true,retired:{...retired(p),keys:['catalog/v1/production/unrelated']}}]){
    await assert.rejects(()=>cleanupCatalogCanaryJournal({pool:f.adapter,manifest:f.manifest,prepared:p,receipt,...proof}));
    assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations')).rows[0].n,1);
  }
}));
test('lost cleanup COMMIT response is classified uncertain and never deletes tenant identities automatically',async()=>scenario(async f=>{
  const {prepareCatalogCanaryBoundary,cleanupCatalogCanaryJournal}=await feature();
  const p=await prepareCatalogCanaryBoundary({...f,buildCatalog:buildPublicCatalog,pool:f.adapter});const receipt=await commitJournal(f,p);let commits=0;
  const adapter={...f.adapter,async connect(){const client=await f.pool.connect();return{release:()=>client.release(),async query(sql,params){
    const result=await client.query(sql,params);if(sql==='COMMIT'){commits++;throw Error('Synthetic lost commit response');}return result;
  }};}};
  await assert.rejects(()=>cleanupCatalogCanaryJournal({pool:adapter,manifest:f.manifest,prepared:p,receipt,admissionClosed:true,retired:retired(p)}),e=>e.safeCode==='catalog_cleanup_uncertain');
  assert.equal(commits,1);assert.equal((await f.pool.query('select count(*)::int n from public.restaurants')).rows[0].n,3);
  assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations')).rows[0].n,0,'unknown outcome must be inspected, not retried');
}));
