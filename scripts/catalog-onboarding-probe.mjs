// Operator-only canonical onboarding proof, not a product endpoint or runnable CLI.
// The enclosing controller must journal intent and prove an isolated synthetic
// identity before calling. No default network, login, SQL, cleanup or provider key.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const version=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
export async function runProductionCatalogOnboardingProbe(options={}){
  const report={ok:false,requests:0,uncertain:false,receipts:[],stage:'input'};
  let stage='input',cookie;
  try{
    const {baseUrl,actorId,tag,fetcher,preflight}=options;
    assert(baseUrl==='https://api.vapt.app.br'&&uuid(actorId)&&typeof tag==='string'&&tag.startsWith('catalog-writer-')&&uuid(tag.slice(15)));
    assert(typeof fetcher==='function'&&typeof preflight==='function'&&typeof options.cookie==='string'
      &&/^__Secure-better-auth\.session_token=[A-Za-z0-9%._~+-]{20,8192}$/.test(options.cookie));
    const ids=structuredClone(options.operationIds);
    assert(ids&&Object.keys(ids).sort().join(',')==='draft,finalize'&&uuid(ids.draft)&&uuid(ids.finalize)&&ids.draft!==ids.finalize);
    const pace=options.pace??(({signal})=>delay(3300,undefined,{signal}));
    const waitPending=options.waitPending??(({signal})=>delay(5000,undefined,{signal}));
    assert(typeof pace==='function'&&typeof waitPending==='function');
    const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000);
    signal.throwIfAborted();report.operationIds={...ids};cookie=options.cookie;
    async function wait(work,active=signal){
      active.throwIfAborted();return new Promise((resolve,reject)=>{
        const cancel=()=>{active.removeEventListener('abort',cancel);reject(Error('Onboarding probe stopped'));};
        active.addEventListener('abort',cancel,{once:true});if(active.aborted)return cancel();
        Promise.resolve().then(()=>{active.throwIfAborted();return work(active);}).then(value=>{active.removeEventListener('abort',cancel);resolve(value);},error=>{active.removeEventListener('abort',cancel);reject(error);});
      });
    }
    let restaurantId,organizationId;
    async function request(path,method='GET',body,key,statuses=[200]){
      const root='/restaurants/'+restaurantId;
      assert(path==='/account/bootstrap'||path==='/account/onboarding-draft'||(restaurantId&&[root,root+'/onboarding',root+'/onboarding/finalize',root+'/catalog-operations/'+ids.finalize].includes(path)));
      await wait(active=>pace({signal:active}));signal.throwIfAborted();assert(report.requests<12);report.requests++;
      const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
      const response=await wait(async bound=>{
        const value=await fetcher(baseUrl+path,{method,redirect:'error',credentials:'omit',signal:bound,
          headers:{Origin:'https://vapt.app.br',Cookie:cookie,...(key?{'X-Vapt-Catalog-Protocol':'1','Idempotency-Key':key}:{}),
            ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
        if(bound.aborted){void value.body?.cancel().catch(()=>{});bound.throwIfAborted();}return value;
      },active);
      const reader=response.body?.getReader();assert(reader);const chunks=[];let size=0;
      try{
        for(;;){const part=await wait(()=>reader.read(),active);if(part.done)break;size+=part.value.length;assert(size<=65536);chunks.push(part.value);}
      }catch{void reader.cancel().catch(()=>{});throw Error('Onboarding response stopped');}
      assert(statuses.includes(response.status));return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    function account(value,status){
      assert(value?.userId===actorId&&Array.isArray(value.organizations)&&Array.isArray(value.restaurants));
      if(status==='empty'){
        assert(value.organizations.length===0&&value.restaurants.length===0&&value.currentOrganizationId===null
          &&value.currentRestaurantId===null&&value.destination==='onboarding');return;
      }
      assert(value.organizations.length===1&&value.organizations[0]?.id===organizationId&&value.organizations[0].role==='owner'
        &&Array.isArray(value.organizations[0].capabilities)&&value.organizations[0].capabilities.includes('restaurant.manage')
        &&value.restaurants.length===1&&value.currentOrganizationId===organizationId&&value.currentRestaurantId===restaurantId
        &&value.destination===(status==='complete'?'dashboard':'onboarding'));
      assert(isDeepStrictEqual(value.restaurants[0],{id:restaurantId,organizationId,name:tag,slug:tag,onboardingStatus:status}));
    }
    function draft(value,step){
      assert(uuid(value?.id)&&uuid(value.organizationId)&&value.id!==value.organizationId&&value.name===tag&&value.slug===tag
        &&value.whatsapp===''&&value.onboardingStep===step&&typeof value.localEnabled==='boolean'&&typeof value.deliveryEnabled==='boolean'
        &&Number.isInteger(value.totalTables)&&value.totalTables>=1);
      if(restaurantId)assert(value.id===restaurantId&&value.organizationId===organizationId);
      if(step===2)assert(value.localEnabled===true&&value.deliveryEnabled===true&&value.totalTables===4);
      return structuredClone(value);
    }
    function receipt(value){
      assert(value?.operationId===ids.finalize&&value.restaurantId===restaurantId&&['accepted','committed','projected','ready','blocked'].includes(value.phase)
        &&typeof value.committed==='boolean'&&typeof value.retryable==='boolean'&&(value.committed?version(value.version):value.version===null)
        &&(value.phase!=='accepted'||!value.committed)&&(!['committed','projected','ready'].includes(value.phase)||value.committed)
        &&(value.phase!=='ready'||value.committed&&!value.retryable));
      return {operationId:value.operationId,restaurantId:value.restaurantId,phase:value.phase,version:value.version,committed:value.committed,retryable:value.retryable};
    }
    stage='preflight';await wait(active=>preflight({actorId,tag,operationIds:{...ids},signal:active}));
    stage='empty_account';account(await request('/account/bootstrap'),'empty');
    stage='create_draft';report.uncertain=true;
    const basics={name:tag,slug:tag},first=draft(await request('/account/onboarding-draft','POST',basics,ids.draft,[201]),0);
    restaurantId=first.id;organizationId=first.organizationId;Object.assign(report,{restaurantId,organizationId});
    stage='replay_draft';assert(isDeepStrictEqual(draft(await request('/account/onboarding-draft','POST',basics,ids.draft,[201]),0),first));report.draftReplayConfirmed=true;
    const root='/restaurants/'+restaurantId;
    stage='resume_draft';assert(isDeepStrictEqual(draft(await request(root+'/onboarding'),0),first));
    stage='save_draft';const saved=draft(await request(root+'/onboarding','PATCH',{localEnabled:true,deliveryEnabled:true,totalTables:4,onboardingStep:2}),2);
    stage='saved_draft';assert(isDeepStrictEqual(draft(await request(root+'/onboarding'),2),saved));
    stage='draft_account';account(await request('/account/bootstrap'),'draft');
    stage='finalize';const initial=receipt((await request(root+'/onboarding/finalize','POST',{},ids.finalize,[200,202])).receipt);report.receipts=[initial];
    stage='status';if(initial.phase!=='ready')await wait(active=>waitPending({signal:active}));
    const current=receipt(await request(root+'/catalog-operations/'+ids.finalize));
    assert((initial.version===null||current.version===initial.version)&&(initial.phase!=='ready'||isDeepStrictEqual(initial,current)));
    report.receipts=[current];
    if(current.phase!=='ready'){report.stage=stage;report.code='onboarding_pending';return report;}
    stage='replay_finalize';assert(isDeepStrictEqual(receipt((await request(root+'/onboarding/finalize','POST',{},ids.finalize,[200,202])).receipt),current));report.finalizeReplayConfirmed=true;
    stage='restaurant_readback';const completed=await request(root);
    assert(completed?.id===restaurantId&&completed.name===tag&&completed.slug===tag&&completed.onboardingCompleted===true
      &&completed.totalTables===4&&completed.localEnabled===true&&completed.deliveryEnabled===true&&completed.logoUrl===null&&completed.description===null);
    stage='complete_account';account(await request('/account/bootstrap'),'complete');
    report.ok=true;report.uncertain=false;report.stage='verified';return report;
  }catch{report.stage=stage;report.code=stage==='input'?'invalid_input':'onboarding_probe_stopped';return report;}
  finally{cookie=undefined;}
}
