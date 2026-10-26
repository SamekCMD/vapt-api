import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createProductionMaintenanceArtifact } from './production-maintenance-artifact.mjs';
const feature=()=>import('./production-maintenance-window.mjs').catch(()=>({}));
const prefix='https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932';
const api='/workers/scripts/vapt-api-production',billing='/workers/scripts/vapt-billing-email-production';
const queue='/queues/69f033ad5eb6424c99b41d1baa7ff3ad',dead='/queues/ad6e9115d01f4c63a43a557f18c0a3a9';
const clone=value=>structuredClone(value);
const history=(id,version)=>({deployments:[{id,versions:[{version_id:version,percentage:100}]}]});
function fixture(options={}) {
 const secretNames=['BETTER_AUTH_SECRET','PUBLIC_ORDER_TOKEN_SECRET','RESEND_API_KEY','TURNSTILE_SECRET_KEY','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'];
 const rates=[['AUTH_RATE_LIMIT','13011',20],['BILLING_RATE_LIMIT','13012',60],['ORDERS_RATE_LIMIT','13013',30],['STORAGE_RATE_LIMIT','13014',30],['WEBHOOKS_RATE_LIMIT','13015',300],['PUBLIC_RATE_LIMIT','13016',120]];
 const settings={compatibility_date:'2026-09-28',compatibility_flags:['nodejs_compat'],limits:{cpu_ms:1000},
  logpush:false,tail_consumers:[],usage_model:'standard',placement:{},
  bindings:[...secretNames.map(name=>({name,type:'secret_text'})),
   ...rates.map(([name,namespace_id,limit])=>({name,type:'ratelimit',namespace_id,simple:{limit,period:60}})),
   {name:'HYPERDRIVE',type:'hyperdrive',id:'2885c609a66641b3b716190c2d467902'},
   {name:'RESTAURANT_REALTIME',type:'durable_object_namespace',namespace_id:'d3ad7a4008c64124b765f934986956da',class_name:'RestaurantRealtime'},
   {name:'R2_BUCKET',type:'r2_bucket',bucket_name:'vapt-assets-production'},
   ...[['ENVIRONMENT','production'],['REALTIME_ENABLED','true'],['STRIPE_ENVIRONMENT','test']].map(([name,text])=>({name,type:'plain_text',text}))]};
 const billSettings={compatibility_date:'2025-12-01',compatibility_flags:[],logpush:false,tail_consumers:[],usage_model:'standard',placement:{},
  bindings:[{name:'DATABASE_URL',type:'secret_text'},{name:'RESEND_API_KEY',type:'secret_text'},
   {name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'BILLING_EMAIL_QUEUE',type:'queue',queue_name:'vapt-emails-production'}]};
 const state=new Map([
  [api+'/deployments',history('68828632-0b50-4c80-b6d1-2c43a6736760','914f79f0-b679-45a2-a0c0-069acd87aa23')],
  [billing+'/deployments',history('da2a4249-7fb5-408a-a124-ce5ded1d58af','1f578bc6-586a-46ca-b180-0301057b2cc8')],
  ['/workers/scripts/vapt-web/deployments',history('24d1b0fc-dda0-4789-a426-4146c9cad04d','e77339dd-59ea-44dd-a790-660076570810')],
  [api+'/settings',settings],[billing+'/settings',billSettings],
  [api+'/subdomain',{enabled:false,previews_enabled:false}],[billing+'/subdomain',{enabled:false,previews_enabled:false}],
  [api+'/schedules',{schedules:[]}],[billing+'/schedules',{schedules:[{cron:'*/30 * * * *',created_on:'2026-10-14T17:04:36.385496Z',modified_on:'2026-10-14T17:04:36.385496Z'}]}],
  ['/workers/domains',[{id:'f7344b662aa02bcfa576e9cb5b0108d6d59b667f',hostname:'api.vapt.app.br',service:'vapt-api-production'},
   {id:'42d2afe630dc5122d027cf55cb13607c7e0d6bd3',hostname:'vapt.app.br',service:'vapt-web'}]],
  [queue,{queue_id:queue.split('/').at(-1),queue_name:'vapt-emails-production',settings:{delivery_delay:0,message_retention_period:86400},
   consumers:[{consumer_id:'8fb8e9ad983442aaab49079154d3d799',type:'worker',script:'vapt-billing-email-production',dead_letter_queue:'vapt-emails-production-dlq',settings:{batch_size:10,max_retries:3,max_wait_time_ms:5000,retry_delay:60}}],
   producers:[{type:'worker',script:'vapt-billing-email-production'}]}],
  [dead,{queue_id:dead.split('/').at(-1),queue_name:'vapt-emails-production-dlq',settings:{delivery_delay:0,message_retention_period:86400},consumers:[],producers:[]}],
  [queue+'/metrics',{backlog_count:0,backlog_bytes:0}],[dead+'/metrics',{backlog_count:0,backlog_bytes:0}],
 ]);
 const artifact={...createProductionMaintenanceArtifact({entrypoint:'realtime-entry.js',modules:[{name:'realtime-entry.js',type:'application/javascript+module',bytes:Buffer.from('export class RestaurantRealtime{}; export default {fetch(){throw Error("legacy")}};')}]}),
  originalSourceSha256:'3ade3b1dce5ca021239d1f81f6ed77283be7d9b4a470e10d52cfc85cc062fc1e'};
 const calls=[],events=[];let claimed=false,writes=0,sourceCalls=0;
 const ok=value=>Response.json({success:true,result:clone(value)});
 const ports={
  journal:{async claim(){events.push('claim');if(claimed)return false;claimed=true;return true;},async record(phase){events.push(phase);if(options.journalFailure===phase)throw Error('sensitive-journal-error');}},
  async prepareSource(){sourceCalls++;if(options.sourceFailure)throw Error('sensitive-source-error');return artifact;},
  async fetchControl(url,init) {
   assert(url.startsWith(prefix));const path=url.slice(prefix.length);calls.push({path,init});
   assert.equal(init.redirect,'error');assert(init.signal instanceof AbortSignal);
   const method=init.method;
   if(method==='GET') {
    if(options.beforeGet)options.beforeGet(path,state,writes);
    if(path===api+'/content/v2'){
     const form=new FormData();for(const part of artifact.modules)form.set(part.name,new Blob([part.bytes],{type:part.type}),part.name);
     return new Response(form,{headers:{'cf-entrypoint':artifact.mainModule}});
    }
    assert(state.has(path),'unexpected GET '+path);return ok(state.get(path));
   }
   writes++;
   if(options.failWrite===writes)throw Error('secret-token-and-private-url');
   if(path===api+'/content') {
    assert.equal(method,'PUT');assert(init.body instanceof FormData);
    assert.deepEqual(JSON.parse(init.body.get('metadata')),{main_module:'__vapt_production_maintenance__.mjs'});
    assert.deepEqual([...init.body.keys()].sort(),['__vapt_production_maintenance__.mjs','metadata','realtime-entry.js']);
    state.set(api+'/deployments',history('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    if(options.afterApi)options.afterApi(state);
    return ok({id:'vapt-api-production'});
   }
   if(path===queue){assert.equal(method,'PATCH');assert.deepEqual(JSON.parse(init.body),{settings:{delivery_paused:true}});
    state.get(queue).settings.delivery_paused=true;return ok(state.get(queue));}
   if(path===billing+'/schedules'){assert.equal(method,'PUT');assert.deepEqual(JSON.parse(init.body),[]);
    state.set(path,{schedules:[]});return ok({schedules:[]});}
   assert.fail('Unapproved mutation '+path);
  },
  async fetchPublic(url,init) {
   calls.push({public:true,url,init});assert.equal(url,'https://api.vapt.app.br/health');
   assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.deepEqual(init.headers,{});
   return Response.json({error:{code:'service_unavailable',message:'Service unavailable'}},
    {status:options.probeStatus??503,headers:{'cache-control':'no-store','retry-after':'60'}});
  },
 };
 return{ports,state,calls,events,get writes(){return writes;},get sourceCalls(){return sourceCalls;},artifact};
}
async function run(command,f) {
 const {runProductionMaintenanceWindow}=await feature();
 assert.equal(typeof runProductionMaintenanceWindow,'function','restricted window operator is missing');
 return runProductionMaintenanceWindow(command,f.ports);
}
test('inspect is read-only and does not claim the exclusive window',async()=>{
 const f=fixture(),result=await run(['inspect'],f);
 assert.equal(result.status,0);assert.equal(result.report.inspectionVerified,true);
 assert.equal(f.writes,0);assert.equal(f.sourceCalls,1);assert.deepEqual(f.events,[]);
 assert.equal(result.report.drainVerified,false);assert.equal(result.report.migrationReady,false);
});
test('close performs only content replacement, queue pause and cron removal in order',async()=>{
 const f=fixture(),before=clone(f.state),result=await run(['close'],f);
 assert.equal(result.status,0);assert.equal(result.report.httpAdmissionClosed,true);
 assert.equal(result.report.queuePaused,true);assert.equal(result.report.cronPaused,true);
 assert.equal(result.report.drainVerified,false);assert.equal(result.report.migrationReady,false);
 assert.deepEqual(f.calls.filter(call=>!call.public&&call.init.method!=='GET').map(call=>[call.init.method,call.path]),
  [['PUT',api+'/content'],['PATCH',queue],['PUT',billing+'/schedules']]);
 assert.equal(f.events[0],'claim');
 for(const path of [api+'/settings',billing+'/settings',api+'/subdomain',billing+'/subdomain','/workers/domains',dead])
  assert.deepEqual(f.state.get(path),before.get(path));
 assert(!f.calls.some(call=>/preview|purge|messages|consumers|neon/.test(call.path??'')));
});
test('a persistent claim prevents a repeated close before even reading the provider',async()=>{
 const f=fixture();await run(['close'],f);const count=f.calls.length;
 const again=await run(['close'],f);
 assert.equal(again.status,1);assert.equal(again.report.code,'window_already_started');
 assert.equal(f.calls.length,count);assert.equal(f.writes,3);
});
for(const [name,modify] of [
 ['API deployment',state=>state.get(api+'/deployments').deployments[0].id='changed'],
 ['web deployment',state=>state.get('/workers/scripts/vapt-web/deployments').deployments[0].versions[0].percentage=50],
 ['billing version',state=>state.get(billing+'/deployments').deployments[0].versions[0].version_id='changed'],
 ['CPU limit',state=>state.get(api+'/settings').limits.cpu_ms=30000],
 ['database binding',state=>state.get(api+'/settings').bindings.find(b=>b.name==='HYPERDRIVE').id='wrong'],
 ['Durable Object binding',state=>state.get(api+'/settings').bindings.find(b=>b.name==='RESTAURANT_REALTIME').namespace_id='wrong'],
 ['public ingress',state=>state.get(api+'/subdomain').previews_enabled=true],
 ['API cron',state=>state.get(api+'/schedules').schedules.push({cron:'* * * * *'})],
 ['billing cron',state=>state.get(billing+'/schedules').schedules[0].cron='* * * * *'],
 ['billing environment',state=>state.get(billing+'/settings').bindings.find(b=>b.name==='ENVIRONMENT').text='preview'],
 ['foreign queue consumer',state=>state.get(queue).consumers[0].script='foreign-worker'],
 ['foreign queue producer',state=>state.get(queue).producers.push({script:'foreign-worker',type:'worker'})],
 ['queue retention',state=>state.get(queue).settings.message_retention_period=60],
 ['already paused queue',state=>state.get(queue).settings.delivery_paused=true],
 ['queue backlog',state=>state.get(queue+'/metrics').backlog_count=1],
 ['dead-letter backlog',state=>state.get(dead+'/metrics').backlog_count=1],
 ['API custom domain',state=>state.get('/workers/domains')[0].hostname='other.example'],
])test('preflight refuses changed '+name+' without any mutation',async()=>{
 const f=fixture();modify(f.state);const result=await run(['close'],f);
 assert.equal(result.status,1);assert.equal(f.writes,0);assert.equal(result.report.uncertain,false);
});
test('drift between source preparation and upload stops before mutation',async()=>{
 const f=fixture();f.ports.prepareSource=async()=>{f.state.get(api+'/settings').bindings.push({name:'CHANGED',type:'plain_text',text:'true'});return f.artifact;};
 const result=await run(['close'],f);assert.equal(result.status,1);assert.equal(f.writes,0);
});
for(const attempt of [1,2,3])test('lost response on mutation '+attempt+' does not retry or roll back',async()=>{
 const f=fixture({failWrite:attempt}),result=await run(['close'],f);
 assert.equal(result.status,1);assert.equal(result.report.uncertain,true);assert.equal(f.writes,attempt);
 assert(!JSON.stringify(result).includes('secret-token'));assert(!JSON.stringify(result).includes('private-url'));
 const count=f.calls.length;await run(['close'],f);assert.equal(f.calls.length,count);
});
test('a failed runtime probe never proceeds to queue or cron changes',async()=>{
 const f=fixture({probeStatus:200}),result=await run(['close'],f);
 assert.equal(result.status,1);assert.equal(result.report.uncertain,true);assert.equal(f.writes,1);
});
test('post-upload settings drift stops and does not force a rollback',async()=>{
 const f=fixture({afterApi:state=>{state.get(api+'/settings').limits.cpu_ms=999;}}),result=await run(['close'],f);
 assert.equal(result.status,1);assert.equal(f.writes,1);assert.equal(result.report.uncertain,true);
});
test('a durable attempt record must succeed before the corresponding mutation',async()=>{
 const f=fixture({journalFailure:'queue_attempt'}),result=await run(['close'],f);
 assert.equal(result.status,1);assert.equal(f.writes,1);assert.equal(result.report.uncertain,true);
});
test('source preparation failure keeps all resources untouched',async()=>{
 const f=fixture({sourceFailure:true}),result=await run(['close'],f);
 assert.equal(result.status,1);assert.equal(f.writes,0);assert.equal(result.report.uncertain,false);
 assert(!JSON.stringify(result).includes('sensitive-source'));
});
test('a corrupted maintenance wrapper is refused before an upload can be attempted',async()=>{
 const f=fixture();f.artifact.modules.find(part=>part.name===f.artifact.mainModule).bytes=Buffer.from('export default {fetch(){return new Response("unexpected")}};');
 const result=await run(['close'],f);assert.equal(result.status,1);assert.equal(f.writes,0);
});
test('a source adapter cannot replace the multipart metadata part by changing a module name',async()=>{
 const f=fixture();f.artifact.modules.find(part=>part.name==='realtime-entry.js').name='metadata';
 const result=await run(['close'],f);assert.equal(result.status,1);assert.equal(f.writes,0);
});
for(const args of [[],['close','production'],['restore'],['close','--apply'],['inspect','--url=other']])
 test('unknown operator arguments cannot open a window: '+JSON.stringify(args),async()=>{
  const f=fixture(),result=await run(args,f);assert.equal(result.status,1);assert.equal(f.calls.length,0);assert.deepEqual(f.events,[]);
 });
test('missing transports or durable journal never fall back to global fetch',async()=>{
 const {runProductionMaintenanceWindow}=await feature();assert.equal(typeof runProductionMaintenanceWindow,'function');
 for(const ports of [{},{fetchControl:async()=>assert.fail('must not run')}])
  assert.equal((await runProductionMaintenanceWindow(['close'],ports)).status,1);
});
test('a rejected control-plane response is cancelled before returning a sanitized failure',async()=>{
 const f=fixture();let cancelled=false;
 f.ports.fetchControl=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403});
 const result=await run(['inspect'],f);
 assert.equal(result.status,1);assert.equal(cancelled,true);assert.equal(result.report.uncertain,false);
});
test('the pinned source reader cancels a rejected download instead of retaining its body',async()=>{
 const {readPinnedProductionMaintenanceArtifact}=await feature();assert.equal(typeof readPinnedProductionMaintenanceArtifact,'function');
 let cancelled=false;
 await assert.rejects(readPinnedProductionMaintenanceArtifact(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403})));
 assert.equal(cancelled,true);
});
test('the default source adapter refuses a right-sized bundle with a different hash',async()=>{
 const {readPinnedProductionMaintenanceArtifact}=await feature();assert.equal(typeof readPinnedProductionMaintenanceArtifact,'function');
 const form=new FormData();
 form.set('realtime-entry.js',new Blob([Buffer.alloc(4603774)],{type:'application/javascript+module'}),'realtime-entry.js');
 await assert.rejects(readPinnedProductionMaintenanceArtifact(async(url,init)=>{
  assert.equal(url,prefix+api+'/content/v2');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  return new Response(form,{headers:{'cf-entrypoint':'realtime-entry.js'}});
 }));
});
test('file journal claim is exclusive across independent instances and never overwrites',async()=>{
 const {createProductionWindowJournal}=await feature();assert.equal(typeof createProductionWindowJournal,'function','durable window journal is missing');
 const directory=await mkdtemp(resolve(tmpdir(),'vapt-window-journal-')),path=resolve(directory,'start.json');
 try {
  const one=createProductionWindowJournal(path),two=createProductionWindowJournal(path);
  const claims=await Promise.all([one.claim(),two.claim()]);assert.equal(claims.filter(Boolean).length,1);
  const winner=claims[0]?one:two;await winner.record('api_attempt');
  assert.equal((JSON.parse(await readFile(path,'utf8'))).format,1);
  assert.equal((await readdir(directory)).length,2);
  await assert.rejects(winner.record('api_attempt'),{code:'EEXIST'});
  await assert.rejects(winner.record('untrusted-sensitive-data'));
  assert.equal(await createProductionWindowJournal(path).claim(),false);
 } finally {await rm(directory,{recursive:true,force:true});}
});
