// One non-destructive capability check against a known, retired synthetic key.
// Sends its exact existing bytes with an impossible If-Match. No other key,
// create/delete/list, credentials provisioning, retry or production write.
import {isDeepStrictEqual} from 'node:util';
const base='https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932/r2/buckets/vapt-catalog-preview';
const key='catalog/v1/preview/restaurants/8572dc6c-84b2-4b12-8099-934204cc21eb/snapshots/1.json';
const ensure=v=>{if(!v)throw Error('Catalog conditional probe guard failed');};
export async function checkCatalogR2ConditionalPut({token,fetcher,onAttempt}={}){
  let attempted=false,requests=0;
  try{
    ensure(typeof token==='string'&&token.length>=20&&token.length<=8192&&!/[\r\n]/.test(token)&&typeof fetcher==='function'&&typeof onAttempt==='function');
    async function raw(path,extra={}){
      ensure(requests++<5);const response=await fetcher(base+path,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),...extra,headers:{Authorization:'Bearer '+token,...extra.headers}});
      const reader=response.body?.getReader(),chunks=[];let size=0;ensure(reader);
      try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;ensure(size<=4096);chunks.push(p.value);}}
      catch{await reader.cancel().catch(()=>{});throw Error('Bounded response stopped');}
      return{status:response.status,body:Buffer.concat(chunks).toString('utf8'),etag:response.headers.get('etag')};
    }
    const managed=await raw('/domains/managed'),custom=await raw('/domains/custom');
    ensure(managed.status===200&&custom.status===200);
    const m=JSON.parse(managed.body),c=JSON.parse(custom.body);ensure(m.success===true&&m.result?.enabled===false&&c.success===true&&isDeepStrictEqual(c.result?.domains,[]));
    const before=await raw('/objects/'+key);ensure(before.status===200&&/^"[a-f0-9]{32}"$/.test(before.etag??'')&&before.etag!=='"00000000000000000000000000000000"'
      &&isDeepStrictEqual(JSON.parse(before.body),{retired:true,version:'1'}));
    await onAttempt();attempted=true;
    const written=await raw('/objects/'+key,{method:'PUT',headers:{'If-Match':'"00000000000000000000000000000000"','Content-Type':'application/json'},body:before.body});
    const after=await raw('/objects/'+key);ensure(after.status===200&&after.body===before.body&&after.etag===before.etag);
    return{supported:written.status===412,putStatus:written.status,bodyUnchanged:true,requests,acceptedPut:written.status>=200&&written.status<300};
  }catch{throw Object.assign(Error('Catalog conditional probe stopped'),{safeCode:attempted?'catalog_conditional_probe_uncertain':'catalog_conditional_probe_failed'});}
  finally{token=undefined;}
}
