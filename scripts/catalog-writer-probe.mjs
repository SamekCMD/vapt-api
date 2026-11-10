// Operator-only bounded HTTP probe. No CLI, default fetch, authentication, seed,
// cleanup, deploy, flags, SQL or provider credentials. A fixed enclosing operator
// must prove live controls + synthetic ownership and journal the fixture first.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const names=['create','patch','private','mixed','delete','rebuild'];
export async function runProductionCatalogWriterProbe(options={}){
  const report={ok:false,requests:0,checks:0,uncertain:false,receipts:[],stage:'input'};
  let cookie,signal,phase='input',lastVersion;
  const check=value=>{assert(value);report.checks++;};
  try{
    const {baseUrl,restaurantId,tag,operationIds,fetcher,preflight}=options;
    assert(baseUrl==='https://api.vapt.app.br'&&uuid(restaurantId)&&typeof tag==='string'&&tag.startsWith('catalog-writer-')&&uuid(tag.slice(15)));
    assert(typeof fetcher==='function'&&typeof preflight==='function'&&typeof options.cookie==='string'&&options.cookie.length>=32&&options.cookie.length<=8192&&!/[\r\n]/.test(options.cookie));
    assert(operationIds&&Object.keys(operationIds).sort().join(',')===[...names].sort().join(',')&&names.every(n=>uuid(operationIds[n]))&&new Set(Object.values(operationIds)).size===6);
    const ids=structuredClone(operationIds);cookie=options.cookie;
    signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000);signal.throwIfAborted();
    const pace=options.pace??(()=>delay(3300,undefined,{signal})),waitPending=options.waitPending??(()=>delay(5000,undefined,{signal}));assert(typeof pace==='function'&&typeof waitPending==='function');
    phase='preflight';await preflight();signal.throwIfAborted();
    const root=`/restaurants/${restaurantId}`;
    async function request(path,method='GET',body,key,success=[200]){
      assert(path===root||path===root+'/menu-items'||new RegExp('^'+root+'/menu-items/[0-9a-f-]{36}$').test(path)||new RegExp('^'+root+'/catalog-operations/[0-9a-f-]{36}(?:/retry)?$').test(path)||path===root+'/catalog/rebuild');
      signal.throwIfAborted();await pace();signal.throwIfAborted();assert(report.requests<24);report.requests++;
      const r=await fetcher(baseUrl+path,{method,credentials:'omit',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{Origin:'https://vapt.app.br',Cookie:cookie,...(method==='GET'?{}:{'X-Vapt-Catalog-Protocol':'1','Idempotency-Key':key}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const reader=r.body?.getReader();assert(reader);const chunks=[];let size=0;
      try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;assert(size<=65536);chunks.push(p.value);}}catch{await reader.cancel().catch(()=>{});throw Error('bounded');}
      assert(success.includes(r.status));return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    function validReceipt(r,id,privateOnly=false){
      check(r&&r.operationId===id&&r.restaurantId===restaurantId&&['accepted','committed','projected','ready','blocked'].includes(r.phase)&&typeof r.committed==='boolean'&&typeof r.retryable==='boolean');
      check(r.version===null?!r.committed||(privateOnly&&r.phase==='ready'):r.committed&&version(r.version));
      if(r.phase==='ready')check(r.committed&&!r.retryable&&(privateOnly?r.version===null:version(r.version)));
      return structuredClone({operationId:r.operationId,restaurantId:r.restaurantId,phase:r.phase,version:r.version,committed:r.committed,retryable:r.retryable});
    }
    async function mutation(name,path,method,body,{replay=false,created=false}={}){
      phase=name;report.uncertain=true;const id=ids[name],value=await request(path,method,body,id,created?[201,202]:[200,202]);
      let r=validReceipt(value.receipt,id,name==='private');
      if(!replay)report.receipts.push(r);
      if(r.phase!=='ready'){
        await waitPending();signal.throwIfAborted();r=validReceipt(await request(root+'/catalog-operations/'+id),id,name==='private');
        if(!replay)report.receipts[report.receipts.length-1]=r;
        if(r.phase!=='ready')throw Object.assign(Error('pending'),{safeCode:'pending_unresolved'});
      }
      if(replay)check(r.version===report.receipts.find(v=>v.operationId===id).version);
      else if(name!=='private'){check(lastVersion===undefined||BigInt(r.version)>BigInt(lastVersion));lastVersion=r.version;}
      report.uncertain=false;return value;
    }
    phase='scope';const restaurant=await request(root);check(restaurant?.id===restaurantId&&restaurant.name===tag&&restaurant.slug===tag);
    const initial=await request(root+'/menu-items');check(Array.isArray(initial)&&initial.length===0);
    const input={name:tag+' item',price:'12.34',description:'Synthetic catalog probe',category:'Test',available:true,imageUrl:null,availableFrom:null,availableUntil:null,badge:null,isChefSuggestion:false,prepTimeMinutes:5,variations:[{name:'Tamanho',options:['P','G'],required:true}]};
    await mutation('create',root+'/menu-items','POST',input,{created:true});
    await mutation('create',root+'/menu-items','POST',input,{created:true,replay:true});
    phase='create_readback';const created=await request(root+'/menu-items');check(Array.isArray(created)&&created.length===1&&uuid(created[0].id)&&created[0].restaurantId===restaurantId&&created[0].name===input.name&&created[0].price==='12.34');
    check(created[0].variations?.length===1&&created[0].variations[0].name==='Tamanho'&&created[0].variations[0].required===true&&JSON.stringify(created[0].variations[0].options)==='["P","G"]');
    const itemId=created[0].id;
    await mutation('patch',root+'/menu-items/'+itemId,'PATCH',{available:false,variations:[{name:'Tamanho',options:['M'],required:false}]});
    phase='patch_readback';const patched=await request(root+'/menu-items');check(Array.isArray(patched)&&patched.length===1&&patched[0].id===itemId&&patched[0].available===false&&patched[0].variations?.length===1&&patched[0].variations[0].required===false&&JSON.stringify(patched[0].variations[0].options)==='["M"]');
    await mutation('private',root,'PATCH',{cnpj:null});
    await mutation('mixed',root,'PATCH',{description:tag+' public',cnpj:null});
    phase='mixed_readback';const mixed=await request(root);check(mixed.id===restaurantId&&mixed.name===tag&&mixed.slug===tag&&mixed.description===tag+' public'&&mixed.cnpj===null);
    await mutation('delete',root+'/menu-items/'+itemId,'DELETE');
    phase='delete_readback';const empty=await request(root+'/menu-items');check(Array.isArray(empty)&&empty.length===0);
    await mutation('rebuild',root+'/catalog/rebuild','POST',{});
    phase='completed_status';const expected=report.receipts.at(-1),status=validReceipt(await request(root+'/catalog-operations/'+ids.rebuild),ids.rebuild);check(JSON.stringify(status)===JSON.stringify(expected));
    phase='completed_retry';const retried=validReceipt(await request(root+'/catalog-operations/'+ids.rebuild+'/retry','POST',{},ids.rebuild),ids.rebuild);check(JSON.stringify(retried)===JSON.stringify(expected));
    report.ok=true;report.uncertain=false;report.stage='verified';return report;
  }catch(error){report.stage=phase;report.code=error.safeCode==='pending_unresolved'?'pending_unresolved':phase==='input'?'invalid_input':'probe_stopped';return report;}
  finally{cookie=undefined;signal=undefined;}
}
