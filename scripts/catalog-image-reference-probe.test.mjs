import test from 'node:test';
import assert from 'node:assert/strict';
const restaurantId='11111111-1111-4111-8111-111111111111',item='22222222-2222-4222-8222-222222222222';
const tag='catalog-writer-33333333-3333-4333-8333-333333333333',objectId='44444444-4444-4444-8444-444444444444';
const operationIds={attach:'55555555-5555-4555-8555-555555555555',detach:'66666666-6666-4666-8666-666666666666',advance:'77777777-7777-4777-8777-777777777777'};
const cookie='__Secure-better-auth.session_token=synthetic-private-session-value';
const origin='https://pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev';
const feature=async()=>{const m=await import('./catalog-image-reference-probe.mjs').catch(()=>({}));assert.equal(typeof m.runProductionCatalogImageReferenceProbe,'function','bounded attached-image proof missing');return m.runProductionCatalogImageReferenceProbe;};
function fixture(itemId='branding'){
  const objectKey=restaurantId+'/'+itemId+'/'+objectId,publicUrl=origin+'/'+objectKey,root='/restaurants/'+restaurantId;
  const resource=itemId==='branding'?root:root+'/menu-items/'+itemId,imagePath=itemId==='branding'?root+'/branding/image':resource+'/image';
  const calls=[],fault={},states=[],readbacks=[],privateReads=[];let currentUrl=null,revision=9007199254740993n,mutations=0,deleted=false;
  const targetItems=()=>itemId==='branding'?[]:[{id:itemId,restaurantId,name:tag+' image item',imageUrl:currentUrl}];
  const snapshot=v=>({version:String(v),catalog:{restaurant:{id:restaurantId,name:tag,slug:tag,logoUrl:itemId==='branding'?currentUrl:null},items:targetItems()}});
  states.push(snapshot(revision));
  const receipt=(id,v,phase='ready')=>({operationId:id,restaurantId,phase,version:v,committed:true,retryable:phase!=='ready'});
  const options={baseUrl:'https://api.vapt.app.br',restaurantId,itemId,tag,cookie,objectKey,publicUrl,baselineVersion:'9007199254740993',operationIds:structuredClone(operationIds),pace:async()=>{},waitPending:async()=>{},
    preflight:async()=>{},
    imageReadback:async input=>{readbacks.push(input);return{absent:deleted,bucket:'vapt-assets-production',objectKey};},
    readRetained:async input=>{
      const values=structuredClone(states.slice(0,2));fault.retained?.(values,input);
      const {readProductionCatalogImageReferences}=await import('./catalog-image-reference-readback.mjs');
      const prefix=`catalog/v1/production/restaurants/${restaurantId}/`;
      const objects=new Map([[`catalog/v1/production/slugs/${tag}.json`,{restaurantId,version:input.version,canonicalSlug:tag,tombstone:false}],
        [prefix+'manifest.json',{restaurantId,version:input.version,canonicalSlug:tag,previousVersion:input.previousVersion}],
        ...values.map(v=>[prefix+`snapshots/${v.version}.json`,v])]);
      return readProductionCatalogImageReferences({...input,tag,store:{async get(key){privateReads.push(key);return objects.has(key)?{body:JSON.stringify(objects.get(key)),etag:'unchanged'}:null;}}});
    },
    fetcher:async(url,init)=>{
      const u=new URL(url);calls.push({url,method:init.method,headers:{...init.headers},body:init.body});
      assert.equal(u.origin,'https://api.vapt.app.br');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert(init.signal instanceof AbortSignal);
      assert.equal(init.headers.Cookie,cookie);assert.equal(init.headers.Origin,'https://vapt.app.br');
      if(init.method==='GET'&&u.pathname===root)return fault.scopeResponse?.()??Response.json({id:restaurantId,name:fault.foreign? 'Real restaurant':tag,slug:tag,logoUrl:itemId==='branding'?currentUrl:null});
      if(init.method==='GET'&&u.pathname===root+'/menu-items')return Response.json(targetItems());
      if(init.method==='GET'&&u.pathname.startsWith(root+'/catalog-operations/')){
        const id=u.pathname.slice((root+'/catalog-operations/').length);return Response.json(receipt(id,String(revision),fault.pendingForever?'committed':'ready'));
      }
      if(init.method==='DELETE'){
        assert.equal(u.pathname,imagePath);assert.deepEqual([...u.searchParams],[['objectKey',objectKey]]);
        if(fault.lostDelete)throw Error('private deletion diagnostic');
        if(mutations<3&&!fault.prematureDelete)return Response.json({error:{code:'menu_image_cleanup_pending',message:'Image still referenced'}},{status:409});
        deleted=true;return new Response(null,{status:204});
      }
      assert.equal(init.headers['X-Vapt-Catalog-Protocol'],'1');
      const id=init.headers['Idempotency-Key'];assert.equal(id,Object.values(operationIds)[mutations]);
      if(fault.lostAttach)throw Error('private mutation diagnostic');
      if(mutations<2){assert.equal(init.method,'PATCH');assert.equal(u.pathname,resource);const body=JSON.parse(init.body);assert.deepEqual(body,itemId==='branding'?{logoUrl:mutations===0?publicUrl:null}:{imageUrl:mutations===0?publicUrl:null});currentUrl=mutations===0?publicUrl:null;}
      else{assert.equal(init.method,'POST');assert.equal(u.pathname,root+'/catalog/rebuild');assert.equal(init.body,'{}');}
      mutations++;revision++;states.unshift(snapshot(revision));
      const v=fault.regression?'9007199254740993':String(revision);
      return Response.json({receipt:receipt(id,v,fault.pendingForever?'committed':'ready'),result:{private:'must-not-escape'}},{status:fault.pendingForever?202:200});
    }};
  return{options,calls,fault,readbacks,privateReads,get mutations(){return mutations;},get deleted(){return deleted;}};
}
for(const profile of ['branding',item])test(`bounded ${profile==='branding'?'logo':'product'} reference cycle protects current and previous snapshots before retirement`,async()=>{
  const run=await feature(),f=fixture(profile),result=await run(f.options);
  assert.equal(result.ok,true);assert.equal(result.uncertain,false);assert.equal(result.protectedDeletions,2);assert.equal(result.imageAbsentConfirmed,true);
  assert.equal(result.restaurantId,restaurantId);assert.equal(result.itemId,profile);assert.equal(result.objectKey,f.options.objectKey);assert.equal(result.baselineVersion,'9007199254740993');
  assert.deepEqual(result.receipts.map(r=>r.version),['9007199254740994','9007199254740995','9007199254740996']);
  assert.equal(f.mutations,3);assert.equal(f.deleted,true);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,3);assert.equal(f.calls.some(c=>c.method==='PUT'),false);
  assert.equal(f.privateReads.length,18,'the real readback helper validates six exact private objects per phase');
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private|must-not-escape|private mutation/);
});
for(const [name,change] of [
  ['foreign origin',o=>{o.baseUrl='https://foreign.invalid';}],['missing cookie',o=>{o.cookie='';}],['unmarked fixture',o=>{o.tag='Real restaurant';}],
  ['foreign key',o=>{o.objectKey=item+'/branding/'+objectId;}],['duplicate operations',o=>{o.operationIds.detach=o.operationIds.attach;}],
  ['missing independent readback',o=>{delete o.readRetained;}],['foreign image URL',o=>{o.publicUrl='https://foreign.invalid/'+o.objectKey;}],
])test(`${name} rejects before any HTTP or image read`,async()=>{
  const run=await feature(),f=fixture();change(f.options);const r=await run(f.options);assert.equal(r.ok,false);assert.equal(r.uncertain,false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.readbacks,[]);
});
for(const [name,change] of [
  ['missing previous snapshot',s=>{s.pop();}],['wrong previous version',s=>{s[1].version='1';}],
  ['wrong image reference',s=>{s[0].catalog.restaurant.logoUrl=null;}],['foreign snapshot',s=>{s[0].catalog.restaurant.id=item;}],
])test(`${name} stops after attachment without deletion or automatic detach`,async()=>{
  const run=await feature(),f=fixture();f.fault.retained=change;const r=await run(f.options);assert.equal(r.ok,false);assert.equal(r.uncertain,true);assert.equal(f.mutations,1);assert.equal(f.calls.some(c=>c.method==='DELETE'),false);
});
for(const kind of ['prematureDelete','lostAttach','lostDelete','regression','pendingForever'])test(`${kind} stops without retrying mutations or discarding uncertain state`,async()=>{
  const run=await feature(),f=fixture();f.fault[kind]=true;const r=await run(f.options);assert.equal(r.ok,false);assert.equal(r.uncertain,true);
  assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  assert.equal(f.calls.filter(c=>c.method==='DELETE').length,['prematureDelete','lostDelete'].includes(kind)?1:0);
  assert.equal(f.calls.filter(c=>c.url.includes('/catalog-operations/')).length,kind==='pendingForever'?1:0);
  if(kind==='pendingForever'){assert.equal(r.receipts.length,1);assert.equal(r.receipts[0].operationId,operationIds.attach);assert.equal(r.receipts[0].phase,'committed');}
  assert.doesNotMatch(JSON.stringify(r),/private deletion|private mutation|must-not-escape|synthetic-private/);
});
test('abort during a stalled retained read stops before deleting or detaching',async()=>{
  const run=await feature(),f=fixture(),abort=new AbortController();f.options.signal=abort.signal;
  let enter,release;const entered=new Promise(ok=>{enter=ok;}),held=new Promise(ok=>{release=ok;});
  f.options.readRetained=async()=>{enter();await held;return[];};const pending=run(f.options);await entered;abort.abort();let timer;
  try{const r=await Promise.race([pending,new Promise(ok=>{timer=setTimeout(()=>ok(null),100);})]);assert(r);assert.equal(r.ok,false);assert.equal(r.uncertain,true);assert.equal(f.calls.some(c=>c.method==='DELETE'),false);}
  finally{clearTimeout(timer);release();await pending;}
});
test('a scope body over64KiB is cancelled before any attachment',async()=>{
  const run=await feature(),f=fixture();let cancelled=false;
  f.fault.scopeResponse=()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}));
  const r=await run(f.options);assert.equal(r.ok,false);assert.equal(r.uncertain,false);assert.equal(cancelled,true);assert.equal(f.mutations,0);
});
