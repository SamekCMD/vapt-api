import test from 'node:test';
import assert from 'node:assert/strict';
const r='11111111-1111-4111-8111-111111111111',item='22222222-2222-4222-8222-222222222222',object='33333333-3333-4333-8333-333333333333';
const tag='catalog-writer-44444444-4444-4444-8444-444444444444',op='55555555-5555-4555-8555-555555555555',baseUrl='https://api.vapt.app.br';
const ids=['66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888'];
const receipt=(operationId,version)=>({operationId,restaurantId:r,phase:'ready',version,committed:true,retryable:false});
async function feature(deleting=false){const m=await import('./catalog-product-image-item.mjs').catch(()=>({})),fn=m[deleting?'runProductionCatalogProductImageDeletion':'runProductionCatalogProductImageBaseline'];assert.equal(typeof fn,'function','versioned product image item transition missing');return fn;}
function fixture(deleting=false){
  const calls=[],fault={},physical=[],privateReads=[];let changed=false;
  const restaurant={id:r,name:tag,slug:tag,description:null,logoUrl:null},product={id:item,restaurantId:r,name:tag+' image item',price:'12.34',imageUrl:null};
  const version=deleting?'9007199254740997':'9007199254740993',objectKey=r+'/'+item+'/'+object;
  const options={baseUrl,restaurantId:r,tag,operationId:op,cookie:'__Secure-better-auth.session_token=synthetic-private-session-value',pace:async()=>{},waitPending:async()=>{},preflight:async()=>{},
    ...(deleting?{itemId:item,objectKey,previousVersion:'9007199254740996',imageProbe:{ok:true,uncertain:false,stage:'verified',restaurantId:r,itemId:item,objectKey,baselineVersion:'9007199254740993',protectedDeletions:2,imageAbsentConfirmed:true,receipts:ids.map((id,i)=>receipt(id,String(9007199254740994n+BigInt(i))))}}:{}),
    imageReadback:async args=>{physical.push(args);return{absent:!fault.imagePresent,bucket:'vapt-assets-production',objectKey};},
    readRetained:async args=>{privateReads.push(args);const values=[{version,catalog:{restaurant,items:[]}},{version:'9007199254740996',catalog:{restaurant,items:[product]}}];fault.states?.(values);return values;},
    fetcher:async(url,init)=>{
      calls.push({url,method:init.method,headers:{...init.headers},body:init.body});assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.ok(init.signal);
      const path=new URL(url).pathname,root='/restaurants/'+r;
      if(path===root)return Response.json({...restaurant,...fault.restaurant});
      if(path===root+'/catalog-operations/'+op)return Response.json(fault.status??receipt(op,version));
      if(init.method==='GET')return Response.json(fault.items??((deleting?!changed:changed)?[product]:[]));
      assert.equal(init.headers['X-Vapt-Catalog-Protocol'],'1');assert.equal(init.headers['Idempotency-Key'],op);
      assert.equal(init.method,deleting?'DELETE':'POST');assert.equal(path,root+'/menu-items'+(deleting?'/'+item:''));
      if(!deleting){const body=JSON.parse(init.body);assert.equal(body.name,tag+' image item');assert.equal(body.price,'12.34');assert.deepEqual(body.variations,[]);assert.equal(body.imageUrl,null);}
      else assert.equal(init.body,undefined);
      if(fault.lost)throw Error('private-wire-diagnostic');changed=true;
      return Response.json({receipt:fault.initial??receipt(op,version),result:{secret:'must-not-escape'}},{status:fault.initial?202:deleting?200:201});
    }};
  return{options,calls,fault,physical,privateReads};
}
for(const deleting of [false,true])test(`${deleting?'delete':'create'} item once through the durable writer with exact ready receipt and scope`,async()=>{
  const f=fixture(deleting),run=await feature(deleting),result=await run(f.options);
  assert.equal(result.ok,true);assert.equal(result.uncertain,false);assert.equal(result.requests,5);assert.equal(result.itemId,item);assert.equal(result.receipts.length,1);
  assert.equal(f.calls.filter(v=>v.method=== (deleting?'DELETE':'POST')).length,1);
  if(deleting){assert.equal(result.itemAbsentConfirmed,true);assert.equal(result.imageAbsentConfirmed,true);assert.equal(f.privateReads.length,1);assert.equal(f.physical.length,2);}
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private|must-not-escape/);
});
for(const deleting of [false,true])for(const kind of ['lost','pending','foreign-receipt','regression','wrong-scope'])test(`${deleting?'delete':'create'} ${kind} stops without replay or cleanup`,async()=>{
  const f=fixture(deleting),run=await feature(deleting);
  if(kind==='lost')f.fault.lost=true;
  if(kind==='pending')f.fault.initial=f.fault.status={...receipt(op,'9007199254740997'),phase:'committed',retryable:true};
  if(kind==='foreign-receipt')f.fault.initial={...receipt(op,'9007199254740997'),restaurantId:item};
  if(kind==='regression')f.fault.status=receipt(op,'9007199254740992');
  if(kind==='wrong-scope')f.fault.restaurant={name:'not our fixture'};
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.uncertain,kind!=='wrong-scope');
  assert.ok(f.calls.filter(v=>['POST','DELETE','PATCH'].includes(v.method)).length<=1);assert.doesNotMatch(JSON.stringify(result),/private-wire|must-not-escape/);
});
for(const kind of ['unproven','foreign-key','still-present','item-image-reference'])test('delete refuses '+kind+' before mutation',async()=>{
  const f=fixture(true),run=await feature(true);
  if(kind==='unproven')f.options.imageProbe.protectedDeletions=1;
  if(kind==='foreign-key')f.options.objectKey=item+'/'+item+'/'+object;
  if(kind==='still-present')f.fault.imagePresent=true;
  if(kind==='item-image-reference')f.fault.items=[{id:item,restaurantId:r,name:tag+' image item',price:'12.34',imageUrl:'https://foreign.invalid/image'}];
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(f.calls.some(v=>v.method==='DELETE'),false);
});
for(const kind of ['previous-item','current-item','wrong-version','foreign-tenant'])test('delete retains uncertainty after mismatched '+kind+' readback',async()=>{
  const f=fixture(true),run=await feature(true);f.fault.states=values=>{
    if(kind==='previous-item')values[1].catalog.items=[];
    if(kind==='current-item')values[0].catalog.items=values[1].catalog.items;
    if(kind==='wrong-version')values[1].version='1';
    if(kind==='foreign-tenant')values[0].catalog.restaurant={...values[0].catalog.restaurant,id:item};
  };
  const result=await run(f.options);assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(f.calls.filter(v=>v.method==='DELETE').length,1);assert.equal(result.receipts.length,1);
});
test('cancelled private read stops without retry or loss of the ready deletion receipt',async()=>{
  const run=await feature(true),f=fixture(true),abort=new AbortController();f.options.readRetained=async()=>{abort.abort();return new Promise(()=>{});};
  const result=await run({...f.options,signal:abort.signal});assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(result.receipts.length,1);
});
