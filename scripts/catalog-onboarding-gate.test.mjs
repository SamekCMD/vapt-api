import test from 'node:test';
import assert from 'node:assert/strict';
const uid='11111111-1111-4111-8111-111111111111',rid='22222222-2222-4222-8222-222222222222',oid='33333333-3333-4333-8333-333333333333';
const tag='catalog-writer-44444444-4444-4444-8444-444444444444',ids={draft:'55555555-5555-4555-8555-555555555555',finalize:'66666666-6666-4666-8666-666666666666'};
const m={tag,user:{id:uid,name:tag,email:tag+'-0@example.invalid'},accountId:'77777777-7777-4777-8777-777777777777',operationIds:ids};
const receipt={operationId:ids.finalize,restaurantId:rid,version:'9007199254740993',phase:'ready',committed:true,retryable:false};
const cookie='__Secure-better-auth.session_token=synthetic-private-session-value';
async function feature(){const module=await import('./catalog-onboarding-gate.mjs').catch(()=>({}));assert.equal(typeof module.runProductionCatalogOnboardingGate,'function','canonical onboarding gate missing');return module.runProductionCatalogOnboardingGate;}
function fixture(){
  const events=[],http=[],fault={};let created=false,saved=false,complete=false,live=false;
  const draft=()=>({id:rid,organizationId:oid,name:tag,slug:tag,whatsapp:'',localEnabled:true,deliveryEnabled:true,totalTables:saved?4:1,onboardingStep:saved?2:0});
  const restaurant=()=>({id:rid,name:tag,slug:tag,onboardingCompleted:complete,totalTables:4,localEnabled:true,deliveryEnabled:true,logoUrl:null,description:null});
  const driver={identifiers:()=>structuredClone(m),async seed(){events.push('seed');return{...m.user,password:'synthetic-private-password-value-long-enough'};},
    async inspectOnboarding({probe}){events.push('inspect');assert.equal(probe.ok,true);if(fault.inspect)throw Error('private SQL');return{verified:true,trialVerified:true,intentRows:2,restaurantId:rid,organizationId:oid,version:receipt.version};},
    async retireOnboarding({probe,store,verifyLoggedOut}){events.push('retire');assert.equal(live,false);assert.equal(probe.ok,true);assert(store);assert.equal((await verifyLoggedOut()).status,401);if(fault.retire)throw Object.assign(Error('private retirement'),{safeCode:'onboarding_retirement_uncertain'});return{readbackConfirmed:true,restaurantId:rid,organizationId:oid,journalRows:0,revisionRows:0,intentRows:0,objectWrites:2};},
    async cleanupIdentity(){events.push('cleanup');assert.equal(live,false);if(fault.cleanup)throw Error('private cleanup');return{rows:0};},async close(){events.push('driver_close');}};
  const storage={async ready(){events.push('storage_ready');return{bucket:'vapt-catalog-production',expiresAt:Date.now()+1800000};},
    async forPublication(probe){events.push('publication_store');assert.equal(probe.receipts[0].version,receipt.version);return{};},
    async revoke(){events.push('revoke');return fault.revoke?{revoked:false,attempted:true,status:401}:{revoked:true,attempted:true,status:403};},async close(){events.push('storage_close');}};
  const options={baseUrl:'https://api.vapt.app.br',driver,storage,pace:async()=>{},captcha:async()=>{events.push('captcha');return'synthetic-private-challenge-value';},
    preflight:async phase=>{events.push(phase);if(fault.preflight)throw Error('private preflight');},record:async(phase,value)=>{events.push(phase);if(fault.record===phase)throw Error('private disk');if(value)assert(!JSON.stringify(value).includes('synthetic-private'));},
    fetcher:async(url,init)=>{
      http.push({url,...init});const path=new URL(url).pathname;
      if(path==='/api/auth/sign-in/email'){events.push('login');if(fault.login)throw Error('private login');assert.equal(JSON.parse(init.body).email,m.user.email);assert.equal(init.headers['X-Captcha-Response'],'synthetic-private-challenge-value');live=true;return Response.json({user:m.user},{headers:{'Set-Cookie':cookie+'; Secure; HttpOnly'}});}
      if(path==='/api/auth/sign-out'){events.push('logout');live=false;return Response.json({success:true});}
      if(path==='/auth/me'){events.push('session_check');return Response.json({error:'unauthorized'},{status:live?200:401});}
      assert.equal(init.headers.Cookie,cookie);assert.equal(live,true);const root='/restaurants/'+rid;
      if(path==='/account/bootstrap')return Response.json({userId:uid,organizations:created?[{id:oid,name:tag,role:'owner',capabilities:['restaurant.manage'],operationActive:complete,features:{}}]:[],
        restaurants:created?[{id:rid,organizationId:oid,name:tag,slug:tag,onboardingStatus:complete?'complete':'draft'}]:[],currentRestaurantId:created?rid:null,currentOrganizationId:created?oid:null,destination:complete?'dashboard':'onboarding'});
      if(path==='/account/onboarding-draft'){if(fault.probe)throw Error('private draft wire');created=true;return Response.json(draft(),{status:201});}
      if(path===root+'/onboarding'){if(init.method==='PATCH')saved=true;return Response.json(draft());}
      if(path===root+'/onboarding/finalize'){complete=true;return Response.json({receipt,result:restaurant()});}
      if(path===root+'/catalog-operations/'+ids.finalize)return Response.json(receipt);
      if(path===root)return Response.json(restaurant());throw Error('unexpected request');
    }};
  return{options,driver,storage,events,http,fault};
}
test('fixed lifecycle runs real12-request probe, SQL readback, normal logout, guarded retirement, identity cleanup and key revocation',async()=>{
  const run=await feature(),f=fixture(),result=await run(f.options);assert.equal(result.ok,true);assert.equal(result.cleaned,true);assert.equal(result.sessionRevoked,true);assert.equal(result.probe.requests,12);assert.equal(result.authRequests,4);
  for(const [a,b]of [['seed_attempt','seed'],['login_attempt','login'],['probe_confirmed','inspect'],['inspect','logout'],['logout','retire'],['retire','cleanup'],['cleanup','revoke'],['revoke','driver_close']])assert(f.events.indexOf(a)<f.events.indexOf(b));
  assert.equal(f.events.filter(v=>v==='revoke').length,1);assert.deepEqual(result.revocation,{revoked:true,attempted:true,status:403});assert.doesNotMatch(JSON.stringify(result),/synthetic-private|password|Cookie|private SQL/);
});
for(const stage of ['preflight','login','probe','inspect','retire','cleanup','revoke'])test('failure at '+stage+' stops mutation progression but still revokes/closes once',async()=>{
  const run=await feature(),f=fixture();f.fault[stage]=true;const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.events.filter(v=>v==='revoke').length,1);assert(f.events.includes('storage_close'));assert(f.events.includes('driver_close'));
  if(['probe','inspect'].includes(stage)){assert(f.events.includes('logout'));assert(!f.events.includes('retire'));assert(!f.events.includes('cleanup'));}
  if(stage==='retire')assert.equal(result.uncertain,true);
  if(stage==='revoke')assert.deepEqual(result.revocation,{revoked:false,attempted:true,status:401});
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private|private SQL|private disk/);
});
test('broken logout journal does not suppress security logout or allow retirement',async()=>{
  const run=await feature(),f=fixture();f.fault.record='logout_attempt';const result=await run(f.options);
  assert.equal(result.ok,false);assert.equal(result.sessionRevoked,true);assert(f.events.includes('logout'));assert(!f.events.includes('retire'));assert(f.events.includes('revoke'));
});
test('broken credential journal does not suppress the one revocation attempt',async()=>{
  const run=await feature(),f=fixture();f.fault.record='credential_revoke_attempt';const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.events.filter(v=>v==='revoke').length,1);
});
test('cancelled seed drains before unused identity cleanup and pool close',async()=>{
  const run=await feature(),f=fixture(),abort=new AbortController();let enter,release;
  const entered=new Promise(ok=>enter=ok),held=new Promise(ok=>release=ok);f.options.signal=abort.signal;
  f.driver.seed=async()=>{f.events.push('seed');enter();await held;return{...m.user,password:'synthetic-private-password-value-long-enough'};};
  const pending=run(f.options);await entered;abort.abort();await new Promise(ok=>setImmediate(ok));assert(!f.events.includes('driver_close'));assert(!f.events.includes('cleanup'));release();
  const result=await pending;assert.equal(result.ok,false);assert(f.events.includes('cleanup'));assert(!f.events.includes('login'));assert(f.events.indexOf('cleanup')<f.events.indexOf('driver_close'));
});
test('retirement mutator drains on cancellation before revocation and pool close',async()=>{
  const run=await feature(),f=fixture(),abort=new AbortController();let enter,release;
  const entered=new Promise(ok=>enter=ok),held=new Promise(ok=>release=ok);f.options.signal=abort.signal;
  f.driver.retireOnboarding=async()=>{f.events.push('retire');enter();await held;throw Object.assign(Error('private'),{safeCode:'onboarding_retirement_uncertain'});};
  const pending=run(f.options);await entered;abort.abort();await new Promise(ok=>setImmediate(ok));assert(!f.events.includes('revoke'));assert(!f.events.includes('driver_close'));release();
  const result=await pending;assert.equal(result.uncertain,true);assert(!f.events.includes('cleanup'));assert(f.events.includes('revoke'));
});
test('invalid origin never adopts resources or sends HTTP',async()=>{const run=await feature(),f=fixture();f.options.baseUrl='https://foreign.invalid';const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.events.length,0);assert.equal(f.http.length,0);});
test('unexpected manifest fields cannot enter the seed journal',async()=>{
  const run=await feature(),f=fixture();f.driver.identifiers=()=>({...structuredClone(m),password:'must-not-escape'});
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.events.length,0);assert.equal(f.http.length,0);assert.doesNotMatch(JSON.stringify(result),/must-not-escape/);
});
test('unexpected readback fields stop the gate without entering its report',async()=>{
  const run=await feature(),f=fixture();f.driver.inspectOnboarding=async()=>({verified:true,private:'must-not-escape'});
  const result=await run(f.options);assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/must-not-escape/);assert(!f.events.includes('retire'));assert(f.events.includes('logout'));
});
test('retirement report strips values outside its fixed safe evidence fields',async()=>{
  const run=await feature(),f=fixture(),retire=f.driver.retireOnboarding;
  f.driver.retireOnboarding=async args=>({...await retire(args),private:'must-not-escape'});
  const result=await run(f.options);assert.equal(result.ok,true);assert.doesNotMatch(JSON.stringify(result),/must-not-escape/);
});
