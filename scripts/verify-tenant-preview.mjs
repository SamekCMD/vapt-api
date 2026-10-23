import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const target='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const origin='https://infra-foundation-vapt-web.autoistloko.workers.dev';
const capabilities={owner:['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'],admin:['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'],manager:['restaurant.read','restaurant.operate','restaurant.manage','billing.read'],staff:['restaurant.read','restaurant.operate']};
const ensure=v=>{if(!v)throw Error('Tenant smoke assertion failed');};
const sameSet=(actual,expected)=>isDeepStrictEqual([...actual].sort(),[...expected].sort());
function noBillingFields(value){
  if(!value||typeof value!=='object')return;
  for(const [key,child]of Object.entries(value)){
    ensure(!/^(planType|planStatus|trialEndsAt|trialStartedAt|stripe.*|billingContact.*|billingLastError)$/.test(key));noBillingFields(child);
  }
}
// Inputs remain in the calling controller's memory. No CLI/env secret fallback.
export async function runTenantPreviewSmoke({baseUrl,accessJwt,bearer,driver,fetcher=fetch,
  signal,pace=()=>delay(3300,undefined,{signal}),onProgress=()=>{}}={}){
  const report={ok:false,cleaned:false,stage:'input',users:0,organizations:0,restaurants:0,checks:0};
  const cookies=new Map();let seeded=false,credentials=[],step='input';
  try{
    ensure(baseUrl===target&&typeof accessJwt==='string'&&/^[A-Za-z0-9._-]{20,8192}$/.test(accessJwt)
      &&typeof bearer==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(bearer)
      &&['identifiers','seed','cleanup','close'].every(key=>typeof driver?.[key]==='function'));
  }catch{return report;}
  const clearCredentials=()=>{credentials.forEach(v=>{v.password='';});credentials=[];cookies.clear();accessJwt=undefined;bearer=undefined;};
  signal?.addEventListener('abort',clearCredentials,{once:true});
  async function request(path,{method='GET',body,cookie,expected=200,perimeter='both'}={}){
    signal?.throwIfAborted();await pace();signal?.throwIfAborted();
    const headers={Origin:origin};
    if(perimeter!=='none')headers['CF-Access-Token']=accessJwt;
    if(perimeter==='both')headers.Authorization=`Bearer ${bearer}`;
    if(cookie)headers.Cookie=cookie;
    if(body!==undefined)headers['Content-Type']='application/json';
    if(path==='/api/auth/sign-in/email')headers['X-Captcha-Response']='XXXX.DUMMY.TOKEN.XXXX';
    const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
    const response=await fetcher(target+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:requestSignal});
    signal?.throwIfAborted();
    if(response.status!==expected){report.actualStatus=response.status;report.expectedStatus=expected;await response.body?.cancel();throw Error('Tenant smoke HTTP assertion failed');}
    report.checks++;
    if(expected===302){const location=new URL(response.headers.get('location')??'');ensure(location.protocol==='https:'&&location.hostname.endsWith('.cloudflareaccess.com')&&location.pathname.startsWith('/cdn-cgi/access/login/'));await response.body?.cancel();return{};}
    const text=await response.text();ensure(text.length<=131072);let value=null;
    if(text){ensure(response.headers.get('content-type')?.includes('application/json'));value=JSON.parse(text);}
    return{value,headers:response.headers};
  }
  async function logout(userId,cookie){
    await request('/api/auth/sign-out',{method:'POST',body:{},cookie});
    await request('/auth/me',{cookie,expected:401});cookies.delete(userId);
  }
  try{
    report.stage='perimeter';step='perimeter';onProgress(report.stage);
    await request('/',{expected:302,perimeter:'none'});
    await request('/health',{expected:401,perimeter:'access'});
    await request('/health');
    const manifest=driver.identifiers();
    ensure(manifest.users.length===5&&manifest.organizations.length===2&&manifest.restaurants.length===3);
    report.stage='seed';step='seed';onProgress(report.stage);signal?.throwIfAborted();credentials=await driver.seed();seeded=true;
    if(signal?.aborted){clearCredentials();signal.throwIfAborted();}
    ensure(credentials.length===5&&sameSet(credentials.map(v=>v.id),manifest.users.map(v=>v.id)));
    for(const [index,user]of credentials.entries()){
      report.stage=`role_${index}_${user.role}`;onProgress(report.stage);
      const own=manifest.restaurants.filter(v=>v.organization_id===user.organizationId),foreign=manifest.restaurants.find(v=>v.organization_id!==user.organizationId);
      ensure(capabilities[user.role]&&own.length===(index===4?1:2)&&foreign);
      step='login';const login=await request('/api/auth/sign-in/email',{method:'POST',body:{email:user.email,password:user.password}});
      const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).filter(v=>/^__Secure-better-auth\.session_token=/.test(v)).join('; ');
      ensure(cookie.length>40&&cookie.length<8192);cookies.set(user.id,cookie);user.password='';
      const bootstrap=async query=>{
        const data=(await request('/account/bootstrap'+(query??''),{cookie})).value;noBillingFields(data);
        ensure(data.userId===user.id&&data.organizations.length===1&&data.organizations[0].id===user.organizationId
          &&data.organizations[0].role===user.role&&sameSet(data.organizations[0].capabilities,capabilities[user.role])
          &&data.organizations[0].operationActive===true&&sameSet(data.restaurants.map(v=>v.id),own.map(v=>v.id))
          &&data.restaurants.every(v=>v.organizationId===user.organizationId));return data;
      };
      step='bootstrap';const initial=await bootstrap();ensure(initial.destination===(own.length===1?'dashboard':'select-restaurant'));
      // Organization ownership is checked in the canonical bootstrap summaries
      // above and foreign-route denials below, not an invented operational field.
      step='restaurant_read';for(const unit of own){const dto=(await request(`/restaurants/${unit.id}`,{cookie})).value;ensure(dto.id===unit.id&&dto.slug===unit.slug);noBillingFields(dto);}
      step='entitlement';const entitled=(await request(`/organizations/${user.organizationId}/restaurant-entitlement`,{cookie})).value;
      const permitted=['owner','admin'].includes(user.role),count=own.length,limit=index===4?1:25;
      ensure(isDeepStrictEqual(entitled,{canCreate:permitted&&count<limit,reason:!permitted?'permission':count>=limit?'limit':'allowed',count,limit}));
      step='cross_org';await request(`/restaurants/${foreign.id}`,{cookie,expected:403});
      await request(`/account/bootstrap?restaurantId=${foreign.id}`,{cookie,expected:403});
      await request('/account/preference',{method:'PATCH',cookie,body:{organizationId:foreign.organization_id,restaurantId:foreign.id},expected:403});
      const chosen=own.at(-1);
      step='preference';await request('/account/preference',{method:'PATCH',cookie,body:{organizationId:user.organizationId,restaurantId:chosen.id},expected:204});
      step='selected_bootstrap';const selected=await bootstrap();ensure(selected.currentRestaurantId===chosen.id&&selected.currentOrganizationId===user.organizationId&&selected.destination==='dashboard');
      step='route_bootstrap';const routed=await bootstrap(`?restaurantId=${own[0].id}`);ensure(routed.currentRestaurantId===own[0].id);
      // Staff cannot mutate restaurant settings even with valid JSON/session.
      step='staff_write_denial';if(user.role==='staff')await request(`/restaurants/${chosen.id}`,{method:'PATCH',cookie,body:{name:manifest.tag},expected:403});
      step='logout';await logout(user.id,cookie);
    }
    report.users=5;report.organizations=2;report.restaurants=3;report.stage='verified';report.ok=true;
  }catch(error){report.ok=false;report.failedStep=step;if(step==='seed'&&error?.safeCode==='tenant_seed_uncertain')report.failureCode='seed_uncertain';else if(signal?.aborted)report.failureCode='session_expired';}
  finally{
    for(const [id,cookie]of cookies){try{await logout(id,cookie);}catch{report.ok=false;}}
    clearCredentials();signal?.removeEventListener('abort',clearCredentials);
    if(seeded){try{report.cleaned=(await driver.cleanup()).rows===0;}catch{report.cleaned=false;}if(!report.cleaned){report.stage='cleanup';report.ok=false;}}
    try{await driver.close();}catch{report.ok=false;}
  }
  return report;
}
