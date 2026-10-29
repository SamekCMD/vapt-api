import test from 'node:test';
import assert from 'node:assert/strict';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
const feature=async()=>{const m=await import('./catalog-writer-gate.mjs').catch(()=>({}));assert.equal(typeof m.runProductionCatalogWriterGate,'function','one-shot writer lifecycle missing');return m.runProductionCatalogWriterGate;};
const u='11111111-1111-4111-8111-111111111111',o='22222222-2222-4222-8222-222222222222',r='33333333-3333-4333-8333-333333333333',item='44444444-4444-4444-8444-444444444444';
const tag='catalog-writer-55555555-5555-4555-8555-555555555555',cookie='__Secure-better-auth.session_token=synthetic-session-value-that-stays-private',password='synthetic-password-that-stays-private',challenge='synthetic-human-challenge-that-stays-private';
const manifest={tag,users:[{id:u,name:tag,email:tag+'-0@example.invalid'}],organizations:[{id:o,name:tag,created_by:u}],restaurants:[{id:r,name:tag,slug:tag,owner_id:u,organization_id:o}],members:[{organization_id:o,user_id:u,role:'owner',status:'active'}]};
const names=['create','patch','private','mixed','delete','rebuild'],operationIds=Object.fromEntries(names.map((n,i)=>[n,`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`]));
const receipt=(name,version)=>({operationId:operationIds[name],restaurantId:r,phase:'ready',version,committed:true,retryable:false});
function fixture(){
  const events=[],http=[],credentials=[{...manifest.users[0],role:'owner',organizationId:o,password}],restaurant={id:r,name:tag,slug:tag,cnpj:null},menu={id:item,restaurantId:r,name:tag+' item',price:'12.34',available:true,variations:[{name:'Tamanho',options:['P','G'],required:true}]};
  let seeded=false,cleaned=false,loggedIn=false,loggedOut=false,retired=false,released=false,closed=false;
  const root='/restaurants/'+r;
  const steps=[
    ['POST','/api/auth/sign-in/email',200,{user:{id:u,email:manifest.users[0].email},token:'server-response-secret'}],
    ['GET',root,200,restaurant],['GET',root+'/menu-items',200,[]],
    ['POST',root+'/menu-items',201,{receipt:receipt('create','11')}],['POST',root+'/menu-items',201,{receipt:receipt('create','11')}],
    ['GET',root+'/menu-items',200,[menu]],['PATCH',root+'/menu-items/'+item,200,{receipt:receipt('patch','12')}],
    ['GET',root+'/menu-items',200,[{...menu,available:false,variations:[{name:'Tamanho',options:['M'],required:false}]}]],
    ['PATCH',root,200,{receipt:receipt('private',null)}],['PATCH',root,200,{receipt:receipt('mixed','13')}],
    ['GET',root,200,{...restaurant,description:tag+' public'}],['DELETE',root+'/menu-items/'+item,200,{receipt:receipt('delete','14')}],
    ['GET',root+'/menu-items',200,[]],['POST',root+'/catalog/rebuild',200,{receipt:receipt('rebuild','15')}],
    ['GET',root+'/catalog-operations/'+operationIds.rebuild,200,receipt('rebuild','15')],['POST',root+'/catalog-operations/'+operationIds.rebuild+'/retry',200,receipt('rebuild','15')],
  ];
  const options={baseUrl:'https://api.vapt.app.br',operationIds:structuredClone(operationIds),pace:async()=>{},
    preflight:async phase=>{events.push('preflight:'+phase);},record:async(event,value)=>{events.push('journal:'+event);assert.doesNotMatch(JSON.stringify(value??{}),/synthetic-password|synthetic-session|synthetic-human|server-response-secret/);},
    captcha:async value=>{assert.equal(value.index,0);assert.equal(value.role,'owner');assert.ok(value.signal);events.push('human');return challenge;},
    driver:{identifiers:()=>structuredClone(manifest),async seed(){assert.equal(seeded,false);assert.ok(events.includes('journal:seed_attempt'));seeded=true;events.push('seed');return credentials;},
      async cleanup(){assert.equal(retired,true);assert.equal(loggedOut,true);cleaned=true;events.push('cleanup');return{rows:0};},async close(){closed=true;events.push('close');}},
    storage:{async ready(){events.push('storage_ready');return{bucket:'vapt-catalog-production',expiresAt:Date.now()+900000};},
      async retire(value){assert.equal(loggedOut,true);assert.equal(value.probe.ok,true);assert.equal(value.manifest.restaurants[0].id,r);assert.deepEqual(value.operationIds,operationIds);
        assert.deepEqual(await value.verifyLoggedOut(),{status:401});retired=true;events.push('retire');return{restaurantId:r,journalRows:0,revisionRows:0,readbackConfirmed:true,objectWrites:3,retainedFenceBytes:900};},
      async revoke(){released=true;events.push('revoke');return{revoked:true};},close(){events.push('storage_close');}},
    fetcher:async(url,init)=>{
      const path=new URL(url).pathname;assert.equal(new URL(url).origin,'https://api.vapt.app.br');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');http.push([init.method,path]);
      if(path==='/api/auth/sign-out'){assert.equal(loggedOut,false);assert.equal(init.headers.Cookie,cookie);loggedOut=true;return Response.json({success:true});}
      if(path==='/auth/me'){assert.equal(loggedOut,true);assert.equal(init.headers.Cookie,cookie);return Response.json({code:'unauthorized'},{status:401});}
      const next=steps.shift();assert.ok(next,'unexpected API request');assert.deepEqual([init.method,path],next.slice(0,2));
      if(path==='/api/auth/sign-in/email'){
        assert.equal(seeded,true);assert.equal(loggedIn,false);loggedIn=true;assert.deepEqual(JSON.parse(init.body),{email:manifest.users[0].email,password});assert.equal(init.headers['X-Captcha-Response'],challenge);
      }else{assert.equal(init.headers.Cookie,cookie);assert.ok(events.includes('preflight:before_probe'));}
      return next[2]===204?new Response(null,{status:204}):Response.json(next[3],{status:next[2],headers:path==='/api/auth/sign-in/email'?{'set-cookie':cookie+'; Path=/; Secure; HttpOnly; SameSite=Lax'}:{}});
    }};
  return{options,events,http,credentials,steps,state:()=>({seeded,cleaned,loggedIn,loggedOut,retired,released,closed})};
}

async function imageFixture(){
  const f=fixture(),root='/restaurants/'+r,path=root+'/branding/image',key=r+'/branding/'+item;
  const ids={rebuild:operationIds.rebuild,oversized:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',upload:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'};
  f.options.operationIds=ids;
  const client=new S3Client({endpoint:'https://3ce69408aa5112617a282957aba71932.r2.cloudflarestorage.com',region:'auto',requestChecksumCalculation:'WHEN_REQUIRED',credentials:{accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64)}});
  let signed;try{signed=await getSignedUrl(client,new PutObjectCommand({Bucket:'vapt-assets-production',Key:key,ContentType:'image/webp',ContentLength:42,IfMatch:'"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'}),{expiresIn:300,signableHeaders:new Set(['content-length','content-type','if-match'])});}finally{client.destroy();}
  const descriptor={state:'upload_required',method:'PUT',objectKey:key,publicUrl:'https://pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev/'+key,
    uploadUrl:signed,headers:{'Content-Type':'image/webp','If-Match':'"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'},expiresInSeconds:300};
  const scope={id:r,name:tag,slug:tag,description:null,logoUrl:null},uploaded={state:'uploaded',objectKey:key,publicUrl:descriptor.publicUrl};
  f.steps.splice(1,f.steps.length-1,
    ['GET',root,200,scope],['GET',root+'/menu-items',200,[]],['POST',root+'/catalog/rebuild',200,{receipt:receipt('rebuild','15')}],['GET',root+'/catalog-operations/'+ids.rebuild,200,receipt('rebuild','15')],
    ['GET',root,200,scope],['POST',path+'/upload',400,{error:{code:'invalid_request'}}],['POST',path+'/upload',200,descriptor],
    ['POST',path+'/upload',200,uploaded],['POST',path+'/upload',200,uploaded],['DELETE',path,204,null],['POST',path+'/upload',410,{error:{code:'menu_image_upload_expired'}}]);
  const fetcher=f.options.fetcher,retire=f.options.storage.retire,network=[],fault={};let puts=0;
  f.options.fetcher=async(url,init)=>{
    network.push([init.method,new URL(url).pathname]);
    if(url===signed){assert.equal(init.method,'PUT');assert.equal(init.headers.Cookie,undefined);puts++;if(fault.lostPut)throw Error('lost private signed request');return new Response(null,{status:puts===1?200:412});}
    if(new URL(url).pathname===path+'/upload')assert.ok(f.events.includes('preflight:before_image'));
    return fetcher(url,init);
  };
  f.options.storage.retire=async value=>{
    assert.deepEqual(value.operationIds,{rebuild:ids.rebuild});assert.equal(value.probe.receipts.length,1);assert.equal(value.imageProbe.ok,true);assert.equal(value.imageProbe.objectKey,key);
    return{...await retire({...value,operationIds}),imageAbsentConfirmed:!fault.missingReadback};
  };
  return{...f,network,fault};
}
const imageFeature=async()=>{const m=await import('./catalog-writer-gate.mjs');assert.equal(typeof m.runProductionCatalogImageGate,'function','image lifecycle not integrated');return m.runProductionCatalogImageGate;};
test('image gate uses one baseline and real lease probe before logout, retirement, cleanup and revocation',async()=>{
  const run=await imageFeature(),f=await imageFixture(),result=await run(f.options);
  assert.equal(result.ok,true);assert.equal(result.probe.requests,4);assert.equal(result.imageProbe.requests,10);assert.equal(result.authRequests,4);assert.equal(f.network.length,18);
  assert.equal(f.steps.length,0);assert.equal(result.cleaned,true);assert.equal(result.retired.imageAbsentConfirmed,true);assert.equal(f.credentials[0].password,'');
  assert.equal(f.network.filter(([method,path])=>method==='POST'&&path.endsWith('/catalog/rebuild')).length,1);
  assert.equal(f.network.some(([method,path])=>method==='PATCH'||path.includes('/menu-items/')),false);assert.doesNotMatch(JSON.stringify(result),/X-Amz|synthetic-session|synthetic-password/);
});
for(const kind of ['before-image','pending-baseline','lost-put','missing-readback'])test(`image gate ${kind} preserves fixture, logs out and revokes without retry`,async()=>{
  const run=await imageFeature(),f=await imageFixture();
  if(kind==='before-image'){const pre=f.options.preflight;f.options.preflight=async(...args)=>{await pre(...args);if(args[0]==='before_image')throw Error('baseline not proven');};}
  if(kind==='pending-baseline')f.steps[4][3]={...receipt('rebuild','15'),phase:'committed',retryable:true};
  if(kind==='lost-put')f.fault.lostPut=true;
  if(kind==='missing-readback')f.fault.missingReadback=true;
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.cleaned,false);assert.equal(result.sessionRevoked,true);assert.equal(result.credentialRevoked,true);
  assert.equal(f.events.filter(v=>v==='revoke').length,1);assert.equal(f.network.filter(([method])=>method==='PUT').length,kind==='lost-put'?1:kind==='missing-readback'?3:0);
  if(kind==='pending-baseline'||kind==='lost-put'||kind==='missing-readback')assert.equal(result.uncertain,true);
});
test('one-owner gate runs real HTTP probe, logout401, target retirement, cleanup and credential revocation in order',async()=>{
  const run=await feature(),f=fixture(),result=await run(f.options);
  assert.equal(result.ok,true);assert.equal(result.cleaned,true);assert.equal(result.sessionRevoked,true);assert.equal(result.credentialRevoked,true);assert.equal(result.probe.requests,15);assert.equal(result.authRequests,4);assert.equal(f.http.length,19);
  assert.deepEqual(f.state(),{seeded:true,cleaned:true,loggedIn:true,loggedOut:true,retired:true,released:true,closed:true});assert.equal(f.credentials[0].password,'');
  assert.ok(f.events.indexOf('journal:seed_attempt')<f.events.indexOf('seed'));assert.ok(f.events.indexOf('retire')<f.events.indexOf('cleanup'));assert.ok(f.events.indexOf('cleanup')<f.events.indexOf('revoke'));
  assert.doesNotMatch(JSON.stringify(result),/synthetic-password|synthetic-session|synthetic-human|server-response-secret/);
});
for(const kind of ['preflight','storage-not-ready','dummy-captcha','journal-collision'])test(`${kind} stops before seed or login and still releases owned resources`,async()=>{
  const run=await feature(),f=fixture();
  if(kind==='preflight')f.options.preflight=async()=>{throw Error('private-provider-error');};
  if(kind==='storage-not-ready')f.options.storage.ready=async()=>({bucket:'vapt-assets-production',expiresAt:Date.now()+900000});
  if(kind==='dummy-captcha')f.options.captcha=async()=> 'XXXX.DUMMY.TOKEN.XXXX';
  if(kind==='journal-collision')f.options.record=async()=>{throw Error('existing journal');};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.state().seeded,false);assert.equal(f.http.length,0);assert.equal(f.state().released,true);assert.equal(f.state().closed,true);
});
test('seed COMMIT uncertainty never reseeds or automatically cleans identities',async()=>{
  const run=await feature(),f=fixture();let seeds=0;f.options.driver.seed=async()=>{seeds++;throw Object.assign(Error('private seed diagnostic'),{safeCode:'tenant_seed_uncertain'});};
  const result=await run(f.options);assert.equal(seeds,1);assert.equal(result.uncertain,true);assert.equal(result.cleaned,false);assert.equal(f.http.length,0);assert.equal(f.state().released,true);
});
test('malformed seed credentials cannot interrupt credential revocation or driver close',async()=>{
  const run=await feature(),f=fixture();f.options.driver.seed=async()=>[null];
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.state().released,true);assert.equal(f.state().closed,true);assert.equal(f.http.length,0);
});
test('cancellation during an in-flight seed is uncertain and wipes credentials returned after cancellation',async()=>{
  const run=await feature(),f=fixture(),abort=new AbortController(),seed=f.options.driver.seed;f.options.signal=abort.signal;
  f.options.driver.seed=async()=>{const result=await seed();abort.abort();return result;};
  const result=await run(f.options);assert.equal(result.uncertain,true);assert.equal(result.cleaned,false);assert.equal(f.http.length,0);assert.equal(f.credentials[0].password,'');assert.equal(f.state().released,true);
});
test('lost login response is not retried and never triggers catalog or identity cleanup',async()=>{
  const run=await feature(),f=fixture();let calls=0;f.options.fetcher=async()=>{calls++;throw Error('private login diagnostic');};
  const result=await run(f.options);assert.equal(calls,1);assert.equal(result.uncertain,true);assert.equal(result.cleaned,false);assert.equal(f.state().retired,false);assert.equal(f.state().released,true);assert.equal(f.credentials[0].password,'');
});
test('failed catalog mutation logs out once but does not discard unresolved journal or fixture',async()=>{
  const run=await feature(),f=fixture(),fetcher=f.options.fetcher;
  f.options.fetcher=async(url,init)=>{if(init.method==='POST'&&url.endsWith('/menu-items'))throw Error('lost command response');return fetcher(url,init);};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.probe.uncertain,true);assert.equal(result.sessionRevoked,true);assert.equal(f.state().retired,false);assert.equal(f.state().cleaned,false);assert.equal(f.http.filter(v=>v[1]==='/api/auth/sign-out').length,1);assert.equal(f.state().released,true);
});
test('lost logout response is not retried, and blocks retirement',async()=>{
  const run=await feature(),f=fixture(),fetcher=f.options.fetcher;let logouts=0;
  f.options.fetcher=async(url,init)=>{if(url.endsWith('/api/auth/sign-out')){logouts++;throw Error('lost logout');}return fetcher(url,init);};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(logouts,1);assert.equal(result.sessionRevoked,false);assert.equal(f.state().retired,false);assert.equal(f.state().cleaned,false);assert.equal(f.state().released,true);
});
test('uncertain R2 retirement never triggers fixture cleanup but does revoke the test credential',async()=>{
  const run=await feature(),f=fixture();f.options.storage.retire=async()=>{throw Object.assign(Error('private storage failure'),{safeCode:'catalog_writer_retirement_uncertain'});};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(result.cleaned,false);assert.equal(f.state().released,true);
});
test('unconfirmed credential revocation makes an otherwise successful run incomplete',async()=>{
  const run=await feature(),f=fixture();f.options.storage.revoke=async()=>({revoked:false});
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.cleaned,true);assert.equal(result.credentialRevoked,false);
});

test('credential revocation reserves enough time for human confirmation and one propagation-delayed verification',async t=>{
  const run=await feature(),f=fixture(),pending=[];let clock=0;
  t.mock.method(AbortSignal,'timeout',milliseconds=>{const c=new AbortController();pending.push({at:clock+milliseconds,c});return c.signal;});
  f.options.storage.revoke=async()=>{clock+=125000;for(const timer of pending)if(timer.at<=clock)timer.c.abort();return{revoked:true};};
  const result=await run(f.options);assert.equal(result.credentialRevoked,true);assert.equal(result.ok,true);
});
test('uncertain identity-cleanup COMMIT is never retried and still releases storage',async()=>{
  const run=await feature(),f=fixture();let cleanups=0;
  f.options.driver.cleanup=async()=>{cleanups++;throw Error('Synthetic lost cleanup commit');};
  const result=await run(f.options);assert.equal(cleanups,1);assert.equal(result.uncertain,true);assert.equal(result.cleaned,false);assert.equal(f.state().released,true);
});
test('abort while a human challenge never resolves stops before seed and releases storage',async()=>{
  const run=await feature(),f=fixture(),abort=new AbortController();f.options.signal=abort.signal;
  f.options.captcha=()=>{abort.abort();return new Promise(()=>{});};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.state().seeded,false);assert.equal(f.http.length,0);assert.equal(f.state().released,true);assert.equal(f.state().closed,true);
});

for(const phase of ['retirement','fixture_cleanup'])test(`abort during ${phase} drains the mutator before revoking or closing shared resources`,async()=>{
  const run=await feature(),f=fixture(),abort=new AbortController();f.options.signal=abort.signal;
  let enter,release,seenSignal;const entered=new Promise(ok=>{enter=ok;}),held=new Promise(ok=>{release=ok;});
  const blocked=async value=>{seenSignal=value?.signal;enter();await held;throw Error('Synthetic cancelled mutation');};
  if(phase==='retirement')f.options.storage.retire=blocked;else f.options.driver.cleanup=blocked;
  const pending=run(f.options);await entered;abort.abort();await new Promise(ok=>setImmediate(ok));
  try{assert.equal(f.state().released,false,'revocation must wait for rollback/drain');assert.equal(f.state().closed,false);assert.equal(seenSignal?.aborted,true);}
  finally{release();}
  const result=await pending;assert.equal(result.uncertain,true);assert.equal(result.cleaned,false);assert.equal(f.state().released,true);assert.equal(f.state().closed,true);
});
