// Operator-only upload lease proof. No CLI/default fetch/login/seed, SQL,
// catalog mutation, credential provisioning, deployment or automatic retry.
// The enclosing controller must prove an owned synthetic target AND a ready
// baseline projection with no image references before allowing retirement.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const endpoint='vapt-assets-production.3ce69408aa5112617a282957aba71932.r2.cloudflarestorage.com';
const publicOrigin='https://pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev';
const image=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');
export async function runProductionCatalogImageLeaseProbe(options={}){
  const report={ok:false,requests:0,checks:0,imageBytes:image.length,uploadVerified:false,leaseRetired:false,staleWritesBlocked:0,uncertain:false,stage:'input'};
  let phase='input',cookie,descriptor,signal;
  const check=value=>{assert(value);report.checks++;};
  try{
    const {baseUrl,restaurantId,itemId,tag,operationIds,preflight,fetcher}=options;
    assert(baseUrl==='https://api.vapt.app.br'&&uuid(restaurantId)&&(itemId==='branding'||uuid(itemId))
      &&typeof tag==='string'&&tag.startsWith('catalog-writer-')&&uuid(tag.slice(15))
      &&typeof preflight==='function'&&typeof fetcher==='function'
      &&typeof options.cookie==='string'&&/^__Secure-better-auth\.session_token=[A-Za-z0-9%._~+-]{20,8192}$/.test(options.cookie));
    assert(operationIds&&Object.keys(operationIds).sort().join(',')==='oversized,upload'&&uuid(operationIds.oversized)&&uuid(operationIds.upload)&&operationIds.oversized!==operationIds.upload);
    const ids=structuredClone(operationIds);cookie=options.cookie;
    signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000);signal.throwIfAborted();
    const pace=options.pace??(()=>delay(3300,undefined,{signal}));assert(typeof pace==='function');
    async function wait(work,active=signal){
      active.throwIfAborted();
      return new Promise((resolve,reject)=>{
        const cancel=()=>{active.removeEventListener('abort',cancel);reject(Error('Image probe wait stopped'));};
        active.addEventListener('abort',cancel,{once:true});if(active.aborted)return cancel();
        Promise.resolve().then(()=>{active.throwIfAborted();return work(active);}).then(value=>{active.removeEventListener('abort',cancel);resolve(value);},error=>{active.removeEventListener('abort',cancel);reject(error);});
      });
    }
    phase='preflight';await wait(active=>preflight({restaurantId,itemId,tag,signal:active}));signal.throwIfAborted();
    const root=`/restaurants/${restaurantId}`,path=root+(itemId==='branding'?'/branding/image':`/menu-items/${itemId}/image`);
    async function response(url,init){
      signal.throwIfAborted();await wait(active=>pace({signal:active}));signal.throwIfAborted();assert(report.requests<12);report.requests++;
      const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
      // The real controller uses native fetch and must honor abort. A mutation
      // whose response is lost remains uncertain; never retry or blindly retire.
      const r=await wait(async bound=>{
        const value=await fetcher(url,{...init,credentials:'omit',redirect:'error',signal:bound});
        if(bound.aborted){void value.body?.cancel().catch(()=>{});bound.throwIfAborted();}return value;
      },active);
      const chunks=[];let size=0;const reader=r.body?.getReader();
      if(reader)try{for(;;){const value=await wait(()=>reader.read(),active);if(value.done)break;size+=value.value.length;assert(size<=65536);chunks.push(value.value);}}
      catch{void reader.cancel().catch(()=>{});throw Error('Bounded image probe response stopped');}
      return{status:r.status,text:Buffer.concat(chunks).toString('utf8')};
    }
    async function api(route,method='GET',body,id,expected=200){
      assert([root,root+'/menu-items',path+'/upload'].includes(route)||route.startsWith(path+'?objectKey='));
      const r=await response(baseUrl+route,{method,headers:{Origin:'https://vapt.app.br',Cookie:cookie,
        ...(body===undefined?{}:{'Content-Type':'application/json'}),...(method==='POST'?{'X-Vapt-Catalog-Protocol':'1','Idempotency-Key':id}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      check(r.status===expected);return r.text?JSON.parse(r.text):null;
    }
    phase='scope';const restaurant=await api(root);check(restaurant?.id===restaurantId&&restaurant.name===tag&&restaurant.slug===tag);
    if(itemId==='branding')check(restaurant.logoUrl===null);
    else{const items=await api(root+'/menu-items');check(Array.isArray(items)&&items.length===1&&items[0].id===itemId&&items[0].restaurantId===restaurantId&&items[0].name===tag+' image item'&&items[0].imageUrl===null);}
    phase='oversized_denial';report.uncertain=true;
    check((await api(path+'/upload','POST',{contentType:'image/webp',contentLength:1048577},ids.oversized,400))?.error?.code==='invalid_request');report.uncertain=false;
    const input={contentType:'image/webp',contentLength:image.length};
    phase='reservation';report.uncertain=true;descriptor=await api(path+'/upload','POST',input,ids.upload);
    const d=descriptor,parts=typeof d.objectKey==='string'?d.objectKey.split('/'):[];
    check(d.state==='upload_required'&&d.method==='PUT'&&parts.length===3&&parts[0]===restaurantId&&parts[1]===itemId&&uuid(parts[2]));
    check(typeof d.publicUrl==='string'&&d.publicUrl===publicOrigin+'/'+d.objectKey
      &&d.headers&&Object.keys(d.headers).sort().join(',')==='Content-Type,If-Match'
      &&d.headers['Content-Type']==='image/webp'&&/^"[a-f0-9]{32}"$/.test(d.headers['If-Match'])
      &&Number.isSafeInteger(d.expiresInSeconds)&&d.expiresInSeconds>0&&d.expiresInSeconds<=900);
    assert(typeof d.uploadUrl==='string'&&d.uploadUrl.length<=8192);const upload=new URL(d.uploadUrl);
    check(upload.protocol==='https:'&&upload.hostname===endpoint&&upload.port===''&&!upload.username&&!upload.password&&!upload.hash&&upload.pathname==='/'+d.objectKey);
    const fields=['X-Amz-Algorithm','X-Amz-Content-Sha256','X-Amz-Credential','X-Amz-Date','X-Amz-Expires','X-Amz-Signature','X-Amz-SignedHeaders','x-id'];
    check([...upload.searchParams].length===fields.length&&fields.every(n=>upload.searchParams.getAll(n).length===1)
      &&upload.searchParams.get('X-Amz-Algorithm')==='AWS4-HMAC-SHA256'
      &&upload.searchParams.get('X-Amz-Content-Sha256')==='UNSIGNED-PAYLOAD'
      &&upload.searchParams.get('X-Amz-SignedHeaders')==='content-length;content-type;host;if-match'
      &&upload.searchParams.get('X-Amz-Expires')===String(d.expiresInSeconds)&&upload.searchParams.get('x-id')==='PutObject'
      &&/^[a-f0-9]{64}$/.test(upload.searchParams.get('X-Amz-Signature')??''));
    const date=upload.searchParams.get('X-Amz-Date'),credential=upload.searchParams.get('X-Amz-Credential');
    check(/^\d{8}T\d{6}Z$/.test(date??'')&&new RegExp('^[a-f0-9]{32}/'+date.slice(0,8)+'/auto/s3/aws4_request$').test(credential??''));
    const signedAt=Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z'));
    check(Number.isFinite(signedAt)&&Date.now()-signedAt>=-60000&&Date.now()-signedAt<60000&&Date.now()<signedAt+d.expiresInSeconds*1000);
    report.objectKey=d.objectKey;report.leaseId=ids.upload;
    async function put(expected){
      // Deliberate rejection probes reuse this exact signed URL/If-Match. They
      // never retry an uncertain request, refresh a signature, or forward auth.
      const r=await response(d.uploadUrl,{method:'PUT',headers:{'Content-Type':'image/webp','If-Match':d.headers['If-Match']},body:Uint8Array.from(image)});
      check(r.status===expected);
    }
    async function verifyUploaded(){
      const value=await api(path+'/upload','POST',input,ids.upload);
      check(value?.state==='uploaded'&&value.objectKey===d.objectKey&&value.publicUrl===d.publicUrl);
    }
    phase='upload';await put(200);
    phase='upload_verification';await verifyUploaded();report.uploadVerified=true;report.uncertain=false;
    phase='stale_upload_denial';report.uncertain=true;await put(412);report.staleWritesBlocked++;
    await verifyUploaded();report.uncertain=false;
    phase='retirement';report.uncertain=true;await api(path+'?objectKey='+encodeURIComponent(d.objectKey),'DELETE',undefined,undefined,204);
    phase='retirement_verification';check((await api(path+'/upload','POST',input,ids.upload,410))?.error?.code==='menu_image_upload_expired');
    phase='resurrection_denial';await put(412);report.staleWritesBlocked++;report.leaseRetired=true;
    report.ok=true;report.uncertain=false;report.stage='verified';return report;
  }catch{report.stage=phase;report.code=phase==='input'?'invalid_input':'image_lease_probe_stopped';return report;}
  finally{cookie=undefined;descriptor=undefined;signal=undefined;}
}
