// One empty synthetic catalog rebuild for the branding lease gate. No CLI,
// default transport, seed, cleanup, SQL, provider credentials or write retry.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
export async function runProductionCatalogImageBaseline(options={}){
  const report={ok:false,requests:0,uncertain:false,receipts:[],stage:'input'};let stage='input',cookie;
  try{
    const {baseUrl,restaurantId,tag,operationId,fetcher,preflight}=options;
    assert(baseUrl==='https://api.vapt.app.br'&&uuid(restaurantId)&&uuid(operationId)&&typeof tag==='string'&&tag.startsWith('catalog-writer-')&&uuid(tag.slice(15))
      &&typeof fetcher==='function'&&typeof preflight==='function'&&typeof options.cookie==='string'&&/^__Secure-better-auth\.session_token=[A-Za-z0-9%._~+-]{20,8192}$/.test(options.cookie));
    cookie=options.cookie;const total=AbortSignal.timeout(300000),signal=options.signal?AbortSignal.any([options.signal,total]):total;
    async function wait(work,active=signal){
      active.throwIfAborted();
      return new Promise((resolve,reject)=>{
        const cancel=()=>{active.removeEventListener('abort',cancel);reject(Error('Baseline wait stopped'));};
        active.addEventListener('abort',cancel,{once:true});if(active.aborted)return cancel();
        Promise.resolve().then(()=>{active.throwIfAborted();return work(active);}).then(value=>{active.removeEventListener('abort',cancel);resolve(value);},error=>{active.removeEventListener('abort',cancel);reject(error);});
      });
    }
    const pace=options.pace??(({signal})=>delay(3300,undefined,{signal}));
    const waitPending=options.waitPending??(({signal})=>delay(5000,undefined,{signal}));assert(typeof pace==='function'&&typeof waitPending==='function');
    stage='preflight';await wait(active=>preflight({restaurantId,tag,signal:active}));
    const root='/restaurants/'+restaurantId;
    async function request(path,post=false){
      assert([root,root+'/menu-items',root+'/catalog/rebuild',root+'/catalog-operations/'+operationId].includes(path));
      await wait(active=>pace({signal:active}));signal.throwIfAborted();assert(report.requests<4);report.requests++;
      const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
      const response=await wait(async bound=>{
        const value=await fetcher(baseUrl+path,{method:post?'POST':'GET',credentials:'omit',redirect:'error',signal:bound,
          headers:{Origin:'https://vapt.app.br',Cookie:cookie,...(post?{'Content-Type':'application/json','X-Vapt-Catalog-Protocol':'1','Idempotency-Key':operationId}:{})},...(post?{body:'{}'}:{})});
        if(bound.aborted){void value.body?.cancel().catch(()=>{});bound.throwIfAborted();}return value;
      },active);
      const reader=response.body?.getReader();assert(reader);let size=0;const parts=[];
      try{for(;;){const p=await wait(()=>reader.read(),active);if(p.done)break;size+=p.value.length;assert(size<=65536);parts.push(p.value);}}
      catch{void reader.cancel().catch(()=>{});throw Error('Baseline body stopped');}
      assert(post?[200,202].includes(response.status):response.status===200);return JSON.parse(Buffer.concat(parts).toString('utf8'));
    }
    function receipt(value){
      assert(value?.operationId===operationId&&value.restaurantId===restaurantId&&['accepted','committed','projected','ready','blocked'].includes(value.phase)
        &&typeof value.committed==='boolean'&&typeof value.retryable==='boolean'&&(value.committed?version(value.version):value.version===null)
        &&(value.phase!=='ready'||value.committed&&!value.retryable));
      return structuredClone({operationId:value.operationId,restaurantId:value.restaurantId,phase:value.phase,version:value.version,committed:value.committed,retryable:value.retryable});
    }
    stage='scope';const target=await request(root);assert(target.id===restaurantId&&target.name===tag&&target.slug===tag&&target.logoUrl===null&&target.description===null);
    const items=await request(root+'/menu-items');assert(Array.isArray(items)&&items.length===0);
    stage='rebuild';report.uncertain=true;const initial=receipt((await request(root+'/catalog/rebuild',true)).receipt);report.receipts=[initial];
    stage='status';if(initial.phase!=='ready')await wait(active=>waitPending({signal:active}));
    const status=receipt(await request(root+'/catalog-operations/'+operationId));report.receipts=[status];
    assert(status.phase==='ready'&&(initial.version===null||initial.version===status.version)&&(initial.phase!=='ready'||isDeepStrictEqual(initial,status)));
    report.ok=true;report.uncertain=false;report.stage='verified';return report;
  }catch{report.stage=stage;report.code=stage==='input'?'invalid_input':'baseline_stopped';return report;}
  finally{cookie=undefined;}
}
