import test from 'node:test';
import assert from 'node:assert/strict';
const feature=async()=>{const m=await import('./catalog-r2-conditional-probe.mjs').catch(()=>({}));assert.equal(typeof m.checkCatalogR2ConditionalPut,'function');return m.checkCatalogR2ConditionalPut;};
const key='catalog/v1/preview/restaurants/8572dc6c-84b2-4b12-8099-934204cc21eb/snapshots/1.json';
const base='https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932/r2/buckets/vapt-catalog-preview';
function fixture(status=412){
  let journaled=false;const calls=[],body='{"retired":true,"version":"1"}';
  const options={token:'synthetic-provider-token-never-output',onAttempt:async()=>{journaled=true;},fetcher:async(url,init)=>{
    calls.push([url,init.method??'GET']);assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.ok(init.signal);
    assert.equal(init.headers.Authorization,'Bearer synthetic-provider-token-never-output');
    if(url===base+'/domains/managed')return Response.json({success:true,result:{enabled:false}});
    if(url===base+'/domains/custom')return Response.json({success:true,result:{domains:[]}});
    assert.equal(url,base+'/objects/'+key);
    if(init.method==='PUT'){
      assert.equal(journaled,true,'no provider write before durable attempt journal');assert.equal(init.body,body);
      assert.equal(init.headers['If-Match'],'"00000000000000000000000000000000"');return new Response('{}',{status});
    }
    return new Response(body,{headers:{ETag:'"11111111111111111111111111111111"'}});
  }};
  return{options,calls};
}
test('known retired preview fence is tested with impossible If-Match and identical bytes; 412 proves rejection',async()=>{
  const probe=await feature(),f=fixture();const result=await probe(f.options);
  assert.deepEqual(result,{supported:true,putStatus:412,bodyUnchanged:true,requests:5,acceptedPut:false});
  assert.equal(f.calls.filter(c=>c[1]==='PUT').length,1);assert.doesNotMatch(JSON.stringify(result),/synthetic-provider|Bearer/);
});
test('accepted no-op PUT is reported unsupported, never as conditional-write protection',async()=>{
  const probe=await feature(),f=fixture(200);assert.deepEqual(await probe(f.options),{supported:false,putStatus:200,bodyUnchanged:true,requests:5,acceptedPut:true});
});
test('foreign or unretired object stops before attempt journal or PUT',async()=>{
  const probe=await feature(),f=fixture();let journaled=false;f.options.onAttempt=async()=>{journaled=true;};
  const fetcher=f.options.fetcher;f.options.fetcher=(url,init)=>url.includes('/objects/')?Promise.resolve(new Response('{"version":"1","catalog":{"private":"unexpected"}}',{headers:{ETag:'"11111111111111111111111111111111"'}})):fetcher(url,init);
  await assert.rejects(()=>probe(f.options));assert.equal(journaled,false);assert.equal(f.calls.some(c=>c[1]==='PUT'),false);
});
test('lost PUT response is not retried and returns no raw provider exception',async()=>{
  const probe=await feature(),f=fixture();let puts=0;const fetcher=f.options.fetcher;
  f.options.fetcher=(url,init)=>{if(init.method==='PUT'){puts++;throw Error('credential-secret-provider-diagnostic');}return fetcher(url,init);};
  await assert.rejects(()=>probe(f.options),e=>e.safeCode==='catalog_conditional_probe_uncertain'&&!e.message.includes('credential-secret'));
  assert.equal(puts,1);
});
