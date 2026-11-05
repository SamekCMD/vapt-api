import assert from 'node:assert/strict';
import test from 'node:test';
const baseUrl='https://api.vapt.app.br',actorId='11111111-1111-4111-8111-111111111111';
const restaurantId='22222222-2222-4222-8222-222222222222',organizationId='33333333-3333-4333-8333-333333333333';
const tag='catalog-writer-44444444-4444-4444-8444-444444444444';
const operationIds={draft:'55555555-5555-4555-8555-555555555555',finalize:'66666666-6666-4666-8666-666666666666'};
const version='9007199254740993',root='/restaurants/'+restaurantId;
const ready={operationId:operationIds.finalize,restaurantId,phase:'ready',version,committed:true,retryable:false};
const draft={id:restaurantId,organizationId,name:tag,slug:tag,whatsapp:'',localEnabled:true,deliveryEnabled:true,totalTables:1,onboardingStep:0};
const saved={...draft,totalTables:4,onboardingStep:2};
const restaurant={id:restaurantId,name:tag,slug:tag,cnpj:null,whatsapp:null,address:null,phone:null,hours:null,description:null,
  primaryColor:'#000000',secondaryColor:'#ffffff',fontFamily:'Inter',logoUrl:null,totalTables:4,maxTables:5,paymentMode:'open_tab',maxPendingOrders:10,
  localEnabled:true,deliveryEnabled:true,onboardingCompleted:true,updatedAt:'2026-11-05T18:00:00.000Z'};
const organization={id:organizationId,name:tag,role:'owner',capabilities:['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'],
  operationActive:true,features:{cashier:true,open_tab:true,metrics:true,multi_user:true,advanced_reports:true}};
const empty={userId:actorId,organizations:[],restaurants:[],currentOrganizationId:null,currentRestaurantId:null,destination:'onboarding'};
const boot=status=>({userId:actorId,organizations:[{...organization,operationActive:status==='complete'}],
  restaurants:[{id:restaurantId,organizationId,name:tag,slug:tag,onboardingStatus:status}],currentOrganizationId:organizationId,currentRestaurantId:restaurantId,
  destination:status==='complete'?'dashboard':'onboarding'});
async function feature(){const m=await import('./catalog-onboarding-probe.mjs').catch(()=>({}));assert.equal(typeof m.runProductionCatalogOnboardingProbe,'function','canonical onboarding operator missing');return m.runProductionCatalogOnboardingProbe;}
function fixture(){
  const calls=[],body={name:tag,slug:tag},patch={localEnabled:true,deliveryEnabled:true,totalTables:4,onboardingStep:2};
  // External HTTP only is controlled. The actual operator must enforce this plan,
  // reject scope drift and stop before any later write after an uncertain response.
  const steps=[['GET','/account/bootstrap',200,empty],['POST','/account/onboarding-draft',201,draft,body,operationIds.draft],
    ['POST','/account/onboarding-draft',201,draft,body,operationIds.draft],['GET',root+'/onboarding',200,draft],
    ['PATCH',root+'/onboarding',200,saved,patch],['GET',root+'/onboarding',200,saved],['GET','/account/bootstrap',200,boot('draft')],
    ['POST',root+'/onboarding/finalize',200,{receipt:ready,result:restaurant},{},operationIds.finalize],
    ['GET',root+'/catalog-operations/'+operationIds.finalize,200,ready],
    ['POST',root+'/onboarding/finalize',200,{receipt:ready,result:restaurant},{},operationIds.finalize],
    ['GET',root,200,restaurant],['GET','/account/bootstrap',200,boot('complete')]].map(s=>structuredClone(s));
  const options={baseUrl,actorId,tag,operationIds:{...operationIds},cookie:'__Secure-better-auth.session_token=synthetic-private-session-value',
    preflight:async()=>{},pace:async()=>{},waitPending:async()=>{},fetcher:async(url,init)=>{
      const index=calls.length;calls.push({url,...init});const step=steps[index];assert(step,'unexpected extra HTTP request');
      assert.equal(url,baseUrl+step[1]);assert.equal(init.method,step[0]);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
      assert(init.signal instanceof AbortSignal);assert.equal(init.headers.Origin,'https://vapt.app.br');assert.equal(init.headers.Cookie,options.cookie);
      assert.deepEqual(init.body===undefined?undefined:JSON.parse(init.body),step[4]);
      if(step[5]){assert.equal(init.headers['Idempotency-Key'],step[5]);assert.equal(init.headers['X-Vapt-Catalog-Protocol'],'1');}
      const value=structuredClone(step[3]);return Response.json(value,{status:step[2]});
    }};
  return{options,calls,steps};
}
test('canonical draft resumes and finalizes with one version and two deliberate confirmed replays',async()=>{
  const run=await feature(),f=fixture(),result=await run(f.options);
  assert.equal(result.ok,true);assert.equal(result.stage,'verified');assert.equal(result.uncertain,false);assert.equal(result.requests,12);
  assert.equal(result.restaurantId,restaurantId);assert.equal(result.organizationId,organizationId);assert.deepEqual(result.operationIds,operationIds);
  assert.equal(result.draftReplayConfirmed,true);assert.equal(result.finalizeReplayConfirmed,true);assert.deepEqual(result.receipts,[ready]);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,4);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private|cnpj|updatedAt|capabilities|features/);
});
for(const [name,change]of [
  ['origin',o=>o.baseUrl='https://foreign.invalid'],['actor',o=>o.actorId='invalid'],['tag',o=>o.tag='real-restaurant'],
  ['cookie',o=>o.cookie+='\r\nInjected: value'],['preflight',o=>delete o.preflight],['fetcher',o=>delete o.fetcher],
  ['duplicate keys',o=>o.operationIds.finalize=o.operationIds.draft],['extra key',o=>o.operationIds.extra=actorId],
  ['cancelled',o=>o.signal=AbortSignal.abort()]])test('invalid '+name+' has no HTTP effects',async()=>{
  const run=await feature(),f=fixture();change(f.options);const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.calls.length,0);assert.equal(result.uncertain,false);
});
for(const [name,change]of [
  ['foreign account',v=>v.userId=organizationId],['existing restaurant',v=>v.restaurants=[{id:restaurantId}]],
  ['existing organization',v=>v.organizations=[organization]],['selected restaurant',v=>v.currentRestaurantId=restaurantId]])test(name+' stops before creating a draft',async()=>{
  const run=await feature(),f=fixture();change(f.steps[0][3]);const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.uncertain,false);assert.equal(f.calls.length,1);
});
for(const [name,index,change]of [
  ['draft identity',2,v=>v.id=organizationId],['draft organization',2,v=>v.organizationId=actorId],
  ['draft persistence',5,v=>v.onboardingStep=0],['draft selection',6,v=>v.currentRestaurantId=actorId],
  ['foreign receipt',7,v=>v.receipt.restaurantId=organizationId],['receipt version',7,v=>v.receipt.version='9e15'],
  ['status regression',8,v=>v.version='9007199254740992'],['replay regression',9,v=>v.receipt.version='9007199254740992'],
  ['incomplete restaurant',10,v=>v.onboardingCompleted=false],['wrong destination',11,v=>v.destination='onboarding']])test(name+' retains uncertainty and stops immediately',async()=>{
  const run=await feature(),f=fixture();change(f.steps[index][3]);const result=await run(f.options);
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(f.calls.length,index+1);assert.deepEqual(result.operationIds,operationIds);
  if(index>=8)assert.equal(result.receipts[0].version,version,'do not replace the last valid receipt with a contradictory status');
});
test('actually pending response gets one status read and never a write retry or polling loop',async()=>{
  const run=await feature(),f=fixture();let waited=0;const pending={...ready,phase:'accepted',version:null,committed:false,retryable:false};
  f.steps[7][2]=202;f.steps[7][3]={receipt:pending};f.steps[8][3]=pending;f.options.waitPending=async()=>{waited++;};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.code,'onboarding_pending');assert.equal(result.uncertain,true);
  assert.deepEqual(result.receipts,[pending]);assert.equal(waited,1);assert.equal(f.calls.length,9);assert.equal(f.calls.filter(c=>c.url.endsWith('/finalize')).length,1);
});
test('pending receipt can converge on the single read before the confirmed replay',async()=>{
  const run=await feature(),f=fixture();f.steps[7][2]=202;f.steps[7][3]={receipt:{...ready,phase:'committed',retryable:true}};
  const result=await run(f.options);assert.equal(result.ok,true);assert.equal(result.requests,12);assert.deepEqual(result.receipts,[ready]);
});
for(const at of [1,4,7,9])test('lost response at request '+(at+1)+' is not replayed',async()=>{
  const run=await feature(),f=fixture(),fetcher=f.options.fetcher;
  f.options.fetcher=async(...args)=>{if(f.calls.length===at){f.calls.push({url:args[0],...args[1]});throw Error('private-provider-wire-diagnostic');}return fetcher(...args);};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(f.calls.length,at+1);
  assert.doesNotMatch(JSON.stringify(result),/private-provider-wire-diagnostic|synthetic-private/);
});
test('oversized bootstrap body is cancelled before any mutation',async()=>{
  const run=await feature(),f=fixture();let cancelled=false;
  f.options.fetcher=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}));
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.uncertain,false);assert.equal(result.requests,1);assert.equal(cancelled,true);
});
for(const boundary of ['preflight','pace','fetcher','body','waitPending'])test('cancellation interrupts a non-cooperative '+boundary+' without a later request',async()=>{
  const run=await feature(),f=fixture(),abort=new AbortController();let entered,release,timer,cancelled=false;
  const readyToCancel=new Promise(ok=>entered=ok),held=new Promise(ok=>release=ok);f.options.signal=abort.signal;
  if(boundary==='body')f.options.fetcher=async()=>new Response(new ReadableStream({start(){entered();},cancel(){cancelled=true;}}));
  else f.options[boundary]=async()=>{entered();await held;};
  if(boundary==='waitPending'){f.steps[7][2]=202;f.steps[7][3]={receipt:{...ready,phase:'accepted',version:null,committed:false,retryable:false}};}
  const pending=run(f.options);await readyToCancel;abort.abort();
  try{const result=await Promise.race([pending,new Promise(ok=>timer=setTimeout(()=>ok(null),250))]);assert(result,'must not hang on cancellation');assert.equal(result.ok,false);if(boundary==='body')assert.equal(cancelled,true);}
  finally{clearTimeout(timer);release();await pending;}
  assert.equal(f.calls.length,boundary==='waitPending'?8:0);
});
test('request deadline covers a stalled response body, not just fetch completion',async t=>{
  const run=await feature(),f=fixture(),deadlines=[];let entered,cancelled=false;
  const bodyStarted=new Promise(ok=>entered=ok);
  t.mock.method(AbortSignal,'timeout',milliseconds=>{const controller=new AbortController();deadlines.push({milliseconds,controller});return controller.signal;});
  f.options.fetcher=async()=>new Response(new ReadableStream({start(){entered();},cancel(){cancelled=true;}}));
  const pending=run(f.options);await bodyStarted;
  const request=deadlines.find(value=>value.milliseconds===15000);assert(request,'missing bounded request deadline');request.controller.abort();
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.uncertain,false);assert.equal(result.requests,1);assert.equal(cancelled,true);
});
for(const [name,value]of [
  ['accepted marked committed',{...ready,phase:'accepted'}],['projected marked uncommitted',{...ready,phase:'projected',version:null,committed:false}],
  ['ready marked retryable',{...ready,retryable:true}],['numeric int64',{...ready,version:9007199254740992}],
  ['int64 overflow',{...ready,version:'9223372036854775808'}]])test('invalid receipt '+name+' cannot authorize a replay',async()=>{
  const run=await feature(),f=fixture();f.steps[7][3]={receipt:value};const result=await run(f.options);
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(f.calls.length,8);assert.deepEqual(result.receipts,[]);
});
for(const [name,index,status]of [['draft rejected',1,409],['finalize unauthorized',7,401],['status unavailable',8,503]])test(name+' never triggers a replacement request',async()=>{
  const run=await feature(),f=fixture();f.steps[index][2]=status;f.steps[index][3]={error:{code:'synthetic',message:'private-provider-wire-diagnostic'}};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(f.calls.length,index+1);assert.doesNotMatch(JSON.stringify(result),/private-provider-wire-diagnostic/);
});
