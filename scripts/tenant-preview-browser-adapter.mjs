// Operator-only browser test adapter. No CLI, env fallback or product imports.
// Remote cookies and perimeter credentials never become browser cookies/DTOs.
import {setTimeout as delay} from 'node:timers/promises';
const target='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const remoteOrigin='https://infra-foundation-vapt-web.autoistloko.workers.dev';
const ensure=value=>{if(!value)throw Error('Browser adapter guard failed');};
const pick=(value,fields)=>{ensure(value&&typeof value==='object'&&!Array.isArray(value));return Object.fromEntries(fields.map(key=>[key,value[key]]));};
const responseError=status=>({status,value:{code:status===403?'forbidden':status===401?'unauthorized':'browser_test_request_rejected',message:'Não foi possível concluir a operação do teste privado.'}});
export function createTenantPreviewBrowserAdapter({origin,accessJwt,bearer,manifest,fetcher=fetch,signal,pace,
  expiresAt=Date.now()+1800000}={}) {
  try{const url=new URL(origin);ensure(url.origin===origin&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port
    &&typeof accessJwt==='string'&&/^[A-Za-z0-9._-]{10,8192}$/.test(accessJwt)&&typeof bearer==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(bearer)
    &&manifest?.users?.length===5&&manifest.organizations?.length===2&&manifest.restaurants?.length===3&&expiresAt>Date.now());}
  catch{throw Error('Invalid browser adapter inputs');}
  manifest=structuredClone(manifest);
  const host=new URL(origin).host,controller=new AbortController(),contexts=new Map(),counts={},statuses={};
  let state='new',attempted=false,role='owner',queue=Promise.resolve(),queued=0,httpCalls=0,timer;
  const close=()=>{state='closed';accessJwt=undefined;bearer=undefined;for(const context of contexts.values())context.cookie=undefined;contexts.clear();clearTimeout(timer);controller.abort();};
  const abort=()=>close();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)close();
  else{timer=setTimeout(close,Math.min(1800000,expiresAt-Date.now()));timer.unref?.();}
  const check=()=>{ensure(state!=='closed');controller.signal.throwIfAborted();};
  const wait=pace??(()=>delay(3300,undefined,{signal:controller.signal}));
  const serialized=run=>{const pending=queue.then(run);queue=pending.catch(()=>{});return pending;};
  async function raw(path,{method='GET',body,cookie,captcha=false}={}){
    check();ensure(httpCalls<120);await wait();check();httpCalls++;
    const headers={Origin:remoteOrigin,'CF-Access-Token':accessJwt,Authorization:'Bearer '+bearer};
    if(cookie)headers.Cookie=cookie;
    if(body!==undefined)headers['Content-Type']='application/json';
    if(captcha)headers['X-Captcha-Response']='XXXX.DUMMY.TOKEN.XXXX';
    const response=await fetcher(target+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
    check();statuses[response.status]=(statuses[response.status]??0)+1;
    if(response.status>=300&&response.status<400){await response.body?.cancel();throw Error('Browser adapter redirect rejected');}
    let text='',size=0;const reader=response.body?.getReader();
    if(reader){const decoder=new TextDecoder();try{while(true){const part=await reader.read();if(part.done)break;
      check();size+=part.value.byteLength;if(size>131072){await reader.cancel();throw Error('Browser adapter response too large');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
    if(text)ensure(response.headers.get('content-type')?.includes('application/json'));
    return{status:response.status,value:text?JSON.parse(text):null,cookies:response.headers.getSetCookie()};
  }
  function project(kind,value,context){
    if(kind==='session'){
      if(value===null)return null;
      ensure(value.user?.id===context.user.id&&value.user.email===context.user.email&&value.session?.userId===context.user.id);
      return{user:pick(value.user,['id','email','name','emailVerified','image','createdAt','updatedAt']),
        session:pick(value.session,['id','userId','expiresAt','createdAt','updatedAt'])};
    }
    if(kind==='bootstrap'){
      ensure(value.userId===context.user.id&&Array.isArray(value.organizations)&&Array.isArray(value.restaurants));
      return{...pick(value,['userId','currentOrganizationId','currentRestaurantId','destination']),
        organizations:value.organizations.map(org=>({...pick(org,['id','name','role','capabilities','operationActive']),
          features:pick(org.features,['cashier','open_tab','metrics','multi_user','advanced_reports'])})),
        restaurants:value.restaurants.map(unit=>pick(unit,['id','organizationId','name','slug','onboardingStatus']))};
    }
    if(kind==='restaurant')return pick(value,['id','name','slug','cnpj','whatsapp','address','phone','hours','description','primaryColor','secondaryColor','fontFamily','logoUrl',
      'totalTables','maxTables','paymentMode','maxPendingOrders','localEnabled','deliveryEnabled','onboardingCompleted','updatedAt']);
    if(kind==='entitlement')return pick(value,['canCreate','reason','count','limit']);
    if(kind==='billing')return pick(value,['planType','planStatus','trialEndsAt','currentPeriodEnd','cancelAtPeriodEnd','subscriptionCanceledAt','canManageBilling','canStartCheckout','requiresBillingAction']);
    if(kind==='activation')return pick(value,['cashier','menu','kitchen','settings','overview']);
    if(kind==='kitchen'){ensure(Array.isArray(value)&&value.length===0);return[];}
    ensure(kind==='preference'&&value===null);return null;
  }
  function admitted(method,path,body){
    ensure(typeof path==='string'&&path.startsWith('/')&&!path.startsWith('//')&&!path.includes('%')&&!path.includes('\\')&&path.length<512);
    const url=new URL(path,origin);ensure(!url.hash&&url.origin===origin);
    const keys=[...url.searchParams.keys()];ensure(new Set(keys).size===keys.length);
    const pathOnly=url.pathname;
    if(method==='GET'){
      ensure(body===undefined||body==='');
      if(pathOnly==='/api/auth/get-session'&&keys.length===0)return'session';
      if(pathOnly==='/account/bootstrap'&&keys.every(key=>key==='restaurantId')
        &&(!keys.length||manifest.restaurants.some(unit=>unit.id===url.searchParams.get('restaurantId'))))return'bootstrap';
      if(pathOnly==='/billing/stripe/subscription'&&keys.length===1&&keys[0]==='organizationId'
        &&manifest.organizations.some(org=>org.id===url.searchParams.get('organizationId')))return'billing';
      if(keys.length===0){
        if(manifest.organizations.some(org=>pathOnly===`/organizations/${org.id}/restaurant-entitlement`))return'entitlement';
        for(const unit of manifest.restaurants){
          if(pathOnly===`/restaurants/${unit.id}`)return'restaurant';
          if(pathOnly===`/restaurants/${unit.id}/kitchen/orders`)return'kitchen';
          if(pathOnly===`/restaurants/${unit.id}/activation`)return'activation';
        }
      }
    }
    ensure(keys.length===0&&typeof body==='string'&&Buffer.byteLength(body)<=1024);
    const value=JSON.parse(body);
    if(method==='POST'&&pathOnly==='/api/auth/sign-out'&&value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0)return'logout';
    if(method==='PATCH'&&pathOnly==='/account/preference'){
      ensure(value&&Object.keys(value).length===2&&Object.hasOwn(value,'organizationId')&&Object.hasOwn(value,'restaurantId')
        &&manifest.restaurants.some(unit=>unit.id===value.restaurantId&&unit.organization_id===value.organizationId));return'preference';
    }
    throw Error('Browser adapter route rejected');
  }
  async function logout(context){
    if(!context.cookie)return;
    const oldCookie=context.cookie;
    ensure((await raw('/api/auth/sign-out',{method:'POST',body:{},cookie:oldCookie})).status===200);
    ensure((await raw('/auth/me',{cookie:oldCookie})).status===401);context.cookie=undefined;
  }
  return{
    async initialize(credentials){
      try{
        check();ensure(!attempted&&state==='new'&&Array.isArray(credentials)&&credentials.length===5);attempted=true;
        for(const [name,index]of [['owner',0],['staff',3]]){
          const user=credentials[index];ensure(user?.role===name&&user.id===manifest.users[index].id&&user.email===manifest.users[index].email&&typeof user.password==='string');
          const result=await raw('/api/auth/sign-in/email',{method:'POST',body:{email:user.email,password:user.password},captcha:true});
          ensure(result.status===200);
          const cookie=result.cookies.map(value=>value.split(';')[0]).filter(value=>/^__Secure-better-auth\.session_token=[A-Za-z0-9%._~+-]{20,8192}$/.test(value));
          ensure(cookie.length===1);contexts.set(name,{user:{id:user.id,email:user.email},cookie:cookie[0]});
        }
        state='ready';
      }catch{throw Error('Browser adapter initialization failed');}
      finally{if(Array.isArray(credentials))credentials.forEach(user=>{user.password='';});}
    },
    selectRole(next){ensure(state==='ready'&&['owner','staff'].includes(next)&&contexts.has(next));role=next;},
    async request({host:requestHost,origin:requestOrigin,method,path,body}={}){
      if(state!=='ready')return responseError(503);
      if(requestHost!==host||(requestOrigin!==undefined&&requestOrigin!==origin)||method!=='GET'&&requestOrigin!==origin)return responseError(403);
      let kind;try{kind=admitted(method,path,body);}catch{return responseError(400);}
      if(queued>=8||httpCalls>=112)return responseError(429);
      // Capture identity at admission; a queued old tab must not inherit a role switch.
      const selected=role,context=contexts.get(selected);queued++;
      return serialized(async()=>{
        try{
          check();ensure(state==='ready'&&selected===role&&contexts.get(selected)===context);
          const countKey=selected+' '+method+' '+new URL(path,origin).pathname;counts[countKey]=(counts[countKey]??0)+1;
          if(kind==='logout'){await logout(context);return{status:200,value:{success:true}};}
          const result=await raw(path,{method,cookie:context.cookie,...(method==='GET'?{}:{body:JSON.parse(body)})});
          if(result.status>=400)return responseError(result.status);
          ensure(result.status===(kind==='preference'?204:200));
          const value=project(kind,result.value,context),serializedValue=JSON.stringify(value);
          const secrets=[accessJwt,bearer,...[...contexts.values()].flatMap(value=>value.cookie?[value.cookie,value.cookie.slice(value.cookie.indexOf('=')+1)]:[])];
          ensure(secrets.every(secret=>!secret||!serializedValue.includes(secret)));
          return{status:result.status,value};
        }catch{return responseError(controller.signal.aborted?503:502);}
        finally{queued--;}
      });
    },
    async shutdown(){
      if(state==='closed')return{ok:false};
      state='stopping';let ok=true;await queue;
      for(const context of contexts.values()){try{await logout(context);}catch{ok=false;}}
      close();signal?.removeEventListener('abort',abort);return{ok};
    },
    close,
    report:()=>({state,role,httpCalls,requestCounts:{...counts},httpStatusCounts:{...statuses},
      sessionsRetained:[...contexts.values()].filter(value=>!!value.cookie).length,retainsCredentials:accessJwt!==undefined||bearer!==undefined}),
  };
}
