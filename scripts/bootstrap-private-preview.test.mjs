import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tsImport } from 'tsx/esm/api';
const feature=()=>import('./bootstrap-private-preview.mjs').catch(()=>({}));
const restaurantId='11111111-1111-4111-8111-111111111111',operationId='22222222-2222-4222-8222-222222222222';
const api='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev',origin='https://infra-foundation-vapt-web.autoistloko.workers.dev';
const cookie='__Secure-better-auth.session_token=synthetic-private-cookie',bearer='synthetic-private-bearer-aaaaaaaaaaaaaa';
const aud='cc34f236f1f65ad868f3e086ab561ca053517b18691898db418096fc8e7080d5';
const jwt=(claims={})=>`synthetic.${Buffer.from(JSON.stringify({aud:[aud],exp:Math.floor(Date.now()/1000)+1800,...claims})).toString('base64url')}.synthetic`;
const receipt={operationId,restaurantId,phase:'ready',version:'11',committed:true,retryable:false};
const args=['--environment','preview','--restaurant-id',restaurantId,'--apply','--operation-id',operationId,'--confirm-project-id','dawn-morning-27332079',
  '--confirm-branch-id','br-rough-dew-b6ydeygb','--confirm-writer-coverage','--confirm-readiness'];
const init=(method='GET')=>({method,redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(5000),
  headers:{Cookie:cookie,Origin:origin,...(method==='POST'?{'Content-Type':'application/json','X-Vapt-Catalog-Protocol':'1','Idempotency-Key':operationId}:{})},
  ...(method==='POST'?{body:'{}'}:{})});
function options(){return {restaurantId,operationId,accessJwt:jwt(),bearer};}

test('existing bootstrap composes with private transport and returns only its safe receipt',async()=>{
  const {createPrivateBootstrapTransport}=await feature();assert.equal(typeof createPrivateBootstrapTransport,'function');
  const {bootstrapPublicCatalog}=await tsImport('./bootstrap-public-catalog.ts',import.meta.url);
  const calls=[],credentials=options();
  const transport=createPrivateBootstrapTransport(credentials,{fetch:async(url,value)=>{
    calls.push({url,value});const headers=new Headers(value.headers);
    assert.equal(headers.get('CF-Access-Token'),credentials.accessJwt);assert.equal(headers.get('Authorization'),'Bearer '+bearer);
    assert.equal(headers.get('Cookie'),cookie);assert.equal(headers.get('Origin'),origin);
    assert.equal(value.redirect,'error');assert.equal(value.credentials,'omit');assert.equal(value.cache,'no-store');
    return Response.json(value.method==='GET'?{id:restaurantId}:{receipt});
  }});
  let result;
  try{result=await bootstrapPublicCatalog(args,{readSession:async()=>cookie,request:transport.request});}finally{transport.dispose();}
  assert.deepEqual(result,{ok:true,environment:'preview',targets:1,postRequests:1,mode:'apply',receipt});
  assert.deepEqual(calls.map(c=>[c.url,c.value.method]),[[api+'/restaurants/'+restaurantId,'GET'],[api+'/restaurants/'+restaurantId+'/catalog/rebuild','POST']]);
  assert.equal(new Headers(calls[1].value.headers).get('Idempotency-Key'),operationId);
  assert.doesNotMatch(JSON.stringify(result),/synthetic|session_token|workers\.dev/);
  await assert.rejects(()=>transport.request(api+'/restaurants/'+restaurantId,init()));assert.equal(calls.length,2);
});

for(const [name,change] of [
  ['wrong audience',v=>v.accessJwt=jwt({aud:['foreign']})],['extra audience',v=>v.accessJwt=jwt({aud:[aud,'foreign']})],
  ['expired token',v=>v.accessJwt=jwt({exp:Math.floor(Date.now()/1000)-1})],['long-lived token',v=>v.accessJwt=jwt({exp:Math.floor(Date.now()/1000)+86400})],
  ['header injection',v=>v.bearer='bad\r\nInjected: secret'],['invalid identity',v=>v.restaurantId='not-a-uuid'],
  ['URL override',v=>v.api='https://api.vapt.app.br'],
])test(`private transport rejects ${name} without HTTP`,async()=>{
  const {createPrivateBootstrapTransport}=await feature();assert.equal(typeof createPrivateBootstrapTransport,'function');
  const value=options();change(value);assert.throws(()=>createPrivateBootstrapTransport(value,{fetch:()=>assert.fail('No fetch')}));
});

for(const [name,url,change] of [
  ['production URL','https://api.vapt.app.br/restaurants/'+restaurantId,()=>{}],
  ['other restaurant',api+'/restaurants/'+operationId,()=>{}],
  ['query string',api+'/restaurants/'+restaurantId+'?debug=1',()=>{}],
  ['DELETE',api+'/restaurants/'+restaurantId,v=>v.method='DELETE'],
  ['unexpected auth',api+'/restaurants/'+restaurantId,v=>v.headers.Authorization='Bearer injected'],
  ['redirect following',api+'/restaurants/'+restaurantId,v=>v.redirect='follow'],
  ['foreign Origin',api+'/restaurants/'+restaurantId,v=>v.headers.Origin='https://foreign.test'],
])test(`private transport refuses ${name} before forwarding credentials`,async()=>{
  const {createPrivateBootstrapTransport}=await feature();assert.equal(typeof createPrivateBootstrapTransport,'function');
  let calls=0;const transport=createPrivateBootstrapTransport(options(),{fetch:async()=>{calls++;return Response.json({});}});
  const value=init();change(value);await assert.rejects(()=>transport.request(url,value));assert.equal(calls,0);
  await assert.rejects(()=>transport.request(api+'/restaurants/'+restaurantId,init()));assert.equal(calls,0);
});

test('POST cannot precede GET and changing operation or session cannot pass the preflight',async()=>{
  const {createPrivateBootstrapTransport}=await feature();assert.equal(typeof createPrivateBootstrapTransport,'function');
  let calls=0;const ports={fetch:async()=>{calls++;return Response.json({id:restaurantId});}};
  const early=createPrivateBootstrapTransport(options(),ports);
  await assert.rejects(()=>early.request(api+'/restaurants/'+restaurantId+'/catalog/rebuild',init('POST')));assert.equal(calls,0);
  for(const change of [v=>v.headers['Idempotency-Key']=restaurantId,v=>v.headers.Cookie='other-session',v=>v.body='{"other":true}']){
    const transport=createPrivateBootstrapTransport(options(),ports);await transport.request(api+'/restaurants/'+restaurantId,init());
    const value=init('POST');change(value);await assert.rejects(()=>transport.request(api+'/restaurants/'+restaurantId+'/catalog/rebuild',value));
  }
  assert.equal(calls,3);
});

test('lost POST returns confirmation-pending without replaying or exposing credentials',async()=>{
  const {createPrivateBootstrapTransport}=await feature();assert.equal(typeof createPrivateBootstrapTransport,'function');
  const {bootstrapPublicCatalog}=await tsImport('./bootstrap-public-catalog.ts',import.meta.url);
  let calls=0;const transport=createPrivateBootstrapTransport(options(),{fetch:async(url,value)=>{
    calls++;if(value.method==='POST')throw Error(cookie+' '+bearer);return Response.json({id:restaurantId});
  }});
  let result;try{result=await bootstrapPublicCatalog(args,{readSession:async()=>cookie,request:transport.request});}finally{transport.dispose();}
  assert.deepEqual(result,{ok:false,code:'bootstrap_confirmation_pending',operationId});assert.equal(calls,2);
  assert.doesNotMatch(JSON.stringify(result),/synthetic|session_token/);
  await assert.rejects(()=>transport.request(api+'/restaurants/'+restaurantId+'/catalog/rebuild',init('POST')));assert.equal(calls,2);
});

test('failed preflight poisons the transport and dispose cancels an in-flight request',async()=>{
  const {createPrivateBootstrapTransport}=await feature();assert.equal(typeof createPrivateBootstrapTransport,'function');
  let calls=0;const denied=createPrivateBootstrapTransport(options(),{fetch:async()=>{calls++;return new Response(null,{status:401});}});
  assert.equal((await denied.request(api+'/restaurants/'+restaurantId,init())).status,401);
  await assert.rejects(()=>denied.request(api+'/restaurants/'+restaurantId+'/catalog/rebuild',init('POST')));assert.equal(calls,1);
  let signal;const active=createPrivateBootstrapTransport(options(),{fetch:async(url,value)=>{signal=value.signal;return Response.json({id:restaurantId});}});
  await active.request(api+'/restaurants/'+restaurantId,init());active.dispose();assert.equal(signal.aborted,true);
  await assert.rejects(()=>active.request(api+'/restaurants/'+restaurantId+'/catalog/rebuild',init('POST')));
});

test('real loopback HTTP preserves the POST response body until bootstrap consumes it',async()=>{
  const {createPrivateBootstrapTransport}=await feature();
  const {bootstrapPublicCatalog}=await tsImport('./bootstrap-public-catalog.ts',import.meta.url);
  const seen=[];
  const server=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;
    seen.push({method:request.method,path:request.url,body,headers:request.headers});
    response.writeHead(200,{'Content-Type':'application/json'});response.flushHeaders();
    setTimeout(()=>response.end(JSON.stringify(request.method==='GET'?{id:restaurantId}:{receipt})),20);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint='http://127.0.0.1:'+server.address().port,credentials=options();
  const transport=createPrivateBootstrapTransport(credentials,{fetch:(url,value)=>fetch(endpoint+new URL(url).pathname,value)});
  try{
    const result=await bootstrapPublicCatalog(args,{readSession:async()=>cookie,request:transport.request});
    assert.deepEqual(result,{ok:true,environment:'preview',targets:1,postRequests:1,mode:'apply',receipt});
    assert.deepEqual(seen.map(value=>[value.method,value.path,value.body]),[['GET','/restaurants/'+restaurantId,''],['POST','/restaurants/'+restaurantId+'/catalog/rebuild','{}']]);
    assert.ok(seen.every(value=>value.headers['cf-access-token']===credentials.accessJwt&&value.headers.authorization==='Bearer '+bearer&&value.headers.cookie===cookie));
  }finally{transport.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('dispose aborts an actual pending loopback HTTP fetch and cannot launch a replacement',async()=>{
  const {createPrivateBootstrapTransport}=await feature();
  let reached;const incoming=new Promise(resolve=>reached=resolve);
  let calls=0;const server=createServer(()=>{calls++;reached();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint='http://127.0.0.1:'+server.address().port;
  const transport=createPrivateBootstrapTransport(options(),{fetch:(url,value)=>fetch(endpoint+new URL(url).pathname,value)});
  try{
    const pending=transport.request(api+'/restaurants/'+restaurantId,init());
    const rejected=assert.rejects(pending,/^Error: private_bootstrap_transport_stopped$/);
    await incoming;transport.dispose();await rejected;
    await assert.rejects(()=>transport.request(api+'/restaurants/'+restaurantId,init()));assert.equal(calls,1);
  }finally{transport.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
