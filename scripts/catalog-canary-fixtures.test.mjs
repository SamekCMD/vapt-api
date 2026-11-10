import assert from 'node:assert/strict';
import test from 'node:test';
const feature=()=>import('./catalog-canary-fixtures.mjs').catch(()=>({}));
const prepared={restaurantId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',operationId:'33333333-3333-4333-8333-333333333333',version:'17',
  tag:'tenant-smoke-44444444-4444-4444-8444-444444444444',slug:'tenant-smoke-44444444-4444-4444-8444-444444444444-0',bytes:8388608,descriptionBytes:8388355};
const receipt={operationId:prepared.operationId,restaurantId:prepared.restaurantId,version:'17',phase:'ready',committed:true,retryable:false};
function fixture(){
  const prefix=`catalog/v1/preview/restaurants/${prepared.restaurantId}/`;
  const keys={slug:`catalog/v1/preview/slugs/${prepared.slug}.json`,manifest:prefix+'manifest.json',snapshot:prefix+'snapshots/17.json'};
  const snapshot={version:'17',catalog:{restaurant:{id:prepared.restaurantId,name:prepared.tag,slug:prepared.slug,description:''},items:[]}};
  snapshot.catalog.restaurant.description='a'.repeat(8388608-Buffer.byteLength(JSON.stringify(snapshot)));
  const p={...prepared,descriptionBytes:snapshot.catalog.restaurant.description.length};
  const objects=new Map([[keys.slug,JSON.stringify({restaurantId:p.restaurantId,version:'17',canonicalSlug:p.slug,tombstone:false})],
    [keys.manifest,JSON.stringify({restaurantId:p.restaurantId,version:'17',canonicalSlug:p.slug,previousVersion:null})],[keys.snapshot,JSON.stringify(snapshot)]]);
  const writes=[];const store={async get(key){return objects.get(key)??null;},async put(key,body){writes.push(key);objects.set(key,body);}};
  return {prepared:p,keys,objects,writes,store};
}
test('ready closed canary retires exactly its three objects and preserves create-once fences',async()=>{
  const {retireCatalogCanaryArtifacts}=await feature();assert.equal(typeof retireCatalogCanaryArtifacts,'function');
  const f=fixture();const result=await retireCatalogCanaryArtifacts({prepared:f.prepared,receipt,admissionClosed:true,store:f.store});
  assert.equal(result.readbackConfirmed,true);assert.deepEqual(result.keys,[f.keys.slug,f.keys.manifest,f.keys.snapshot]);
  assert.equal(JSON.parse(f.objects.get(f.keys.slug)).tombstone,true);
  assert.equal(JSON.parse(f.objects.get(f.keys.snapshot)).retired,true);assert.equal(f.objects.size,3);
  assert.ok(result.retainedFenceBytes<1024);assert.equal(f.writes.length,3);
});
for(const [name,patch] of [['pending',{phase:'committed'}],['foreign actor operation',{operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}],['retryable ready',{retryable:true}],['different revision',{version:'18'}]])
test(`retirement rejects ${name} before any object write`,async()=>{
  const {retireCatalogCanaryArtifacts}=await feature();assert.equal(typeof retireCatalogCanaryArtifacts,'function');const f=fixture();
  await assert.rejects(()=>retireCatalogCanaryArtifacts({prepared:f.prepared,receipt:{...receipt,...patch},admissionClosed:true,store:f.store}));assert.equal(f.writes.length,0);
});
test('retirement refuses still-open admission',async()=>{
  const {retireCatalogCanaryArtifacts}=await feature();assert.equal(typeof retireCatalogCanaryArtifacts,'function');const f=fixture();
  await assert.rejects(()=>retireCatalogCanaryArtifacts({prepared:f.prepared,receipt,admissionClosed:false,store:f.store}));assert.equal(f.writes.length,0);
});
test('foreign or unexpected retained snapshot is not overwritten',async()=>{
  const {retireCatalogCanaryArtifacts}=await feature();assert.equal(typeof retireCatalogCanaryArtifacts,'function');const f=fixture();
  const value=JSON.parse(f.objects.get(f.keys.manifest));value.previousVersion='16';f.objects.set(f.keys.manifest,JSON.stringify(value));
  await assert.rejects(()=>retireCatalogCanaryArtifacts({prepared:f.prepared,receipt,admissionClosed:true,store:f.store}));assert.equal(f.writes.length,0);
});
test('lost fence write is not retried or reported as cleanup',async()=>{
  const {retireCatalogCanaryArtifacts}=await feature();assert.equal(typeof retireCatalogCanaryArtifacts,'function');const f=fixture();let attempts=0;
  f.store.put=async()=>{attempts++;throw Error('Synthetic failure');};
  await assert.rejects(()=>retireCatalogCanaryArtifacts({prepared:f.prepared,receipt,admissionClosed:true,store:f.store}));assert.equal(attempts,1);
});
test('wrong fence readback fails instead of deleting SQL under a false proof',async()=>{
  const {retireCatalogCanaryArtifacts}=await feature();assert.equal(typeof retireCatalogCanaryArtifacts,'function');const f=fixture();
  f.store.put=async key=>{f.writes.push(key);};
  await assert.rejects(()=>retireCatalogCanaryArtifacts({prepared:f.prepared,receipt,admissionClosed:true,store:f.store}));
  assert.equal(f.writes.length,1,'stop before retiring other objects when the first write did not read back');
});
