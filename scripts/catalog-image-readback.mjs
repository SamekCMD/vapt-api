// Operator-only, one authenticated exact-object GET. No CLI/default fetch,
// credential discovery, public CDN, listing, mutation or retries. Reuse the
// controller's RAM-only OAuth token; no new image-bucket credential is needed.
const ensure=value=>{if(!value)throw Error('Image readback guard failed');};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export async function verifyProductionCatalogImageAbsent(options={}){
  let token,reader,response;
  try{
    const {restaurantId,objectKey,fetcher}=options,parts=typeof objectKey==='string'?objectKey.split('/'):[];
    ensure(uuid(restaurantId)&&parts.length===3&&parts[0]===restaurantId&&parts[1]==='branding'&&uuid(parts[2])
      &&typeof fetcher==='function'&&typeof options.accessToken==='string'&&options.accessToken.length>=20&&options.accessToken.length<=8192&&!/[\r\n]/.test(options.accessToken));
    token=options.accessToken;
    const deadline=AbortSignal.timeout(15000),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
    async function wait(work){
      signal.throwIfAborted();
      return new Promise((resolve,reject)=>{
        const cancel=()=>{signal.removeEventListener('abort',cancel);reject(Error('Readback wait stopped'));};
        signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)return cancel();
        Promise.resolve().then(()=>{signal.throwIfAborted();return work();}).then(value=>{signal.removeEventListener('abort',cancel);resolve(value);},error=>{signal.removeEventListener('abort',cancel);reject(error);});
      });
    }
    response=await wait(async()=>{
      const result=await fetcher('https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932/r2/buckets/vapt-assets-production/objects/'+encodeURIComponent(objectKey),
        {method:'GET',credentials:'omit',redirect:'error',signal,headers:{Authorization:'Bearer '+token}});
      if(signal.aborted){void result.body?.cancel().catch(()=>{});signal.throwIfAborted();}return result;
    });
    const result=absent=>({absent,bucket:'vapt-assets-production',objectKey});
    if(response.status===200){void response.body?.cancel().catch(()=>{});return result(false);}
    ensure(response.status===404&&/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??''));
    reader=response.body?.getReader();ensure(reader);let size=0;const partsBody=[];
    for(;;){const p=await wait(()=>reader.read());if(p.done)break;size+=p.value.length;ensure(size<=4096);partsBody.push(p.value);}
    const error=JSON.parse(Buffer.concat(partsBody).toString('utf8'));
    // Strictly reject missing bucket, auth failure, HTML/generic 404 and any
    // unexpected provider envelope. A remote gate must confirm this response;
    // the mock transport is not evidence of real provider deletion.
    ensure(error.success===false&&Array.isArray(error.errors)&&error.errors.length===1&&error.errors[0].code===10007);
    return result(true);
  }catch{if(reader)void reader.cancel().catch(()=>{});else void response?.body?.cancel().catch(()=>{});throw Error('Catalog image readback stopped');}
  finally{token=undefined;}
}
