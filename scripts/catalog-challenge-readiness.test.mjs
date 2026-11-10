import test from 'node:test';
import assert from 'node:assert/strict';

async function feature(){
  const m=await import('./catalog-challenge-readiness.mjs').catch(()=>({}));
  assert.equal(typeof m.runCatalogChallengeReadiness,'function','isolated challenge runner missing');
  return m.runCatalogChallengeReadiness;
}
async function client(url){
  const html=await(await fetch(url)).text(),nonce=html.match(/name="vapt-nonce" content="([a-f0-9]{64})"/)[1];
  return(path,body)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:url,'X-Vapt-Nonce':nonce,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
test('isolated runner receives one callback, emits no token and closes without any provider request',async t=>{
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=(url,...options)=>{assert.equal(new URL(url).hostname,'127.0.0.1');return originalFetch(url,...options);};
  const run=await feature(),events=[];let url,request;
  const result=await run({onEvent:async event=>{
    events.push(event);
    if(event.stage==='waiting_start'){url=event.url;request=await client(url);assert.equal((await request('/start',{})).status,200);}
    if(event.stage==='waiting_challenge')assert.equal((await request('/challenge',{index:0,token:'synthetic-readiness-private-value'})).status,204);
    if(event.stage==='callback_received'){
      assert.equal((await request('/challenge',{index:0,token:'synthetic-readiness-private-value'})).status,409);
      assert.equal((await(await request('/status')).json()).state,'finished');
    }
  }});
  assert.deepEqual(result,{ok:true,callbackReceived:true,serverVerified:false,loginRequests:0,credentialsCreated:0});
  assert.deepEqual(events.map(v=>v.stage),['waiting_start','waiting_challenge','callback_received']);
  assert.doesNotMatch(JSON.stringify({events,result}),/synthetic-readiness-private-value/);
  await assert.rejects(fetch(url));
});
for(const stage of ['waiting_start','waiting_challenge'])test('cancellation at '+stage+' closes the listener and reports no verification',async()=>{
  const run=await feature(),abort=new AbortController();let url,request;
  const result=await run({signal:abort.signal,onEvent:async event=>{
    if(event.stage==='waiting_start'){url=event.url;if(stage!=='waiting_start'){request=await client(url);await request('/start',{});}}
    if(event.stage===stage)abort.abort(Error('private diagnostic not for report'));
  }});
  assert.deepEqual(result,{ok:false,callbackReceived:false,serverVerified:false,loginRequests:0,credentialsCreated:0,failedStage:stage});
  assert.doesNotMatch(JSON.stringify(result),/private diagnostic/);await assert.rejects(fetch(url));
});
test('an already cancelled run does not expose or start a listener',async()=>{
  const run=await feature(),abort=new AbortController();abort.abort();let events=0;
  const result=await run({signal:abort.signal,onEvent:()=>{events++;}});
  assert.equal(result.ok,false);assert.equal(result.failedStage,'preflight');assert.equal(events,0);
});
test('cancellation combined with an asynchronous notification failure drains the failure and closes',async()=>{
  const run=await feature(),abort=new AbortController();let url;
  const result=await run({signal:abort.signal,onEvent:async event=>{
    url=event.url;abort.abort();throw Error('private-notification-failure');
  }});
  assert.equal(result.ok,false);assert.equal(result.failedStage,'waiting_start');
  assert.doesNotMatch(JSON.stringify(result),/private-notification-failure/);await assert.rejects(fetch(url));
});
