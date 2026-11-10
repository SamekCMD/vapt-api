import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTenantPreviewBrowserAdapter} from './tenant-preview-browser-adapter.mjs';
const local='http://127.0.0.1:54321',target='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const access='synthetic.access.jwt',bearer='synthetic-private-bearer-32-characters';
const userIds=[1,2,3,4,5].map(n=>'10000000-0000-4000-8000-00000000000'+n);
const orgIds=['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002'];
const unitIds=[1,2,3].map(n=>'30000000-0000-4000-8000-00000000000'+n);
const manifest={users:userIds.map((id,n)=>({id,name:'Synthetic',email:`synthetic-${n}@example.invalid`})),
  organizations:orgIds.map(id=>({id})),restaurants:unitIds.map((id,n)=>({id,organization_id:orgIds[n===2?1:0]}))};
function fixture(options={}){
  const calls=[],active=new Set();
  const credentials=manifest.users.map((u,n)=>({...u,role:['owner','admin','manager','staff','owner'][n],password:'synthetic-password-'+n}));
  const fetcher=async(url,init)=>{
    calls.push({url,init});const path=new URL(url).pathname,headers=new Headers(init.headers);
    assert.equal(new URL(url).origin,target);assert.equal(init.redirect,'manual');
    assert.equal(headers.get('CF-Access-Token'),access);assert.equal(headers.get('Authorization'),'Bearer '+bearer);
    if(path==='/api/auth/sign-in/email'){
      const data=JSON.parse(init.body),index=manifest.users.findIndex(u=>u.email===data.email);
      assert.ok(index===0||index===3);active.add(index);
      return Response.json({token:'do-not-forward-login-token'},{headers:{'Set-Cookie':`__Secure-better-auth.session_token=synthetic-cookie-${index}-value; Path=/; Secure; HttpOnly`}});
    }
    const index=headers.get('Cookie')?.includes('cookie-3-')?3:0;
    if(path==='/api/auth/sign-out'){active.delete(index);return Response.json({success:true,token:'do-not-forward-logout-token'});}
    if(path==='/auth/me')return Response.json({code:active.has(index)?'active':'unauthorized'},{status:active.has(index)?200:401});
    if(path==='/api/auth/get-session')return Response.json(active.has(index)?{
      user:{...manifest.users[index],emailVerified:true,createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z'},
      session:{id:'40000000-0000-4000-8000-000000000001',userId:userIds[index],expiresAt:'2026-11-01T00:00:00.000Z',token:'must-not-reach-browser',ipAddress:'synthetic-private-ip'}}:null);
    if(path==='/account/bootstrap')return Response.json({userId:userIds[index],organizations:[{id:orgIds[0],name:'Synthetic',role:index===3?'staff':'owner',
      capabilities:['restaurant.read','restaurant.operate'],operationActive:true,features:{cashier:true,open_tab:true,metrics:true,multi_user:true,advanced_reports:true}}],
      restaurants:unitIds.slice(0,2).map(id=>({id,organizationId:orgIds[0],name:'Synthetic',slug:'synthetic',onboardingStatus:'complete'})),
      currentOrganizationId:orgIds[0],currentRestaurantId:unitIds[0],destination:'dashboard',untrusted:{token:bearer}});
    if(path==='/account/preference')return new Response(null,{status:204});
    return Response.json({code:'forbidden',message:bearer},{status:403});
  };
  const adapter=createTenantPreviewBrowserAdapter({origin:local,accessJwt:access,bearer,manifest:structuredClone(manifest),
    fetcher:options.fetcher??fetcher,pace:async()=>{},...options});
  const request=(path,init={})=>adapter.request({host:'127.0.0.1:54321',origin:local,method:'GET',path,...init});
  return{adapter,calls,credentials,request,transport:fetcher};
}
test('rejects a non-loopback browser origin before creating an adapter',()=>{
  assert.throws(()=>fixture({origin:'https://vapt.app.br'}),/Invalid browser adapter/);
});
test('initializes only owner and staff, erases borrowed passwords, and strips the real session token before browser output',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/sign-in/email')).length,2);
  assert.ok(f.credentials.every(c=>c.password===''));
  const result=await f.request('/api/auth/get-session');
  assert.equal(result.status,200);assert.equal(result.value.user.id,userIds[0]);
  assert.equal(result.value.session.userId,userIds[0]);
  assert.doesNotMatch(JSON.stringify(result),/must-not-reach-browser|synthetic-cookie|private-bearer|access.jwt|private-ip/);
  await f.adapter.shutdown();
});
test('switching operator context never borrows the other role cookie or browser-supplied authorization',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);f.adapter.selectRole('staff');
  const result=await f.request('/api/auth/get-session',{headers:{Authorization:'Bearer attacker',Cookie:'attacker=value','CF-Access-Token':'attacker'}});
  assert.equal(result.value.user.id,userIds[3]);assert.equal(new Headers(f.calls.at(-1).init.headers).get('Cookie'),'__Secure-better-auth.session_token=synthetic-cookie-3-value');
  f.adapter.selectRole('owner');assert.equal((await f.request('/api/auth/get-session')).value.user.id,userIds[0]);
  await f.adapter.shutdown();
});
test('unknown targets, query credentials, forbidden methods and cross-origin requests perform no upstream I/O',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);const before=f.calls.length;
  for(const [path,init]of [
    ['/billing/stripe/checkout',{method:'POST',body:'{}'}],['https://api.vapt.app.br/auth/me',{}],
    ['/account/bootstrap?token=secret',{}],['/account/bootstrap?restaurantId='+unitIds[0]+'&restaurantId='+unitIds[1],{}],
    ['/account/bootstrap',{origin:'https://attacker.invalid'}],['/account/bootstrap',{host:'attacker.invalid'}],
    ['/restaurants/'+unitIds[0],{method:'PATCH',body:'{}'}],['/api/auth/sign-in/email',{method:'POST',body:'{}'}],
  ])assert.ok((await f.request(path,init)).status>=400);
  assert.equal(f.calls.length,before);await f.adapter.shutdown();
});
test('preference validates its exact fixture association before forwarding and refuses extra fields',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);const before=f.calls.length;
  for(const body of [{organizationId:orgIds[0],restaurantId:unitIds[2]},{organizationId:orgIds[0],restaurantId:unitIds[1],name:'unexpected'}]){
    assert.equal((await f.request('/account/preference',{method:'PATCH',body:JSON.stringify(body)})).status,400);
  }
  assert.equal(f.calls.length,before);
  assert.equal((await f.request('/account/preference',{method:'PATCH',body:JSON.stringify({organizationId:orgIds[0],restaurantId:unitIds[1]})})).status,204);
  await f.adapter.shutdown();
});
test('success payloads are projected and error payloads never echo upstream secrets',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);
  const account=await f.request('/account/bootstrap');assert.equal(account.value.userId,userIds[0]);assert.equal(account.value.untrusted,undefined);
  const denied=await f.request('/restaurants/'+unitIds[2]);assert.equal(denied.status,403);
  assert.doesNotMatch(JSON.stringify([account,denied,f.adapter.report()]),/private-bearer|synthetic-cookie|access.jwt/);
  await f.adapter.shutdown();
});
test('logout checks the revoked cookie against the real upstream before reporting success',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);
  const result=await f.request('/api/auth/sign-out',{method:'POST',body:'{}'});
  assert.equal(result.status,200);assert.deepEqual(result.value,{success:true});
  assert.equal(new URL(f.calls.at(-1).url).pathname,'/auth/me');
  assert.equal((await f.request('/api/auth/get-session')).value,null);
  assert.equal((await f.adapter.shutdown()).ok,true);assert.equal(f.adapter.report().retainsCredentials,false);
});
test('abort closes queued work, clears cookies/perimeter and refuses any subsequent upstream I/O',async()=>{
  const controller=new AbortController(),f=fixture({signal:controller.signal});await f.adapter.initialize(f.credentials);
  controller.abort();const before=f.calls.length;
  assert.equal((await f.request('/account/bootstrap')).status,503);assert.equal(f.calls.length,before);
  assert.equal(f.adapter.report().retainsCredentials,false);assert.equal(f.adapter.report().sessionsRetained,0);
});
test('redirect and oversized response fail closed without exposing headers, body or Location',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);
  // Replace only post-login transport behavior at the boundary via a fresh fixture.
  for(const response of [new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/?token=secret'}}),Response.json({padding:'x'.repeat(140000)})]){
    let calls=0;const g=fixture({fetcher:async()=>{calls++;return response;}});
    await assert.rejects(g.adapter.initialize(g.credentials),/Browser adapter/);
    assert.ok(g.credentials.every(c=>c.password===''));assert.equal(calls,1);g.adapter.close();
    assert.doesNotMatch(JSON.stringify(g.adapter.report()),/untrusted|token=|padding/);
  }
  await f.adapter.shutdown();
});
test('logout accepts only an empty JSON object, not an array or an extra side-effect field',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);const before=f.calls.length;
  for(const body of ['[]','1','true','{"redirectTo":"https://untrusted.invalid"}'])assert.equal((await f.request('/api/auth/sign-out',{method:'POST',body})).status,400);
  assert.equal(f.calls.length,before);await f.adapter.shutdown();
});
test('bounded request budget refuses further browser work while reserving calls for session revocation',async()=>{
  const f=fixture();await f.adapter.initialize(f.credentials);
  for(let n=0;n<110;n++)assert.equal((await f.request('/account/bootstrap')).status,200);
  assert.equal((await f.request('/account/bootstrap')).status,429);
  assert.equal((await f.adapter.shutdown()).ok,true);assert.equal(f.adapter.report().httpCalls,116);
});
test('logout never claims success if the old cookie is still accepted upstream',async()=>{
  const baseFixture=fixture();
  const f=fixture({fetcher:(url,init)=>url.endsWith('/auth/me')?Response.json({ok:true}):baseFixture.transport(url,init)});
  await f.adapter.initialize(f.credentials);
  assert.equal((await f.request('/api/auth/sign-out',{method:'POST',body:'{}'})).status,502);
  assert.equal((await f.adapter.shutdown()).ok,false);assert.equal(f.adapter.report().retainsCredentials,false);
  baseFixture.adapter.close();
});
