import test from 'node:test';
import assert from 'node:assert/strict';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const baseUrl='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const capabilities={owner:['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'],admin:['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'],manager:['restaurant.read','restaurant.operate','restaurant.manage','billing.read'],staff:['restaurant.read','restaurant.operate']};
const tag='tenant-smoke-11111111-1111-4111-8111-111111111111';
function scenario({badStatus=false,leak=false,cleanupFails=false}={}){
  const organizations=[{id:id(10),name:tag,created_by:id(1)},{id:id(11),name:tag,created_by:id(5)}];
  const users=['owner','admin','manager','staff','owner'].map((role,i)=>({id:id(i+1),role,email:`${tag}-${i}@example.invalid`,password:'synthetic-password',organizationId:organizations[i===4?1:0].id}));
  const restaurants=[0,0,1].map((org,i)=>({id:id(i+20),organization_id:organizations[org].id,owner_id:organizations[org].created_by,name:tag,slug:`${tag}-${i}`}));
  const preference=new Map(),calls=[];let seeded=0,cleaned=0,closed=0;
  const driver={identifiers:()=>({tag,users,organizations,restaurants}),async seed(){seeded++;return users;},async cleanup(){cleaned++;if(cleanupFails)throw Error('synthetic-secret');return{rows:0};},async close(){closed++;}};
  const json=(value,status=200,headers={})=>new Response(status===204?null:JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
  const fetcher=async(url,options)=>{
    calls.push({url,options});const path=new URL(url).pathname,query=new URL(url).searchParams;
    if(!options.headers['CF-Access-Token'])return new Response(null,{status:302,headers:{location:'https://example.cloudflareaccess.com/cdn-cgi/access/login/test'}});
    if(!options.headers.Authorization)return json({error:{code:'unauthorized'}},401);
    if(path==='/health')return json({ok:true});
    if(path==='/api/auth/sign-in/email'){
      const user=users.find(v=>v.email===JSON.parse(options.body).email);return json({user:{id:user.id}},200,{'set-cookie':`__Secure-better-auth.session_token=${user.id}; Secure; HttpOnly; Path=/`});
    }
    const user=users.find(v=>options.headers.Cookie?.includes(v.id));
    if(path==='/api/auth/sign-out')return json({success:true});
    if(path==='/auth/me')return json({error:{code:'unauthorized'}},401);
    if(path==='/account/bootstrap'){
      if(badStatus)return json({secret:'synthetic-secret'},500);
      const own=restaurants.filter(v=>v.organization_id===user.organizationId);
      if(query.has('restaurantId')&&!own.some(v=>v.id===query.get('restaurantId')))return json({},403);
      const selected=query.get('restaurantId')??preference.get(user.id)??(own.length===1?own[0].id:null);
      return json({userId:user.id,organizations:[{id:user.organizationId,name:tag,role:user.role,capabilities:capabilities[user.role],operationActive:true,features:{cashier:true,open_tab:true,metrics:true,multi_user:user.organizationId===id(10),advanced_reports:user.organizationId===id(10)},...(leak?{planType:'business'}:{})}],restaurants:own.map(v=>({id:v.id,organizationId:v.organization_id,name:tag,slug:v.slug,onboardingStatus:'complete'})),currentRestaurantId:selected,currentOrganizationId:user.organizationId,destination:selected?'dashboard':'select-restaurant'});
    }
    if(path==='/account/preference'){
      const selected=JSON.parse(options.body);if(!restaurants.some(v=>v.id===selected.restaurantId&&v.organization_id===user.organizationId&&v.organization_id===selected.organizationId))return json({},403);
      preference.set(user.id,selected.restaurantId);return json(null,204);
    }
    if(path.endsWith('/restaurant-entitlement')){
      if(!path.includes(user.organizationId))return json({},403);
      const count=user.organizationId===id(10)?2:1,limit=count===2?25:1,permitted=['owner','admin'].includes(user.role);
      return json({canCreate:permitted&&count<limit,reason:!permitted?'permission':count===limit?'limit':'allowed',count,limit});
    }
    if(path.startsWith('/restaurants/')){
      const restaurant=restaurants.find(v=>v.id===path.split('/')[2]);
      if(restaurant.organization_id!==user.organizationId||options.method==='PATCH'&&user.role==='staff')return json({},403);
      return json({id:restaurant.id,organizationId:restaurant.organization_id,name:tag,slug:restaurant.slug,...(leak?{planStatus:'active'}:{})});
    }
    throw Error('Unexpected synthetic request');
  };
  return{driver,fetcher,calls,state:()=>({seeded,cleaned,closed})};
}
async function feature(){const m=await import('./verify-tenant-preview.mjs').catch(()=>null);assert.equal(typeof m?.runTenantPreviewSmoke,'function','tenant smoke not implemented');return m.runTenantPreviewSmoke;}
const input={baseUrl,accessJwt:'synthetic-access-token-long',bearer:'synthetic-bearer-value-at-least-32-characters'};
test('smoke rejects production URL, malformed credentials and missing cleanup before any IO',async()=>{
  const run=await feature();for(const changes of [{baseUrl:'https://api.vapt.app.br'},{bearer:'short'},{accessJwt:'secret\nheader'},{driver:{}}]){
    const s=scenario();const result=await run({...input,...s,pace:async()=>{},...changes});assert.equal(result.ok,false);assert.equal(s.calls.length,0);assert.equal(s.state().seeded,0);
  }
});
test('smoke checks four roles, two organizations, explicit units, preference and plan limits, then logs out and cleans',async()=>{
  const run=await feature(),s=scenario();const result=await run({...input,...s,pace:async()=>{}});
  assert.equal(result.ok,true);assert.equal(result.cleaned,true);assert.equal(result.users,5);assert.equal(result.organizations,2);assert.equal(result.restaurants,3);
  assert.deepEqual(s.state(),{seeded:1,cleaned:1,closed:1});assert.equal(s.calls.filter(v=>v.url.endsWith('/api/auth/sign-out')).length,5);
  assert.equal(s.calls.every(v=>v.url.startsWith(baseUrl)&&v.options.redirect==='manual'),true);
  assert.equal(s.calls.some(v=>/sign-up|checkout|portal|storage|public\/orders|rebuild/.test(v.url)),false);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-password|synthetic-access|synthetic-bearer|session_token/);
});
test('unexpected status or billing-field leak fails closed and still cleans committed fixtures',async()=>{
  const run=await feature();for(const changes of [{badStatus:true},{leak:true}]){const s=scenario(changes),result=await run({...input,...s,pace:async()=>{}});assert.equal(result.ok,false);assert.equal(result.cleaned,true);assert.equal(s.state().cleaned,1);assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|synthetic-password|session_token/);}
});
test('cleanup failure is never reported as a passing smoke',async()=>{
  const run=await feature(),s=scenario({cleanupFails:true}),result=await run({...input,...s,pace:async()=>{}});assert.equal(result.ok,false);assert.equal(result.cleaned,false);assert.equal(s.state().closed,1);assert.doesNotMatch(JSON.stringify(result),/synthetic-secret/);
});
