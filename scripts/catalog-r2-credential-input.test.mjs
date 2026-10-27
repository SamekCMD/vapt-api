import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const feature=async()=>{const m=await import('./catalog-r2-credential-input.mjs').catch(()=>({}));assert.equal(typeof m.createCatalogR2CredentialInput,'function','write-only local credential collector missing');return m.createCatalogR2CredentialInput;};
async function setup(t){
  const create=await feature(),bridge=await create();t.after(()=>bridge.close());
  const page=await fetch(bridge.url),html=await page.text(),nonce=html.match(/name="vapt-nonce" content="([a-f0-9]{64})"/)?.[1];assert.ok(nonce);
  const request=(path,body,headers={})=>fetch(bridge.url+path,{method:body===undefined?'GET':'POST',headers:{Origin:bridge.url,'X-Vapt-Nonce':nonce,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{bridge,request,page,html};
}
test('loopback collector delivers one pair only to the awaiting controller, never HTML/status/responses',async t=>{
  const {bridge,request,page}=await setup(t),keys={accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64)};
  assert.equal(new URL(bridge.url).hostname,'127.0.0.1');assert.equal(page.headers.get('cache-control'),'no-store');
  assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  const result=bridge.waitForCredentials();assert.equal((await request('/credentials',keys)).status,204);assert.deepEqual(await result,keys);
  const status=await(await request('/status')).json();assert.deepEqual(status,{state:'received'});
  assert.doesNotMatch(JSON.stringify(status),/bbbbbbbb|aaaaaaaa/);assert.doesNotMatch(await(await fetch(bridge.url)).text(),/bbbbbbbb|aaaaaaaa/);
  assert.equal((await request('/credentials',keys)).status,409);assert.throws(()=>bridge.waitForCredentials());
});
test('Origin nonce and Host guards block credential injection',async t=>{
  const {bridge,request}=await setup(t),keys={accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64)};
  assert.equal((await request('/credentials',keys,{Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await request('/credentials',keys,{'X-Vapt-Nonce':''})).status,403);
  assert.equal((await fetch(bridge.url+'/status')).status,403);
  const status=await new Promise((resolve,reject)=>{const req=http.get(bridge.url+'/',{headers:{Host:'foreign.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(status,403);
  assert.deepEqual(await(await request('/status')).json(),{state:'waiting'});
});
test('malformed, extra-field and oversized credentials do not consume the one input',async t=>{
  const {bridge,request}=await setup(t),waiting=bridge.waitForCredentials();
  for(const keys of [{accessKeyId:'short',secretAccessKey:'b'.repeat(64)},{accessKeyId:'a'.repeat(32),secretAccessKey:'short'},{accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64),extra:true},{accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(5000)}])assert.equal((await request('/credentials',keys)).status,400);
  assert.deepEqual(await(await request('/status')).json(),{state:'waiting'});
  await request('/credentials',{accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64)});await waiting;
});
test('close cancels the outstanding credential wait and releases the listener',async t=>{
  const {bridge}=await setup(t),rejected=assert.rejects(bridge.waitForCredentials(),/closed/);await bridge.close();await rejected;await assert.rejects(fetch(bridge.url));
});
