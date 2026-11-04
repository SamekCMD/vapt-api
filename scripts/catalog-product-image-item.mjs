// Fixed operator-only item boundaries around the existing product image probe.
// No CLI, default fetch, credentials, image PUT/DELETE, SQL or write retry.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
export async function runProductionCatalogProductImageBaseline(options={}){return transition(options,false);}
export async function runProductionCatalogProductImageDeletion(options={}){return transition(options,true);}
async function transition(options,deleting){
  const report={ok:false,requests:0,uncertain:false,receipts:[],stage:'input'};let stage='input',cookie;
  try{
    const {baseUrl,restaurantId,tag,operationId,fetcher,preflight,itemId,objectKey,previousVersion}=options;
    assert(baseUrl==='https://api.vapt.app.br'&&uuid(restaurantId)&&uuid(operationId)&&typeof tag==='string'&&tag.startsWith('catalog-writer-')&&uuid(tag.slice(15))
      &&[fetcher,preflight].every(v=>typeof v==='function')&&typeof options.cookie==='string'&&/^__Secure-better-auth\.session_token=[A-Za-z0-9%._~+-]{20,8192}$/.test(options.cookie));
    if(deleting){
      const proof=structuredClone(options.imageProbe),parts=typeof objectKey==='string'?objectKey.split('/'):[];
      assert(uuid(itemId)&&parts.length===3&&parts[0]===restaurantId&&parts[1]===itemId&&uuid(parts[2])&&version(previousVersion)
        &&typeof options.readRetained==='function'&&typeof options.imageReadback==='function'
        &&proof?.ok===true&&proof.uncertain===false&&proof.stage==='verified'&&proof.restaurantId===restaurantId&&proof.itemId===itemId&&proof.objectKey===objectKey
        &&proof.protectedDeletions===2&&proof.imageAbsentConfirmed===true&&version(proof.baselineVersion)&&proof.receipts?.length===3);
      let last=proof.baselineVersion;const seen=new Set([operationId]);
      for(const r of proof.receipts){assert(uuid(r.operationId)&&!seen.has(r.operationId)&&r.restaurantId===restaurantId&&r.phase==='ready'&&r.committed===true&&r.retryable===false&&version(r.version)&&BigInt(r.version)>BigInt(last));seen.add(r.operationId);last=r.version;}
      assert(last===previousVersion);Object.assign(report,{itemId,objectKey,previousVersion});
    }
    report.restaurantId=restaurantId;cookie=options.cookie;
    const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000);
    const pace=options.pace??(({signal})=>delay(3300,undefined,{signal})),waitPending=options.waitPending??(({signal})=>delay(5000,undefined,{signal}));assert(typeof pace==='function'&&typeof waitPending==='function');
    async function wait(work,active=signal){
      active.throwIfAborted();return new Promise((resolve,reject)=>{
        const cancel=()=>{active.removeEventListener('abort',cancel);reject(Error('Product image item wait stopped'));};active.addEventListener('abort',cancel,{once:true});if(active.aborted)return cancel();
        Promise.resolve().then(()=>{active.throwIfAborted();return work(active);}).then(v=>{active.removeEventListener('abort',cancel);resolve(v);},e=>{active.removeEventListener('abort',cancel);reject(e);});
      });
    }
    const root='/restaurants/'+restaurantId,itemsPath=root+'/menu-items',resource=deleting?itemsPath+'/'+itemId:itemsPath;
    async function request(path,method='GET',body){
      assert([root,itemsPath,resource,root+'/catalog-operations/'+operationId].includes(path));await wait(active=>pace({signal:active}));signal.throwIfAborted();assert(report.requests<5);report.requests++;
      const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]),mutating=method!=='GET';
      const response=await wait(async bound=>{
        const value=await fetcher(baseUrl+path,{method,credentials:'omit',redirect:'error',signal:bound,headers:{Origin:'https://vapt.app.br',Cookie:cookie,
          ...(mutating?{'X-Vapt-Catalog-Protocol':'1','Idempotency-Key':operationId}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
        if(bound.aborted){void value.body?.cancel().catch(()=>{});bound.throwIfAborted();}return value;
      },active);
      const reader=response.body?.getReader(),chunks=[];let size=0;assert(reader);
      try{for(;;){const part=await wait(()=>reader.read(),active);if(part.done)break;size+=part.value.length;assert(size<=65536);chunks.push(part.value);}}
      catch{void reader.cancel().catch(()=>{});throw Error('Product image item body stopped');}
      assert((mutating?(deleting?[200,202]:[201,202]):[200]).includes(response.status));return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    function receipt(r){
      assert(r?.operationId===operationId&&r.restaurantId===restaurantId&&['accepted','committed','projected','ready','blocked'].includes(r.phase)
        &&typeof r.committed==='boolean'&&typeof r.retryable==='boolean'&&(r.committed?version(r.version):r.version===null)&&(r.phase!=='ready'||r.committed&&!r.retryable));
      return{operationId:r.operationId,restaurantId:r.restaurantId,phase:r.phase,version:r.version,committed:r.committed,retryable:r.retryable};
    }
    function oneItem(items,id){assert(Array.isArray(items)&&items.length===1&&uuid(items[0].id)&&(!id||items[0].id===id)&&items[0].restaurantId===restaurantId&&items[0].name===tag+' image item'&&items[0].price==='12.34'&&items[0].imageUrl===null);return items[0].id;}
    function restaurant(r){assert(r?.id===restaurantId&&r.name===tag&&r.slug===tag&&r.description===null&&r.logoUrl===null);}
    async function absent(){const proof=await wait(active=>options.imageReadback({restaurantId,objectKey,signal:active}));assert(isDeepStrictEqual(proof,{absent:true,bucket:'vapt-assets-production',objectKey}));}
    stage='preflight';await wait(active=>preflight({restaurantId,tag,...(deleting?{itemId,objectKey,previousVersion}:{}),signal:active}));
    stage='scope';restaurant(await request(root));const items=await request(itemsPath);
    if(deleting){oneItem(items,itemId);stage='image_absence';await absent();}else assert(Array.isArray(items)&&items.length===0);
    stage=deleting?'delete':'create';report.uncertain=true;
    const body=deleting?undefined:{name:tag+' image item',price:'12.34',description:'Synthetic product image probe',category:'Test',available:true,imageUrl:null,availableFrom:null,availableUntil:null,badge:null,isChefSuggestion:false,prepTimeMinutes:5,variations:[]};
    const initial=receipt((await request(resource,deleting?'DELETE':'POST',body)).receipt);report.receipts=[initial];
    stage='status';if(initial.phase!=='ready')await wait(active=>waitPending({signal:active}));
    const ready=receipt(await request(root+'/catalog-operations/'+operationId));report.receipts=[ready];
    assert(ready.phase==='ready'&&(initial.version===null||initial.version===ready.version)&&(initial.phase!=='ready'||isDeepStrictEqual(initial,ready))&&(!deleting||BigInt(ready.version)>BigInt(previousVersion)));
    stage='item_readback';const after=await request(itemsPath);
    if(!deleting)report.itemId=oneItem(after);
    else{
      assert(Array.isArray(after)&&after.length===0);stage='retained_readback';
      const states=await wait(active=>options.readRetained({restaurantId,version:ready.version,previousVersion,signal:active}));
      assert(Array.isArray(states)&&states.length===2&&Buffer.byteLength(JSON.stringify(states))<=131072);
      for(const [index,state]of states.entries()){assert(state?.version===(index===0?ready.version:previousVersion));restaurant(state.catalog?.restaurant);if(index===0)assert(Array.isArray(state.catalog.items)&&state.catalog.items.length===0);else oneItem(state.catalog.items,itemId);}
      stage='final_image_absence';await absent();report.itemAbsentConfirmed=true;report.imageAbsentConfirmed=true;
    }
    report.ok=true;report.uncertain=false;report.stage='verified';return report;
  }catch{report.stage=stage;report.code=stage==='input'?'invalid_input':'product_image_item_stopped';return report;}
  finally{cookie=undefined;}
}
