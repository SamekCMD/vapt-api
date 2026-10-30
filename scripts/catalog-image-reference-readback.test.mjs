import assert from 'node:assert/strict';
import test from 'node:test';
const id='11111111-1111-4111-8111-111111111111',tag='catalog-writer-22222222-2222-4222-8222-222222222222';
const current='9007199254740995',previous='9007199254740994',prefix=`catalog/v1/production/restaurants/${id}/`;
const slug=`catalog/v1/production/slugs/${tag}.json`,manifest=prefix+'manifest.json';
const feature=async()=>{const m=await import('./catalog-image-reference-readback.mjs').catch(()=>({}));assert.equal(typeof m.readProductionCatalogImageReferences,'function','private retained readback missing');return m.readProductionCatalogImageReferences;};
function fixture(){
  const state=v=>({version:v,catalog:{restaurant:{id,name:tag,slug:tag,logoUrl:null},items:[]}});
  const objects=new Map([[slug,{restaurantId:id,version:current,canonicalSlug:tag,tombstone:false}],[manifest,{restaurantId:id,version:current,canonicalSlug:tag,previousVersion:previous}],[prefix+`snapshots/${current}.json`,state(current)],[prefix+`snapshots/${previous}.json`,state(previous)]]);
  const calls=[],fault={};const options={restaurantId:id,tag,version:current,previousVersion:previous,store:{async get(key,options){
    calls.push(key);assert(options.signal instanceof AbortSignal);assert.equal(options.maxBytes,key.includes('/snapshots/')?65536:4096);
    if(fault.read)return fault.read(key,objects.get(key),calls.length);
    return objects.has(key)?{body:JSON.stringify(objects.get(key)),etag:'"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'}:null;
  },async put(){assert.fail('readback must never write');}}};return{options,calls,objects,fault};
}
test('private readback validates exact slug/manifest, both snapshots and stable fences in six GETs',async()=>{
  const read=await feature(),f=fixture(),states=await read(f.options);
  assert.deepEqual(states.map(s=>s.version),[current,previous]);assert.deepEqual(f.calls,[slug,manifest,prefix+`snapshots/${current}.json`,prefix+`snapshots/${previous}.json`,manifest,slug]);
});
for(const patch of [{restaurantId:'foreign'},{tag:'Real restaurant'},{previousVersion:current},{version:'0'},{store:{}},{signal:AbortSignal.abort()}])test(`invalid readback scope ${Object.keys(patch)} stops before IO`,async()=>{
  const read=await feature(),f=fixture();await assert.rejects(()=>read({...f.options,...patch}));assert.deepEqual(f.calls,[]);
});
for(const fault of ['missing','tombstone','wrongPrevious','foreignSnapshot','wrongSnapshotVersion','oversized','changingManifest','changingSlug'])test(`private readback rejects ${fault} without repair or retry`,async()=>{
  const read=await feature(),f=fixture();
  if(fault==='missing')f.objects.delete(prefix+`snapshots/${previous}.json`);
  if(fault==='tombstone')f.objects.get(slug).tombstone=true;
  if(fault==='wrongPrevious')f.objects.get(manifest).previousVersion='1';
  if(fault==='foreignSnapshot')f.objects.get(prefix+`snapshots/${previous}.json`).catalog.restaurant.id='33333333-3333-4333-8333-333333333333';
  if(fault==='wrongSnapshotVersion')f.objects.get(prefix+`snapshots/${current}.json`).version=previous;
  if(fault==='oversized')f.fault.read=()=>({body:'x'.repeat(65537),etag:'opaque'});
  if(fault.startsWith('changing'))f.fault.read=(key,value,n)=>({body:JSON.stringify(value),etag:n===(fault==='changingManifest'?5:6)?'changed':'original'});
  await assert.rejects(()=>read(f.options),e=>e.message==='Catalog image reference readback stopped');assert(f.calls.length<=6);
});
test('abort bounds a stalled private object read and does not start another read',async()=>{
  const read=await feature(),f=fixture(),abort=new AbortController();let enter,release;
  const entered=new Promise(ok=>{enter=ok;}),held=new Promise(ok=>{release=ok;});
  f.fault.read=async()=>{enter();await held;return null;};const pending=read({...f.options,signal:abort.signal});await entered;abort.abort();let timer;
  try{await assert.rejects(()=>Promise.race([pending,new Promise(ok=>{timer=setTimeout(()=>ok('not cancelled'),100);})]));assert.equal(f.calls.length,1);}
  finally{clearTimeout(timer);release();await pending.catch(()=>{});}
});
