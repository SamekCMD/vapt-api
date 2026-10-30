// Operator-only attached-image proof. No CLI/default transport, upload, seed,
// login, SQL, credential discovery/provisioning, deployment or write retries.
// Caller must prove an owned empty synthetic catalog + an already verified
// upload, and supply bounded independent private-R2/exact-image readbacks.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const imageOrigin='https://pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev';
export async function runProductionCatalogImageReferenceProbe(options={}){
  const report={ok:false,requests:0,uncertain:false,receipts:[],protectedDeletions:0,imageAbsentConfirmed:false,stage:'input'};
  let phase='input',cookie,signal;
  try{
    const {baseUrl,restaurantId,itemId,tag,objectKey,publicUrl,baselineVersion,fetcher,preflight,readRetained,imageReadback}=options;
    assert(baseUrl==='https://api.vapt.app.br'&&uuid(restaurantId)&&(itemId==='branding'||uuid(itemId))
      &&typeof tag==='string'&&tag.startsWith('catalog-writer-')&&uuid(tag.slice(15))&&version(baselineVersion)
      &&typeof options.cookie==='string'&&/^__Secure-better-auth\.session_token=[A-Za-z0-9%._~+-]{20,8192}$/.test(options.cookie)
      &&[fetcher,preflight,readRetained,imageReadback].every(v=>typeof v==='function'));
    const parts=typeof objectKey==='string'?objectKey.split('/'):[];
    assert(parts.length===3&&parts[0]===restaurantId&&parts[1]===itemId&&uuid(parts[2])&&publicUrl===imageOrigin+'/'+objectKey);
    const ids=structuredClone(options.operationIds),names=['attach','detach','advance'];
    assert(ids&&Object.keys(ids).sort().join(',')==='advance,attach,detach'&&names.every(n=>uuid(ids[n]))&&new Set(Object.values(ids)).size===3);
    cookie=options.cookie;signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000);
    const pace=options.pace??(({signal})=>delay(3300,undefined,{signal})),waitPending=options.waitPending??(({signal})=>delay(5000,undefined,{signal}));
    assert(typeof pace==='function'&&typeof waitPending==='function');
    async function wait(work,active=signal){
      active.throwIfAborted();return new Promise((resolve,reject)=>{
        const cancel=()=>{active.removeEventListener('abort',cancel);reject(Error('Image reference wait stopped'));};
        active.addEventListener('abort',cancel,{once:true});if(active.aborted)return cancel();
        Promise.resolve().then(()=>{active.throwIfAborted();return work(active);}).then(v=>{active.removeEventListener('abort',cancel);resolve(v);},e=>{active.removeEventListener('abort',cancel);reject(e);});
      });
    }
    const root='/restaurants/'+restaurantId,resource=itemId==='branding'?root:root+'/menu-items/'+itemId;
    const imagePath=(itemId==='branding'?root+'/branding/image':resource+'/image')+'?objectKey='+encodeURIComponent(objectKey);
    const routes=new Set([root,root+'/menu-items',resource,imagePath,root+'/catalog/rebuild',...names.map(n=>root+'/catalog-operations/'+ids[n])]);
    async function request(path,method='GET',body,id,expected=[200]){
      assert(routes.has(path));await wait(active=>pace({signal:active}));signal.throwIfAborted();assert(report.requests<14);report.requests++;
      const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
      const r=await wait(async bound=>{
        const value=await fetcher(baseUrl+path,{method,credentials:'omit',redirect:'error',signal:bound,
          headers:{Origin:'https://vapt.app.br',Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'}),
            ...(['PATCH','POST'].includes(method)?{'X-Vapt-Catalog-Protocol':'1','Idempotency-Key':id}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
        if(bound.aborted){void value.body?.cancel().catch(()=>{});bound.throwIfAborted();}return value;
      },active);
      const reader=r.body?.getReader(),chunks=[];let size=0;
      if(reader)try{for(;;){const p=await wait(()=>reader.read(),active);if(p.done)break;size+=p.value.length;assert(size<=65536);chunks.push(p.value);}}
      catch{void reader.cancel().catch(()=>{});throw Error('Image reference body stopped');}
      assert(expected.includes(r.status));const bytes=Buffer.concat(chunks).toString('utf8');return bytes?JSON.parse(bytes):null;
    }
    function receipt(r,id){
      assert(r?.operationId===id&&r.restaurantId===restaurantId&&['accepted','committed','projected','ready','blocked'].includes(r.phase)
        &&typeof r.committed==='boolean'&&typeof r.retryable==='boolean'&&(r.committed?version(r.version):r.version===null)
        &&(r.phase!=='ready'||r.committed&&!r.retryable));
      return{operationId:r.operationId,restaurantId:r.restaurantId,phase:r.phase,version:r.version,committed:r.committed,retryable:r.retryable};
    }
    function itemsMatch(items,url){
      assert(Array.isArray(items));
      if(itemId==='branding')assert.equal(items.length,0);
      else assert(items.length===1&&items[0].id===itemId&&items[0].restaurantId===restaurantId&&items[0].name===tag+' image item'&&items[0].imageUrl===url);
    }
    async function current(url,scope=false){
      if(itemId==='branding'||scope){const r=await request(root);assert(r?.id===restaurantId&&r.name===tag&&r.slug===tag&&r.logoUrl===(itemId==='branding'?url:null));}
      if(itemId!=='branding'||scope)itemsMatch(await request(root+'/menu-items'),url);
    }
    async function physical(absent){
      const r=await wait(active=>imageReadback({restaurantId,objectKey,signal:active}));
      assert(r?.absent===absent&&r.bucket==='vapt-assets-production'&&r.objectKey===objectKey);
    }
    async function retained(r,previousVersion,currentUrl,previousUrl){
      const states=await wait(active=>readRetained({restaurantId,version:r.version,previousVersion,signal:active}));
      assert(Array.isArray(states)&&states.length===2&&Buffer.byteLength(JSON.stringify(states))<=131072);
      for(const [index,s]of states.entries()){
        assert(s?.version===(index===0?r.version:previousVersion)&&s.catalog?.restaurant?.id===restaurantId&&s.catalog.restaurant.name===tag
          &&s.catalog.restaurant.slug===tag&&s.catalog.restaurant.logoUrl===(itemId==='branding'?(index===0?currentUrl:previousUrl):null));
        itemsMatch(s.catalog.items,index===0?currentUrl:previousUrl);
      }
    }
    let lastVersion=baselineVersion;
    async function mutate(name,url,previousUrl){
      phase=name;report.uncertain=true;
      const isRebuild=name==='advance',body=isRebuild?{}:itemId==='branding'?{logoUrl:url}:{imageUrl:url};
      const initial=receipt((await request(isRebuild?root+'/catalog/rebuild':resource,isRebuild?'POST':'PATCH',body,ids[name],[200,202]))?.receipt,ids[name]);
      let r=initial;report.receipts.push(initial);
      if(r.phase!=='ready'){
        await wait(active=>waitPending({signal:active}));r=receipt(await request(root+'/catalog-operations/'+ids[name]),ids[name]);
        report.receipts[report.receipts.length-1]=r;
        assert(initial.version===null||initial.version===r.version);
      }
      assert(r.phase==='ready'&&BigInt(r.version)>BigInt(lastVersion));
      phase=name+'_readback';await retained(r,lastVersion,url,previousUrl);await current(url);lastVersion=r.version;report.uncertain=false;
    }
    async function protect(){
      phase='protected_delete';report.uncertain=true;
      const value=await request(imagePath,'DELETE',undefined,undefined,[409]);assert(value?.error?.code==='menu_image_cleanup_pending');
      await physical(false);report.protectedDeletions++;report.uncertain=false;
    }
    phase='preflight';await wait(active=>preflight({restaurantId,itemId,tag,objectKey,baselineVersion,signal:active}));
    phase='scope';await current(null,true);await physical(false);
    await mutate('attach',publicUrl,null);await protect();
    await mutate('detach',null,publicUrl);await protect();
    await mutate('advance',null,null);
    phase='retirement';report.uncertain=true;await request(imagePath,'DELETE',undefined,undefined,[204]);
    phase='physical_absence';await physical(true);report.imageAbsentConfirmed=true;
    report.ok=true;report.uncertain=false;report.stage='verified';return report;
  }catch{report.stage=phase;report.code=phase==='input'?'invalid_input':'image_reference_probe_stopped';return report;}
  finally{cookie=undefined;signal=undefined;}
}
