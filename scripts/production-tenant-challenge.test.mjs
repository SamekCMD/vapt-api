import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

async function setup(t,factory='createProductionTenantChallenge'){
  const m=await import('./production-tenant-challenge.mjs').catch(()=>({}));
  assert.equal(typeof m[factory],'function','loopback challenge collector missing');
  const c=await m[factory]();t.after(()=>c.close());
  const html=await(await fetch(c.url)).text(),nonce=html.match(/name="vapt-nonce" content="([a-f0-9]{64})"/)?.[1];
  assert.ok(nonce);
  const request=(path,body,extra={})=>fetch(c.url+path,{method:body===undefined?'GET':'POST',headers:{Origin:c.url,'X-Vapt-Nonce':nonce,...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{c,html,request};
}
test('loopback start is explicit and once-only; five challenges reach only the pending callback, never status',async t=>{
  const {c,request,html}=await setup(t);let started=false;c.waitForStart().then(()=>{started=true;});
  assert.equal(new URL(c.url).hostname,'127.0.0.1');assert.equal(started,false);
  assert.equal((await request('/status')).status,200);assert.equal(started,false);
  assert.equal((await request('/start',{})).status,200);await c.waitForStart();assert.equal(started,true);
  assert.equal((await request('/start',{})).status,409);
  for(const [index,role]of ['owner','admin','manager','staff','owner'].entries()){
    const token=`synthetic-challenge-value-${index}`,pending=c.captcha({index,role});
    assert.deepEqual((await(await request('/status')).json()).pending,{index,role});
    assert.equal((await request('/challenge',{index,token})).status,204);assert.equal(await pending,token);
    assert.equal((await request('/challenge',{index,token})).status,409);
    assert.doesNotMatch(JSON.stringify(await(await request('/status')).json()),/synthetic-challenge/);
  }
  c.complete({ok:true,cleaned:true,checks:73,privateValue:'not-for-page'});
  const status=await(await request('/status')).json();assert.deepEqual(status,{state:'finished',step:'verified',pending:null,outcome:{ok:true,cleaned:true,checks:73}});
  assert.doesNotMatch(html,/password|session_token|DATABASE_URL/);
});
test('cross-origin, missing nonce and rebound Host cannot start the collector',async t=>{
  const {c,request}=await setup(t);
  assert.equal((await request('/start',{}, {Origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await request('/start',{}, {'X-Vapt-Nonce':''})).status,403);
  assert.equal((await fetch(c.url+'/status')).status,403);
  const status=await new Promise((resolve,reject)=>{const req=http.get(c.url+'/',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(status,403);assert.equal((await(await request('/status')).json()).state,'waiting');
});
test('malformed, oversized, dummy, wrong-index and stale challenges never consume the pending request',async t=>{
  const {c,request}=await setup(t);await assert.rejects(c.captcha({index:0,role:'owner'}));
  await request('/start',{});await assert.rejects(c.captcha({index:1,role:'admin'}));
  const pending=c.captcha({index:0,role:'owner'});
  for(const body of [{index:1,token:'synthetic-challenge-value-1'},{index:0,token:'short'},{index:0,token:'XXXX.DUMMY.TOKEN.XXXX'},{index:0,token:'x'.repeat(13000)},{index:0,token:'x'.repeat(25),extra:true}])assert.equal((await request('/challenge',body)).status,400);
  assert.deepEqual((await(await request('/status')).json()).pending,{index:0,role:'owner'});
  assert.equal((await request('/challenge',{index:0,token:'synthetic-challenge-value-0'})).status,204);await pending;
});
test('abort and close settle pending human waits and stop the loopback listener',async t=>{
  const {c,request}=await setup(t);await request('/start',{});const controller=new AbortController();
  const pending=c.captcha({index:0,role:'owner',signal:controller.signal});controller.abort();await assert.rejects(pending,/cancelled/);
  assert.equal((await(await request('/status')).json()).pending,null);
  await c.close();await assert.rejects(fetch(c.url));
});

test('catalog collector asks for one owner login and refuses a second challenge',async t=>{
  const {c,request,html}=await setup(t,'createProductionCatalogChallenge');
  assert.match(html,/<h1>Validação do writer de catálogo<\/h1>/);
  assert.match(html,/um login sintético/);assert.doesNotMatch(html,/cinco logins|de 5/);
  await assert.rejects(c.captcha({index:0,role:'owner'}));
  assert.equal((await request('/start',{})).status,200);await c.waitForStart();
  await assert.rejects(c.captcha({index:0,role:'admin'}));
  const challenge=c.captcha({index:0,role:'owner'}),token='synthetic-catalog-challenge-value';
  assert.deepEqual((await(await request('/status')).json()).pending,{index:0,role:'owner'});
  assert.equal((await request('/challenge',{index:0,token})).status,204);assert.equal(await challenge,token);
  await assert.rejects(c.captcha({index:1,role:'owner'}));
  assert.equal((await request('/challenge',{index:0,token})).status,409);
  c.complete({ok:true,cleaned:true,checks:41});
  assert.deepEqual(await(await request('/status')).json(),{state:'finished',step:'verified',pending:null,outcome:{ok:true,cleaned:true,checks:41}});
  assert.doesNotMatch(JSON.stringify(await(await request('/status')).json()),/synthetic-catalog-challenge/);
});

test('catalog collector preserves start origin nonce and Host guards',async t=>{
  const {c,request}=await setup(t,'createProductionCatalogChallenge');
  assert.equal((await request('/start',{}, {Origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await request('/start',{}, {'X-Vapt-Nonce':''})).status,403);
  assert.equal((await fetch(c.url+'/status')).status,403);
  const status=await new Promise((resolve,reject)=>{const req=http.get(c.url+'/',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(status,403);assert.equal((await(await request('/status')).json()).state,'waiting');
});

test('catalog collector rejects dummy and oversized responses and closes an outstanding human wait',async t=>{
  const {c,request}=await setup(t,'createProductionCatalogChallenge');await request('/start',{});
  const pending=c.captcha({index:0,role:'owner'});const rejected=assert.rejects(pending,/cancelled/);
  for(const body of [{index:0,token:'XXXX.DUMMY.TOKEN.XXXX'},{index:0,token:'x'.repeat(13000)},{index:1,token:'synthetic-catalog-challenge-value'}])assert.equal((await request('/challenge',body)).status,400);
  assert.deepEqual((await(await request('/status')).json()).pending,{index:0,role:'owner'});
  await c.close();await rejected;await assert.rejects(fetch(c.url));
});
