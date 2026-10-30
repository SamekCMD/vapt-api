// Operator-only private R2 readback. No CLI/default transport, SQL, credential
// discovery, public CDN, writes or retries. Six exact GETs; never list a bucket.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const revision=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
export async function readProductionCatalogImageReferences(options={}){
  try{
    const {restaurantId,tag,version,previousVersion,store}=options;
    assert(uuid(restaurantId)&&typeof tag==='string'&&tag.startsWith('catalog-writer-')&&uuid(tag.slice(15))
      &&revision(version)&&revision(previousVersion)&&BigInt(version)>BigInt(previousVersion)&&typeof store?.get==='function');
    const deadline=AbortSignal.timeout(90000),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
    const prefix='catalog/v1/production/restaurants/'+restaurantId+'/',slugKey='catalog/v1/production/slugs/'+tag+'.json',manifestKey=prefix+'manifest.json';
    async function read(key,maxBytes){
      const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);active.throwIfAborted();
      const object=await new Promise((resolve,reject)=>{
        const cancel=()=>{active.removeEventListener('abort',cancel);reject(Error('Readback cancelled'));};
        active.addEventListener('abort',cancel,{once:true});if(active.aborted)return cancel();
        Promise.resolve().then(()=>{active.throwIfAborted();return store.get(key,{maxBytes,signal:active});}).then(v=>{active.removeEventListener('abort',cancel);resolve(v);},e=>{active.removeEventListener('abort',cancel);reject(e);});
      });
      active.throwIfAborted();assert(object&&typeof object.body==='string'&&Buffer.byteLength(object.body)<=maxBytes
        &&typeof object.etag==='string'&&object.etag.length>0&&object.etag.length<=1024&&!/[\r\n]/.test(object.etag));
      return{body:object.body,etag:object.etag,value:JSON.parse(object.body)};
    }
    const mapping=await read(slugKey,4096),registration=await read(manifestKey,4096);
    assert(isDeepStrictEqual(mapping.value,{restaurantId,version,canonicalSlug:tag,tombstone:false})
      &&isDeepStrictEqual(registration.value,{restaurantId,version,canonicalSlug:tag,previousVersion}));
    const states=[];
    for(const expected of [version,previousVersion]){
      const {value}=await read(prefix+'snapshots/'+expected+'.json',65536);
      assert(value?.version===expected&&value.catalog?.restaurant?.id===restaurantId&&value.catalog.restaurant.name===tag
        &&value.catalog.restaurant.slug===tag&&Array.isArray(value.catalog.items)&&value.catalog.items.every(i=>i.restaurantId===restaurantId));
      states.push(value);
    }
    const after=await read(manifestKey,4096),addressAfter=await read(slugKey,4096);
    assert(after.etag===registration.etag&&after.body===registration.body&&addressAfter.etag===mapping.etag&&addressAfter.body===mapping.body);
    return states;
  }catch{throw Error('Catalog image reference readback stopped');}
}
