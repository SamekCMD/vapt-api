import test from 'node:test';
import assert from 'node:assert/strict';
const restaurant='11111111-1111-4111-8111-111111111111',item='22222222-2222-4222-8222-222222222222',tag='catalog-writer-33333333-3333-4333-8333-333333333333';
const operations=Object.fromEntries(['create','patch','private','mixed','delete','rebuild'].map((name,i)=>[name,`44444444-4444-4444-8444-${String(i+1).padStart(12,'0')}`]));
async function feature(){const m=await import('./catalog-writer-probe.mjs').catch(()=>({}));assert.equal(typeof m.runProductionCatalogWriterProbe,'function','catalog writer probe missing');return m.runProductionCatalogWriterProbe;}
function fixture(){
  const calls=[],seen=new Map(),state={items:[],version:9007199254740992n,description:null},fault={};let preflights=0;
  const resultItem=input=>({id:item,restaurantId:restaurant,...input,createdAt:'2026-10-27T00:00:00.000Z',updatedAt:'2026-10-27T00:00:00.000Z'});
  const receipt=(id,version)=>({operationId:id,restaurantId:restaurant,phase:'ready',version,committed:true,retryable:false});
  const options={baseUrl:'https://api.vapt.app.br',restaurantId:restaurant,tag,operationIds:structuredClone(operations),cookie:'__Secure-better-auth.session_token=synthetic-test-token-not-a-credential',pace:async()=>{},waitPending:async()=>{},preflight:async()=>{preflights++;},
    fetcher:async(url,init)=>{
      calls.push({url,method:init.method,body:init.body,headers:{...init.headers},redirect:init.redirect,signal:init.signal});const path=new URL(url).pathname,key=init.headers['Idempotency-Key'],body=init.body?JSON.parse(init.body):null;
      if(fault.lost&&init.method==='POST'&&path.endsWith('/menu-items'))throw Error('private-provider-body');
      if(init.method==='GET'&&path.endsWith('/menu-items'))return Response.json(state.items);
      if(init.method==='GET'&&path===`/restaurants/${restaurant}`)return Response.json({id:restaurant,name:fault.foreign?'Real restaurant':tag,slug:tag,description:state.description,cnpj:null});
      if(path.includes('/catalog-operations/')){const id=path.split('/catalog-operations/')[1].split('/')[0];if(fault.pending)return Response.json({operationId:id,restaurantId:restaurant,phase:'accepted',version:null,committed:false,retryable:false});return Response.json(receipt(id,seen.get(id)?.receipt.version));}
      if(seen.has(key)){const replay=structuredClone(seen.get(key));if(fault.replay)replay.receipt.version='9007199254740994';return Response.json(replay,{status:path.endsWith('/menu-items')?201:200});}
      let version=key===operations.private?null:String(++state.version),result;
      if(init.method==='POST'&&path.endsWith('/menu-items')){result=resultItem(body);state.items=[result];}
      if(init.method==='PATCH'&&path.includes('/menu-items/')){state.items=[{...state.items[0],...body}];result=state.items[0];}
      if(init.method==='PATCH'&&path===`/restaurants/${restaurant}`){if(body.description!==undefined)state.description=body.description;result={id:restaurant,name:tag,slug:tag,description:state.description,cnpj:null};}
      if(init.method==='DELETE'){state.items=[];result=undefined;}
      const value={receipt:receipt(key,version),...(result===undefined?{}:{result})};seen.set(key,structuredClone(value));
      if(fault.target)value.receipt.restaurantId='55555555-5555-4555-8555-555555555555';if(fault.version)value.receipt.version='9e15';
      if(fault.pending){value.receipt={operationId:key,restaurantId:restaurant,phase:'accepted',version:null,committed:false,retryable:false};return Response.json(value,{status:202});}
      return Response.json(value,{status:init.method==='POST'&&path.endsWith('/menu-items')?201:200});
    }};
  return {options,calls,state,fault,preflights:()=>preflights};
}
test('probe checks synthetic scope before writes, uses explicit tenant/protocol and verifies replay, variations, private/mixed patches, delete and manual completed retry',async()=>{
  const run=await feature(),f=fixture(),r=await run(f.options);assert.equal(r.ok,true);assert.equal(f.preflights(),1);assert.equal(r.requests,15);assert.equal(r.receipts.length,6);assert.equal(r.receipts[0].version,'9007199254740993');assert.equal(r.receipts[2].version,null);assert.equal(r.receipts.at(-1).version,'9007199254740997');
  assert.equal(f.calls[0].method,'GET');assert.equal(f.calls[1].method,'GET');assert.equal(f.calls[2].headers['Idempotency-Key'],operations.create);assert.equal(f.calls[3].headers['Idempotency-Key'],operations.create);assert.equal(f.calls[2].body,f.calls[3].body);
  const body=JSON.parse(f.calls[2].body);assert.equal(body.price,'12.34');assert.deepEqual(body.variations,[{name:'Tamanho',options:['P','G'],required:true}]);assert.deepEqual(JSON.parse(f.calls[5].body).variations,[{name:'Tamanho',options:['M'],required:false}]);
  assert(f.calls.every(c=>c.url.startsWith(`https://api.vapt.app.br/restaurants/${restaurant}`)&&c.redirect==='error'&&c.signal instanceof AbortSignal));
  assert(f.calls.filter(c=>c.method!=='GET').every(c=>c.headers['X-Vapt-Catalog-Protocol']==='1'));assert(f.calls.at(-1).url.endsWith(`/catalog-operations/${operations.rebuild}/retry`));
  assert.doesNotMatch(JSON.stringify(r),/synthetic-test-token|private-provider-body|cnpj/);assert.deepEqual(f.state.items,[]);
});
for(const [label,change]of [['foreign origin',o=>{o.baseUrl='https://other.example';}],['missing session',o=>{o.cookie='';}],['not synthetic',o=>{o.tag='Real restaurant';}],['duplicate operations',o=>{o.operationIds.patch=o.operationIds.create;}],['missing scope verifier',o=>{delete o.preflight;}],['cancelled',o=>{o.signal=AbortSignal.abort();}]])test(`invalid ${label} refuses all HTTP calls`,async()=>{
  const run=await feature(),f=fixture();change(f.options);const r=await run(f.options);assert.equal(r.ok,false);assert.deepEqual(f.calls,[]);
});
test('foreign restaurant or existing items stop before a mutation',async()=>{
  const run=await feature();for(const existing of [false,true]){const f=fixture();if(existing)f.state.items=[{id:item}];else f.fault.foreign=true;const r=await run(f.options);assert.equal(r.ok,false);assert(f.calls.every(c=>c.method==='GET'));}
});
for(const name of ['target','version','replay','lost'])test(`bad ${name} result stops without another mutation or retry`,async()=>{
  const run=await feature(),f=fixture();f.fault[name]=true;const r=await run(f.options);assert.equal(r.ok,false);assert.equal(r.uncertain,true);assert(f.calls.filter(c=>c.method==='POST').length<3);assert(!f.calls.some(c=>c.method==='DELETE'));assert.doesNotMatch(JSON.stringify(r),/private-provider-body/);
});
test('pending work gets one bounded status check, never a polling loop or next mutation',async()=>{
  const run=await feature(),f=fixture();f.fault.pending=true;let waits=0;f.options.waitPending=async()=>{waits++;};const r=await run(f.options);
  assert.equal(r.ok,false);assert.equal(r.code,'pending_unresolved');assert.equal(waits,1);assert.equal(f.calls.filter(c=>c.url.includes('/catalog-operations/')).length,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(r.receipts[0].phase,'accepted');
});
test('oversized response stops and cancels the stream without exposing its body',async()=>{
  const run=await feature(),f=fixture();let cancelled=false;f.options.fetcher=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}));
  const r=await run(f.options);assert.equal(r.ok,false);assert.equal(cancelled,true);assert.equal(r.requests,1);
});
