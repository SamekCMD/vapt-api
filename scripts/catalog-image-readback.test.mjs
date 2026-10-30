import test from 'node:test';
import assert from 'node:assert/strict';
const id='11111111-1111-4111-8111-111111111111',key=id+'/branding/22222222-2222-4222-8222-222222222222';
const feature=async()=>{const m=await import('./catalog-image-readback.mjs').catch(()=>({}));assert.equal(typeof m.verifyProductionCatalogImageAbsent,'function','exact image readback missing');return m.verifyProductionCatalogImageAbsent;};
function fixture(work){
  const calls=[],options={restaurantId:id,objectKey:key,accessToken:'synthetic-oauth-only-never-a-real-secret',fetcher:async(url,init)=>{
    calls.push({url,init});assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932/r2/buckets/vapt-assets-production/objects/11111111-1111-4111-8111-111111111111/branding/22222222-2222-4222-8222-222222222222');
    assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.ok(init.signal);
    assert.deepEqual(init.headers,{Authorization:'Bearer synthetic-oauth-only-never-a-real-secret'});return work(init.signal);
  }};return{calls,options};
}
const missing=()=>Response.json({success:false,errors:[{code:10007,message:'The specified key does not exist.'}],messages:[],result:null},{status:404});
test('literal path separators address the existing object instead of accepting an encoded-key 404 as absence',async()=>{
  const verify=await feature();let requests=0;
  const result=await verify({restaurantId:id,objectKey:key,accessToken:'synthetic-oauth-only-never-a-real-secret',fetcher:async url=>{
    requests++;
    if(url==='https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932/r2/buckets/vapt-assets-production/objects/11111111-1111-4111-8111-111111111111/branding/22222222-2222-4222-8222-222222222222')return new Response('existing bytes');
    if(url.includes('%2F'))return missing();
    throw Error('unexpected target');
  }});
  assert.equal(result.absent,false,'404 for the wrong encoded key must not certify physical deletion');assert.equal(requests,1);
});
test('only an authenticated exact-object 404 NoSuchKey confirms physical absence',async()=>{
  const verify=await feature(),f=fixture(missing);assert.deepEqual(await verify(f.options),{absent:true,bucket:'vapt-assets-production',objectKey:key});assert.equal(f.calls.length,1);
});
test('existing bytes are not consumed or reported absent even after lease retirement',async()=>{
  let cancelled=false;const verify=await feature(),f=fixture(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:200}));
  assert.deepEqual(await verify(f.options),{absent:false,bucket:'vapt-assets-production',objectKey:key});assert.equal(f.calls.length,1);assert.equal(cancelled,true);
});
for(const [status,code]of [[401,10002],[403,10003],[404,10006],[404,7003],[429,10001],[500,10001]])test(`readback ${status}/${code} is a stop, not evidence of deletion`,async()=>{
  const verify=await feature(),f=fixture(()=>Response.json({success:false,errors:[{code,message:'provider-secret-diagnostic'}]},{status}));
  await assert.rejects(()=>verify(f.options),e=>e.message==='Catalog image readback stopped'&&!e.message.includes('provider-secret'));assert.equal(f.calls.length,1);
});
test('foreign targets, traversal, item paths and invalid credentials are refused before transport',async()=>{
  const verify=await feature(),f=fixture(missing);
  for(const patch of [{restaurantId:'bad'},{objectKey:'33333333-3333-4333-8333-333333333333/branding/22222222-2222-4222-8222-222222222222'},
    {objectKey:key+'/../x'},{objectKey:key.replace('branding',id)},{accessToken:''},{accessToken:'secret\r\ninjected'}])await assert.rejects(()=>verify({...f.options,...patch}));
  assert.equal(f.calls.length,0);
});
test('unstructured and oversized 404 bodies cannot masquerade as NoSuchKey',async()=>{
  const verify=await feature();
  for(const body of ['Not found','x'.repeat(4097),JSON.stringify({success:true,errors:[{code:10007}]}),JSON.stringify({success:false,errors:[{code:10007},{code:10003}]})]){
    const f=fixture(()=>new Response(body,{status:404,headers:{'Content-Type':'application/json'}}));await assert.rejects(()=>verify(f.options));assert.equal(f.calls.length,1);
  }
});
for(const stage of ['fetch','body'])test(`readback cancellation bounds a stalled ${stage} without a second request`,async()=>{
  const verify=await feature();let entered,cancelled=false;
  const ready=new Promise(resolve=>{entered=resolve;}),abort=new AbortController();
  const f=fixture(()=>{if(stage==='fetch'){entered();return new Promise(()=>{});}return new Response(new ReadableStream({pull(){entered();return new Promise(()=>{});},cancel(){cancelled=true;}},{highWaterMark:0}),{status:404,headers:{'Content-Type':'application/json'}});});
  const pending=verify({...f.options,signal:abort.signal});await ready;abort.abort();await assert.rejects(pending,e=>e.message==='Catalog image readback stopped');
  assert.equal(f.calls.length,1);if(stage==='body')assert.equal(cancelled,true);
});
test('an unexpected provider response is cancelled even before a reader is acquired',async()=>{
  const verify=await feature();let cancelled=false;
  const f=fixture(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403}));
  await assert.rejects(()=>verify(f.options));assert.equal(cancelled,true);assert.equal(f.calls.length,1);
});
