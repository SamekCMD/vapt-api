import test from 'node:test';
import assert from 'node:assert/strict';
const id='11111111-1111-4111-8111-111111111111',op='22222222-2222-4222-8222-222222222222',tag='catalog-writer-33333333-3333-4333-8333-333333333333';
const feature=async()=>{const m=await import('./catalog-image-baseline-probe.mjs').catch(()=>({}));assert.equal(typeof m.runProductionCatalogImageBaseline,'function','single baseline missing');return m.runProductionCatalogImageBaseline;};
const ready={operationId:op,restaurantId:id,phase:'ready',version:'9007199254740993',committed:true,retryable:false};
function fixture(){
  const calls=[],fault={},events=[];
  const options={baseUrl:'https://api.vapt.app.br',restaurantId:id,tag,operationId:op,cookie:'__Secure-better-auth.session_token=synthetic-private-session-value',pace:async()=>{},waitPending:async()=>{events.push('wait');},preflight:async()=>{events.push('preflight');},fetcher:async(url,init)=>{
    calls.push({url,init});assert.ok(events.includes('preflight'));assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.ok(init.signal);assert.equal(init.headers.Cookie,options.cookie);
    const root='https://api.vapt.app.br/restaurants/'+id;
    if(url===root)return Response.json({id,name:tag,slug:tag,description:null,logoUrl:null,...fault.restaurant});
    if(url===root+'/menu-items')return Response.json(fault.items??[]);
    if(url===root+'/catalog/rebuild'){
      assert.equal(init.method,'POST');assert.equal(init.headers['Idempotency-Key'],op);assert.equal(init.headers['X-Vapt-Catalog-Protocol'],'1');assert.equal(init.body,'{}');
      if(fault.lostPost)throw Error('private-secret');return Response.json({receipt:fault.initial??ready},{status:fault.initial?202:200});
    }
    assert.equal(url,root+'/catalog-operations/'+op);assert.equal(init.method,'GET');return Response.json(fault.status??ready);
  }};return{options,calls,fault,events};
}
test('image baseline publishes once without CRUD and confirms its exact ready receipt',async()=>{
  const run=await feature(),f=fixture(),result=await run(f.options);
  assert.equal(result.ok,true);assert.equal(result.uncertain,false);assert.equal(result.requests,4);assert.equal(result.stage,'verified');assert.deepEqual(result.receipts,[ready]);
  assert.equal(f.calls.filter(v=>v.init.method==='POST').length,1);assert.doesNotMatch(JSON.stringify(result),/synthetic-private/);
});
test('pending baseline gets one delayed status check, never a retry or polling loop',async()=>{
  const run=await feature(),f=fixture();f.fault.initial={...ready,phase:'accepted',version:null,committed:false,retryable:false};
  assert.equal((await run(f.options)).ok,true);assert.deepEqual(f.events,['preflight','wait']);assert.equal(f.calls.length,4);
  const g=fixture();g.fault.initial=g.fault.status={...ready,phase:'committed',retryable:true};
  const result=await run(g.options);assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(g.calls.length,4);assert.equal(result.code,'baseline_stopped');
});
for(const kind of ['unmarked-scope','logo-reference','items','receipt-target','changed-version','lost-post'])test(`baseline ${kind} stops without a second write`,async()=>{
  const run=await feature(),f=fixture();
  if(kind==='unmarked-scope')f.fault.restaurant={name:'Other restaurant'};
  if(kind==='logo-reference')f.fault.restaurant={logoUrl:'https://image.invalid/photo'};
  if(kind==='items')f.fault.items=[{id:op,imageUrl:null}];
  if(kind==='receipt-target')f.fault.initial={...ready,restaurantId:op};
  if(kind==='changed-version')f.fault.status={...ready,version:'9007199254740994'};
  if(kind==='lost-post')f.fault.lostPost=true;
  const result=await run(f.options);assert.equal(result.ok,false);assert.ok(f.calls.filter(v=>v.init.method==='POST').length<=1);
  assert.equal(result.uncertain,['receipt-target','changed-version','lost-post'].includes(kind));assert.doesNotMatch(JSON.stringify(result),/private-secret/);
});
test('unscoped input and cancelled preflight never reach HTTP',async()=>{
  const run=await feature(),f=fixture();assert.equal((await run({...f.options,baseUrl:'https://other.invalid'})).ok,false);assert.equal(f.calls.length,0);
  const abort=new AbortController();f.options.preflight=()=>{abort.abort();return new Promise(()=>{});};
  const result=await run({...f.options,signal:abort.signal});assert.equal(result.ok,false);assert.equal(f.calls.length,0);
});
