import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const feature=()=>import('./production-maintenance-artifact.mjs').catch(()=>({}));
const legacy=Buffer.from('export class RestaurantRealtime { identify(){return "original-room";} }\nexport default {fetch(){throw Error("Legacy fetch must not run");},scheduled(){throw Error("Legacy schedule must not run");}};\n');
const input=()=>({entrypoint:'src/index.js',modules:[{name:'src/index.js',type:'application/javascript+module',bytes:Buffer.from(legacy)}]});
async function prepare(value=input()) {
 const {createProductionMaintenanceArtifact}=await feature();
 assert.equal(typeof createProductionMaintenanceArtifact,'function','offline maintenance artifact builder is missing');
 return createProductionMaintenanceArtifact(value);
}
async function runArtifact(artifact,action) {
 const directory=await mkdtemp(resolve(tmpdir(),'vapt-maintenance-test-'));
 try {
  await writeFile(resolve(directory,'package.json'),JSON.stringify({type:'module'}));
  for(const file of artifact.modules){const path=resolve(directory,file.name);await mkdir(dirname(path),{recursive:true});await writeFile(path,file.bytes);}
  const entry=await import(pathToFileURL(resolve(directory,artifact.mainModule)).href);
  const original=await import(pathToFileURL(resolve(directory,'src/index.js')).href);
  await action(entry,original);
 } finally {await rm(directory,{recursive:true,force:true});}
}
test('maintenance content-only metadata cannot include bindings, migrations or a target',async()=>{
 const artifact=await prepare();
 assert.deepEqual(artifact.metadata,{main_module:'__vapt_production_maintenance__.mjs'});
 assert.equal(artifact.mainModule,'__vapt_production_maintenance__.mjs');
 assert.equal(artifact.modules.length,2);
});
test('maintenance copies the original bytes instead of rewriting the application',async()=>{
 const value=input(),artifact=await prepare(value);
 const original=artifact.modules.find(file=>file.name==='src/index.js');
 assert(original.bytes.equals(legacy));value.modules[0].bytes.fill(0);
 assert(original.bytes.equals(legacy),'caller mutation must not change prepared legacy modules');
});
test('maintenance reexports the exact original Durable Object class, not a stub',async()=>{
 await runArtifact(await prepare(),async(entry,original)=>{
  assert.equal(entry.RestaurantRealtime,original.RestaurantRealtime);
  assert.equal(new entry.RestaurantRealtime().identify(),'original-room');
  assert.deepEqual(Object.keys(entry).sort(),['RestaurantRealtime','default']);
 });
});
test('maintenance rejects all request families before legacy fetch and never queues background work',async()=>{
 await runArtifact(await prepare(),async({default:worker})=>{
  const families=[
   ['GET','/health'],['GET','/restaurants/me'],['POST','/auth/sign-up/email'],['POST','/orders'],
   ['POST','/webhooks/stripe'],['POST','/webhooks/mercado-pago'],['PATCH','/restaurants/00000000-0000-4000-8000-000000000001'],
   ['DELETE','/menu/items/00000000-0000-4000-8000-000000000001'],['OPTIONS','/auth/sign-in/email'],
   ['HEAD','/v1/catalog/test/catalog'],['GET','/v1/realtime/test'],
  ];
  const forbidden=new Proxy({},{get(){throw Error('No env or context may be consulted');}});
  for(const [method,path] of families){
   const request=new Request('https://api.vapt.app.br'+path,{method});
   const response=await worker.fetch(request,forbidden,forbidden);
   assert.equal(response.status,503,method+' '+path);
   assert.equal(response.headers.get('cache-control'),'no-store');
   assert.equal(response.headers.get('retry-after'),'60');
   assert.equal(response.headers.get('set-cookie'),null);
   assert.deepEqual(await response.json(),{error:{code:'service_unavailable',message:'Service unavailable'}});
  }
 });
});
test('maintenance never reads headers, cookies, body or stream of an incoming request',async()=>{
 await runArtifact(await prepare(),async({default:worker})=>{
  const unreadable=new Proxy({},{get(){throw Error('Request must remain unread');}});
  assert.equal((await worker.fetch(unreadable,unreadable,unreadable)).status,503);
 });
});
const invalid=[
 ['null',()=>null],
 ['caller-supplied target',()=>({...input(),worker:'another-worker'})],
 ['empty modules',()=>({entrypoint:'src/index.js',modules:[]})],
 ['absent entrypoint',()=>({...input(),entrypoint:'absent.js'})],
 ['duplicate names',()=>{const value=input();value.modules.push({...value.modules[0]});return value;}],
 ['wrapper collision',()=>{const value=input();value.modules.push({name:'__vapt_production_maintenance__.mjs',type:'application/javascript+module',bytes:Buffer.from('export{}')});return value;}],
 ['parent traversal',()=>{const value=input();value.entrypoint=value.modules[0].name='../index.js';return value;}],
 ['absolute path',()=>{const value=input();value.entrypoint=value.modules[0].name='/index.js';return value;}],
 ['windows path',()=>{const value=input();value.entrypoint=value.modules[0].name='C:\\index.js';return value;}],
 ['embedded quote',()=>{const value=input();value.entrypoint=value.modules[0].name='bad".js';return value;}],
 ['URL query',()=>{const value=input();value.entrypoint=value.modules[0].name='index.js?x=1';return value;}],
 ['encoded path',()=>{const value=input();value.entrypoint=value.modules[0].name='%2e%2e/index.js';return value;}],
 ['empty path segment',()=>{const value=input();value.entrypoint=value.modules[0].name='src//index.js';return value;}],
 ['dot path segment',()=>{const value=input();value.entrypoint=value.modules[0].name='src/./index.js';return value;}],
 ['non-JavaScript entrypoint',()=>{const value=input();value.modules[0].type='application/wasm';return value;}],
 ['unknown content type',()=>{const value=input();value.modules[0].type='text/html';return value;}],
 ['empty bytes',()=>{const value=input();value.modules[0].bytes=Buffer.alloc(0);return value;}],
 ['string instead of bytes',()=>{const value=input();value.modules[0].bytes='export{}';return value;}],
 ['unexpected module fields',()=>{const value=input();value.modules[0].secret='must-not-be-accepted';return value;}],
 ['too many modules',()=>{const value=input();for(let i=0;i<16;i++)value.modules.push({name:'part'+i+'.js',type:'application/javascript+module',bytes:Buffer.from('export{}')});return value;}],
 ['oversized modules',()=>{const value=input();value.modules[0].bytes=Buffer.alloc(8*1024*1024+1);return value;}],
];
for(const [name,fixture] of invalid)test('maintenance refuses '+name,async()=>{
 const {createProductionMaintenanceArtifact}=await feature();
 assert.equal(typeof createProductionMaintenanceArtifact,'function','offline maintenance artifact builder is missing');
 assert.throws(()=>createProductionMaintenanceArtifact(fixture()),{message:'Invalid maintenance artifact input'});
});
