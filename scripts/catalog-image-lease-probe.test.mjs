import test from 'node:test';
import assert from 'node:assert/strict';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
const restaurant='11111111-1111-4111-8111-111111111111',item='22222222-2222-4222-8222-222222222222';
const tag='catalog-writer-33333333-3333-4333-8333-333333333333',object='44444444-4444-4444-8444-444444444444';
const operationIds={oversized:'55555555-5555-4555-8555-555555555555',upload:'66666666-6666-4666-8666-666666666666'};
const account='3ce69408aa5112617a282957aba71932',bucket='vapt-assets-production',publicOrigin='https://pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev';
const cookie='__Secure-better-auth.session_token=synthetic-private-session-value',etag='"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
const feature=async()=>{const m=await import('./catalog-image-lease-probe.mjs').catch(()=>({}));assert.equal(typeof m.runProductionCatalogImageLeaseProbe,'function','bounded image lease probe missing');return m.runProductionCatalogImageLeaseProbe;};
async function fixture(itemId='branding'){
  const key=`${restaurant}/${itemId}/${object}`,path=`/restaurants/${restaurant}/${itemId==='branding'?'branding':`menu-items/${itemId}`}/image`;
  const client=new S3Client({endpoint:`https://${account}.r2.cloudflarestorage.com`,region:'auto',requestChecksumCalculation:'WHEN_REQUIRED',credentials:{accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64)}});
  let signed;try{signed=await getSignedUrl(client,new PutObjectCommand({Bucket:bucket,Key:key,ContentType:'image/webp',ContentLength:42,IfMatch:etag}),{expiresIn:300,signableHeaders:new Set(['content-length','content-type','if-match'])});}finally{client.destroy();}
  const calls=[],fault={},state={uploaded:false,retired:false,preflights:0};
  const options={baseUrl:'https://api.vapt.app.br',restaurantId:restaurant,itemId,tag,operationIds:structuredClone(operationIds),cookie,pace:async()=>{},preflight:async()=>{state.preflights++;},
    fetcher:async(url,init)=>{
      const target=new URL(url);calls.push({url,method:init.method,headers:{...init.headers},body:init.body,credentials:init.credentials,redirect:init.redirect,signal:init.signal});
      assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert(init.signal instanceof AbortSignal);
      if(target.origin!=='https://api.vapt.app.br'){
        assert.equal(target.hostname,`${bucket}.${account}.r2.cloudflarestorage.com`);assert.equal(target.pathname,'/'+key);assert.equal(url,signed);
        assert.equal(init.method,'PUT');assert.deepEqual(init.headers,{'Content-Type':'image/webp','If-Match':etag});
        const bytes=Buffer.from(init.body);assert.equal(bytes.length,42);assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
        if(fault.lostPut)throw Error('synthetic signed URL or secret diagnostic must not escape');
        if(!state.uploaded&&!state.retired){state.uploaded=true;return new Response(null,{status:200});}
        return new Response('<Error><Code>PreconditionFailed</Code></Error>',{status:fault.staleAccepted?200:412});
      }
      assert.equal(init.headers.Cookie,cookie);assert.equal(init.headers.Origin,'https://vapt.app.br');
      if(init.method==='GET'&&target.pathname===`/restaurants/${restaurant}`)return fault.scopeResponse?.()??Response.json({id:restaurant,name:fault.foreign?'Real restaurant':tag,slug:tag,logoUrl:null});
      if(init.method==='GET'&&target.pathname===`/restaurants/${restaurant}/menu-items`)return Response.json([{id:item,restaurantId:restaurant,name:tag+' image item',imageUrl:null}]);
      if(init.method==='POST'){
        assert.equal(target.pathname,path+'/upload');assert.equal(init.headers['X-Vapt-Catalog-Protocol'],'1');const body=JSON.parse(init.body);
        if(init.headers['Idempotency-Key']===operationIds.oversized){assert.deepEqual(body,{contentType:'image/webp',contentLength:1048577});return Response.json({error:{code:'invalid_request',message:'Invalid request'}},{status:fault.oversizedAccepted?200:400});}
        assert.equal(init.headers['Idempotency-Key'],operationIds.upload);assert.deepEqual(body,{contentType:'image/webp',contentLength:42});
        if(state.retired)return Response.json({error:{code:'menu_image_upload_expired',message:'Image upload expired'}},{status:410});
        const descriptor={state:'upload_required',method:'PUT',objectKey:key,publicUrl:publicOrigin+'/'+key,uploadUrl:signed,headers:{'Content-Type':'image/webp','If-Match':etag},expiresInSeconds:300};
        if(state.uploaded)return Response.json({state:'uploaded',objectKey:fault.changedKey?key+'-changed':key,publicUrl:publicOrigin+'/'+key});
        fault.descriptor?.(descriptor);return Response.json(descriptor);
      }
      assert.equal(init.method,'DELETE');assert.equal(target.pathname,path);assert.deepEqual([...target.searchParams],[['objectKey',key]]);
      if(fault.lostRetire)throw Error('synthetic deletion uncertainty');state.retired=true;return new Response(null,{status:204});
    }};
  return{options,state,calls,fault,key,path};
}
for(const target of ['branding',item])test(`bounded ${target==='branding'?'logo':'item'} lease checks size denial, signed upload, replay, retirement and no resurrection`,async()=>{
  const run=await feature(),f=await fixture(target),result=await run(f.options);
  assert.equal(result.ok,true);assert.equal(result.uncertain,false);assert.equal(result.leaseRetired,true);assert.equal(result.imageBytes,42);assert.equal(result.requests,target==='branding'?10:11);
  assert.equal(f.state.preflights,1);assert.equal(f.state.retired,true);assert.equal(f.calls.filter(c=>c.method==='PUT').length,3);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
  assert.equal(f.calls[0].method,'GET');assert.doesNotMatch(JSON.stringify(result),/X-Amz|synthetic-private|Signature|synthetic deletion/);
});
for(const [name,change]of [
  ['foreign origin',o=>{o.baseUrl='https://other.invalid';}],['missing session',o=>{o.cookie='';}],['unmarked fixture',o=>{o.tag='Real restaurant';}],
  ['duplicate leases',o=>{o.operationIds.oversized=o.operationIds.upload;}],['missing preflight',o=>{delete o.preflight;}],['abort',o=>{o.signal=AbortSignal.abort();}],
])test(`invalid ${name} makes no request`,async()=>{
  const run=await feature(),f=await fixture();change(f.options);const result=await run(f.options);assert.equal(result.ok,false);assert.deepEqual(f.calls,[]);
});
for(const [name,change]of [
  ['foreign host',d=>{const u=new URL(d.uploadUrl);u.hostname='foreign.invalid';d.uploadUrl=u.href;}],
  ['preview bucket',d=>{d.uploadUrl=d.uploadUrl.replace('vapt-assets-production.','vapt-assets-preview.');}],
  ['foreign key',d=>{d.objectKey=keyForForeign();}],
  ['missing signed CAS',d=>{const u=new URL(d.uploadUrl);u.searchParams.set('X-Amz-SignedHeaders','content-length;content-type;host');d.uploadUrl=u.href;}],
  ['weak ETag',d=>{d.headers['If-Match']='W/'+etag;}],
  ['extra authorization',d=>{d.headers.Authorization='do-not-forward';}],
  ['public URL alias',d=>{d.publicUrl=d.publicUrl.replace(publicOrigin,'https://foreign.invalid');}],
  ['expired signature',d=>{const u=new URL(d.uploadUrl);u.searchParams.set('X-Amz-Date','20000101T000000Z');d.uploadUrl=u.href;}],
])test(`unsafe descriptor ${name} stops before signed PUT or deletion`,async()=>{
  const run=await feature(),f=await fixture();f.fault.descriptor=change;const result=await run(f.options);
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(f.calls.some(c=>c.method==='PUT'||c.method==='DELETE'),false);assert.doesNotMatch(JSON.stringify(result),/X-Amz|do-not-forward/);
});
function keyForForeign(){return `77777777-7777-4777-8777-777777777777/branding/${object}`;}
for(const name of ['lostPut','staleAccepted','changedKey','lostRetire'])test(`${name} stops without transport retries or subsequent cleanup`,async()=>{
  const run=await feature(),f=await fixture();f.fault[name]=true;const result=await run(f.options);
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,name==='lostRetire'?1:0);
  if(name==='lostPut')assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
  if(name==='lostRetire')assert.equal(f.calls.at(-1).method,'DELETE');
  assert.doesNotMatch(JSON.stringify(result),/synthetic deletion|signed URL or secret/);
});
test('foreign fixture stops on the read-only scope check',async()=>{
  const run=await feature(),f=await fixture();f.fault.foreign=true;const result=await run(f.options);assert.equal(result.ok,false);assert(f.calls.every(c=>c.method==='GET'));
});

test('a scope body over64KiB is cancelled before any reservation',async()=>{
  const run=await feature(),f=await fixture();let cancelled=false;
  f.fault.scopeResponse=()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}));
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(cancelled,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
});

test('abort while waiting for a response body cancels the reader and returns without another request',async()=>{
  const run=await feature(),f=await fixture(),abort=new AbortController();f.options.signal=abort.signal;
  let enter,controller,cancelled=false;const entered=new Promise(ok=>{enter=ok;});
  // No eager buffering: enter only when the probe actually requests body bytes,
  // not when fetch constructs a response that may still be pending.
  f.fault.scopeResponse=()=>new Response(new ReadableStream({start(c){controller=c;},pull(){enter();},cancel(){cancelled=true;}},{highWaterMark:0}));
  const pending=run(f.options);await entered;abort.abort();let timer;
  try{const result=await Promise.race([pending,new Promise(ok=>{timer=setTimeout(()=>ok('timed-out'),100);})]);assert.notEqual(result,'timed-out','body wait must observe cancellation');assert.equal(result.ok,false);assert.equal(cancelled,true);assert.equal(f.calls.length,1);}
  finally{clearTimeout(timer);if(!cancelled)controller.error(Error('Release test stream'));await pending;}
});

for(const boundary of ['preflight','pace','fetcher'])test(`abort bounds a stalled ${boundary} callback without starting subsequent requests`,async()=>{
  const run=await feature(),f=await fixture(),abort=new AbortController();f.options.signal=abort.signal;
  let enter,release,seenSignal,timer;const entered=new Promise(ok=>{enter=ok;}),held=new Promise(ok=>{release=ok;});
  f.options[boundary]=(...args)=>{seenSignal=boundary==='fetcher'?args[1].signal:args[0]?.signal;enter();return held;};
  const pending=run(f.options);await entered;abort.abort();
  try{const result=await Promise.race([pending,new Promise(ok=>{timer=setTimeout(()=>ok('timed-out'),100);})]);assert.notEqual(result,'timed-out',`${boundary} wait must observe cancellation`);assert.equal(result.ok,false);assert.equal(seenSignal?.aborted,true);assert.equal(result.requests,boundary==='fetcher'?1:0);}
  finally{clearTimeout(timer);release(boundary==='fetcher'?Response.json({}):undefined);await pending;}
});
