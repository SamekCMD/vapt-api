import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
const feature=async()=>{const m=await import('./catalog-writer-s3-store.mjs').catch(()=>({}));assert.equal(typeof m.createProductionCatalogWriterS3Store,'function','bounded S3 retirement transport missing');return m.createProductionCatalogWriterS3Store;};
const id='11111111-1111-4111-8111-111111111111',tag='catalog-writer-22222222-2222-4222-8222-222222222222',versions=['11','12','13','14','15'];
const prefix=`catalog/v1/production/restaurants/${id}/`,key=prefix+'snapshots/15.json',etag='"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';
function fixture(handler){
  const requests=[];const options={restaurantId:id,tag,versions,accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64),expiresAt:Date.now()+900000,
    requestHandler:{async handle(request,{abortSignal}){
      requests.push(request);assert.equal(request.hostname,'3ce69408aa5112617a282957aba71932.r2.cloudflarestorage.com');assert.ok(abortSignal);
      assert.match(request.headers.authorization,/^AWS4-HMAC-SHA256 Credential=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\//);
      return{response:await handler(request)};
    },destroy(){}}};return{options,requests};
}
const response=(body,statusCode=200,headers={})=>({statusCode,headers:{etag,'content-type':'application/json',...headers},body:Readable.from([Buffer.from(body)])});
test('S3 reads only explicit production keys with real SDK signing, bounded body and quoted ETag',async()=>{
  const create=await feature(),f=fixture(async request=>{assert.equal(request.method,'GET');assert.equal(request.path,'/vapt-catalog-production/'+key);return response('{"retired":true,"version":"15"}');});
  const store=create(f.options);try{assert.deepEqual(await store.get(key,{maxBytes:4096}),{body:'{"retired":true,"version":"15"}',etag});assert.equal(f.requests.length,1);}finally{store.close();}
});
test('S3 retirement sends If-Match atomically and only small owned fence bytes',async()=>{
  const create=await feature(),body='{"retired":true,"version":"15"}',f=fixture(async request=>{
    assert.equal(request.method,'PUT');assert.equal(request.headers['if-match'],etag);assert.equal(request.body,body);return response('');
  });const store=create(f.options);try{assert.deepEqual(await store.put(key,body,{ifMatch:etag}),{etag});assert.equal(f.requests.length,1);}finally{store.close();}
});
test('S3 412 is an explicit failed CAS and is not retried',async()=>{
  const create=await feature(),f=fixture(async()=>response('<Error><Code>PreconditionFailed</Code></Error>',412,{'content-type':'application/xml'}));const store=create(f.options);
  try{assert.equal(await store.put(key,'{"retired":true,"version":"15"}',{ifMatch:etag}),null);assert.equal(f.requests.length,1);}finally{store.close();}
});
test('revocation verification requires an actual S3 403 and is not a generic error success',async()=>{
  const create=await feature(),f=fixture(async request=>{assert.equal(request.method,'GET');assert.equal(request.path,`/vapt-catalog-production/catalog/v1/production/slugs/${tag}.json`);return response('<Error><Code>AccessDenied</Code></Error>',403,{'content-type':'application/xml'});}),store=create(f.options);
  try{assert.equal(typeof store.verifyRevoked,'function');assert.deepEqual(await store.verifyRevoked(),{revoked:true});assert.equal(f.requests.length,1);}finally{store.close();}
});
test('an authorized missing object is not proof that the credential was revoked',async()=>{
  const create=await feature(),f=fixture(async()=>response('<Error><Code>NoSuchKey</Code></Error>',404,{'content-type':'application/xml'})),store=create(f.options);
  try{assert.equal(typeof store.verifyRevoked,'function');assert.deepEqual(await store.verifyRevoked(),{revoked:false});assert.equal(f.requests.length,1);}finally{store.close();}
});
test('a provider failure never masquerades as confirmed revocation',async()=>{
  const create=await feature(),f=fixture(async()=>response('<Error><Code>InternalError</Code></Error>',500,{'content-type':'application/xml'})),store=create(f.options);
  try{assert.equal(typeof store.verifyRevoked,'function');await assert.rejects(()=>store.verifyRevoked(),e=>e.message==='Catalog S3 revocation check stopped');assert.equal(f.requests.length,1);}finally{store.close();}
});
test('S3 service failures never retry or expose provider messages',async()=>{
  const create=await feature(),f=fixture(async()=>response('<Error><Code>InternalError</Code><Message>provider-secret-diagnostic</Message></Error>',500,{'content-type':'application/xml'}));const store=create(f.options);
  try{await assert.rejects(()=>store.get(key),e=>e.message==='Catalog S3 request stopped');assert.equal(f.requests.length,1);}finally{store.close();}
});
test('S3 response stream exceeding the declared bound is stopped',async()=>{
  const create=await feature(),f=fixture(async()=>response('x'.repeat(4097)));const store=create(f.options);
  try{await assert.rejects(()=>store.get(key,{maxBytes:4096}));assert.equal(f.requests.length,1);}finally{store.close();}
});
for(const kind of ['oversized-content-length','invalid-etag'])test(`S3 closes the unread body when rejecting ${kind}`,async()=>{
  const create=await feature();let received;
  const f=fixture(async()=>{const result=response('{}',200,kind==='invalid-etag'?{etag:'invalid'}:{'content-length':'65537'});received=result.body;return result;});
  const store=create(f.options);try{await assert.rejects(()=>store.get(key));assert.equal(received.destroyed,true,'rejected response must not leave its unread body open');}finally{store.close();}
});
test('foreign keys, manifest writes, non-fences and missing CAS are refused before network',async()=>{
  const create=await feature(),f=fixture(async()=>{throw Error('unexpected');});const store=create(f.options);
  try{
    await assert.rejects(()=>store.get('catalog/v1/preview/restaurants/'+id+'/snapshots/15.json'));
    await assert.rejects(()=>store.put(prefix+'manifest.json','{}',{ifMatch:etag}));
    await assert.rejects(()=>store.put(key,'{"version":"15","catalog":{}}',{ifMatch:etag}));
    await assert.rejects(()=>store.put(key,'{"retired":true,"version":"15"}',{}));
    await assert.rejects(()=>store.put(`catalog/v1/production/slugs/${tag}.json`,JSON.stringify({restaurantId:id,version:'15',canonicalSlug:tag,tombstone:false}),{ifMatch:etag}));
    assert.equal(f.requests.length,0);
  }finally{store.close();}
});
test('expired, overlong or incomplete credentials and unordered versions are refused without a transport call',async()=>{
  const create=await feature(),f=fixture(async()=>{throw Error('unexpected');});
  for(const patch of [{expiresAt:Date.now()-1},{expiresAt:Date.now()+3600000},{secretAccessKey:''},{versions:['11','12','12','14','15']}])assert.throws(()=>create({...f.options,...patch}));
  assert.equal(f.requests.length,0);
});
test('closing the transport prevents all further signed requests',async()=>{
  const create=await feature(),f=fixture(async()=>response('{}')),store=create(f.options);store.close();
  await assert.rejects(()=>store.get(key));await assert.rejects(()=>store.put(key,'{"retired":true,"version":"15"}',{ifMatch:etag}));assert.equal(f.requests.length,0);
});

test('the full work deadline reserves ten minutes for revocation without extending the local credential cutoff',async t=>{
  const module=await import('./catalog-writer-s3-store.mjs');assert.equal(typeof module.productionCatalogWriterCredentialWindow,'function','credential cleanup reserve missing');
  const received=Date.now();let now=received;t.mock.method(Date,'now',()=>now);
  const window=module.productionCatalogWriterCredentialWindow(received);assert.deepEqual(window,{workExpiresAt:received+1200000,expiresAt:received+1800000});
  const f=fixture(async()=>response('<Error><Code>AccessDenied</Code></Error>',403,{'content-type':'application/xml'}));
  const store=module.createProductionCatalogWriterS3Store({...f.options,expiresAt:window.expiresAt});
  try{now=window.workExpiresAt+1;assert.deepEqual(await store.verifyRevoked(),{revoked:true});now=window.expiresAt;await assert.rejects(store.verifyRevoked());assert.equal(f.requests.length,1,'no signed request after the local cutoff');}
  finally{store.close();}
});
