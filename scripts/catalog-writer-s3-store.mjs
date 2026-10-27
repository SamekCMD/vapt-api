// Operator-only S3 transport. Explicit short-lived credentials only, no env or
// credential-chain fallback. Seven fixed target keys, no list/create/delete,
// no manifest overwrite, no general-purpose object writes or automatic retries.
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {isDeepStrictEqual} from 'node:util';
const ensure=v=>{if(!v)throw Error('Catalog S3 guard failed');};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const etag=v=>typeof v==='string'&&/^"[a-f0-9]{32}"$/.test(v);
export function createProductionCatalogWriterS3Store(options={}){
  const {restaurantId,tag,expiresAt,requestHandler}=options,versions=structuredClone(options.versions);
  ensure(uuid(restaurantId)&&typeof tag==='string'&&tag.startsWith('catalog-writer-')&&uuid(tag.slice(15))
    &&Array.isArray(versions)&&versions.length===5&&versions.every((v,i)=>version(v)&&(i===0||BigInt(v)>BigInt(versions[i-1])))
    &&typeof options.accessKeyId==='string'&&/^[a-f0-9]{32}$/.test(options.accessKeyId)
    &&typeof options.secretAccessKey==='string'&&/^[a-f0-9]{64}$/.test(options.secretAccessKey)
    &&Number.isSafeInteger(expiresAt)&&expiresAt>Date.now()&&expiresAt-Date.now()<=1800000);
  const prefix=`catalog/v1/production/restaurants/${restaurantId}/`,slugKey=`catalog/v1/production/slugs/${tag}.json`,manifestKey=prefix+'manifest.json';
  const snapshots=new Map(versions.map(v=>[prefix+`snapshots/${v}.json`,v])),keys=new Set([slugKey,manifestKey,...snapshots.keys()]);
  const credentials={accessKeyId:options.accessKeyId,secretAccessKey:options.secretAccessKey,expiration:new Date(expiresAt)};
  const client=new S3Client({endpoint:'https://3ce69408aa5112617a282957aba71932.r2.cloudflarestorage.com',region:'auto',forcePathStyle:true,
    credentials,maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',...(requestHandler?{requestHandler}:{})});
  let closed=false,requests=0;
  const admitted=key=>{ensure(!closed&&Date.now()<expiresAt&&keys.has(key)&&requests<32);};
  const signal=value=>value?AbortSignal.any([value,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  return{
    async get(key,{maxBytes=65536,signal:callerSignal}={}){
      let body;
      try{
        admitted(key);ensure(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=65536);requests++;
        const value=await client.send(new GetObjectCommand({Bucket:'vapt-catalog-production',Key:key}),{abortSignal:signal(callerSignal)});
        body=value.Body;
        ensure(etag(value.ETag)&&value.Body&&(!Number.isFinite(value.ContentLength)||value.ContentLength<=maxBytes));
        const reader=value.Body.transformToWebStream().getReader(),parts=[];let size=0;
        try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;ensure(size<=maxBytes);parts.push(p.value);}}
        catch{await reader.cancel().catch(()=>{});throw Error('Bounded S3 response stopped');}
        return{body:Buffer.concat(parts).toString('utf8'),etag:value.ETag};
      }catch(error){body?.destroy?.();if(error?.$metadata?.httpStatusCode===404)return null;throw Error('Catalog S3 request stopped');}
    },
    async put(key,body,{ifMatch,signal:callerSignal}={}){
      try{
        admitted(key);ensure(key!==manifestKey&&typeof body==='string'&&Buffer.byteLength(body)<=4096&&etag(ifMatch));
        const expected=key===slugKey?{restaurantId,version:versions.at(-1),canonicalSlug:tag,tombstone:true}:{retired:true,version:snapshots.get(key)};
        ensure(isDeepStrictEqual(JSON.parse(body),expected));requests++;
        const value=await client.send(new PutObjectCommand({Bucket:'vapt-catalog-production',Key:key,Body:body,ContentType:'application/json',IfMatch:ifMatch}),{abortSignal:signal(callerSignal)});
        ensure(etag(value.ETag));return{etag:value.ETag};
      }catch(error){if(error?.$metadata?.httpStatusCode===412)return null;throw Error('Catalog S3 request stopped');}
    },
    close(){closed=true;client.destroy();credentials.accessKeyId='';credentials.secretAccessKey='';},
  };
}
