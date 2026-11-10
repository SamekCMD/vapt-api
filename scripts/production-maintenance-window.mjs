// Restricted window operator. No CLI, default network transport, credentials,
// provisioning, SQL, resume, rollback, retries or drain certification.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createProductionMaintenanceArtifact } from './production-maintenance-artifact.mjs';
const base='https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932';
const api='/workers/scripts/vapt-api-production',billing='/workers/scripts/vapt-billing-email-production';
const queue='/queues/69f033ad5eb6424c99b41d1baa7ff3ad',dead='/queues/ad6e9115d01f4c63a43a557f18c0a3a9';
const sourceSha='3ade3b1dce5ca021239d1f81f6ed77283be7d9b4a470e10d52cfc85cc062fc1e';
const pins=[
 [api,'68828632-0b50-4c80-b6d1-2c43a6736760','914f79f0-b679-45a2-a0c0-069acd87aa23'],
 [billing,'da2a4249-7fb5-408a-a124-ce5ded1d58af','1f578bc6-586a-46ca-b180-0301057b2cc8'],
 ['/workers/scripts/vapt-web','24d1b0fc-dda0-4789-a426-4146c9cad04d','e77339dd-59ea-44dd-a790-660076570810'],
];
const sha=value=>createHash('sha256').update(value).digest('hex');
const ensure=value=>{if(!value)throw Error('Window guard rejected');};
const same=(a,b)=>ensure(isDeepStrictEqual(a,b));
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const phases=new Set(['api_attempt','api_confirmed','queue_attempt','queue_confirmed','cron_attempt','cron_confirmed']);
export function createProductionWindowJournal(markerPath) {
 ensure(typeof markerPath==='string'&&markerPath.length>0);
 let claimed=false;
 async function save(path,value) {
  const handle=await open(path,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 }
 return {
  async claim() {
   try {await save(markerPath,{format:1,window:'production-maintenance-v1',at:new Date().toISOString(),
    apiBaseline:pins[0][1],sourceSha256:sourceSha});claimed=true;return true;}
   catch(error){if(error.code==='EEXIST')return false;throw error;}
  },
  async record(phase) {
   ensure(claimed&&phases.has(phase));
   await save(markerPath+'.'+phase+'.json',{format:1,phase,at:new Date().toISOString()});
  },
 };
}
async function bytes(response,max) {
 ensure(response.body);const reader=response.body.getReader(),parts=[];let length=0;
 try {for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;ensure(length<=max);parts.push(part.value);}}
 catch{await reader.cancel().catch(()=>{});throw Error('Bounded response rejected');}
 return Buffer.concat(parts);
}
async function successful(response) {
 if(!response.ok) {
  await response.body?.cancel().catch(()=>{});
  throw Error('Provider response rejected');
 }
 return response;
}
async function sourceParts(response) {
 await successful(response);const type=response.headers.get('content-type'),entrypoint=response.headers.get('cf-entrypoint');
 ensure(type?.startsWith('multipart/')&&entrypoint);
 const form=await new Response(await bytes(response,8*1024*1024),{headers:{'content-type':type}}).formData();
 const modules=[];
 for(const [name,part] of form){ensure(part instanceof Blob);modules.push({name,type:part.type,bytes:Buffer.from(await part.arrayBuffer())});}
 return {entrypoint,modules};
}
// This adapter binds the production source hash. Tests may replace this external
// dependency through prepareSource; that trusted code port is not a CLI override.
export async function readPinnedProductionMaintenanceArtifact(fetchControl) {
 ensure(typeof fetchControl==='function');
 const response=await fetchControl(base+api+'/content/v2',{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)});
 const source=await sourceParts(response);
 ensure(source.entrypoint==='realtime-entry.js'&&source.modules.length===1);
 const original=source.modules[0];
 ensure(original.name==='realtime-entry.js'&&original.type==='application/javascript+module'&&
  original.bytes.length===4603774&&sha(original.bytes)===sourceSha);
 return {...createProductionMaintenanceArtifact(source),originalSourceSha256:sourceSha};
}
function settings(value) {
 const {annotations,...rest}=value;
 return {...rest,bindings:[...(rest.bindings??[])].sort((a,b)=>a.name.localeCompare(b.name))};
}
function checkSettings(value,bill=false) {
 ensure(value&&Array.isArray(value.bindings)&&new Set(value.bindings.map(b=>b.name)).size===value.bindings.length);
 ensure(value.logpush!==true&&value.observability?.enabled!==true&&(value.tail_consumers??[]).length===0);
 const bindings=value.bindings,find=name=>bindings.find(b=>b.name===name);
 if(bill) {
  ensure(value.compatibility_date==='2025-12-01'&&bindings.length===4);
  ensure(find('DATABASE_URL')?.type==='secret_text'&&find('RESEND_API_KEY')?.type==='secret_text'&&
   find('ENVIRONMENT')?.type==='plain_text'&&find('ENVIRONMENT').text==='production'&&
   find('BILLING_EMAIL_QUEUE')?.type==='queue'&&find('BILLING_EMAIL_QUEUE').queue_name==='vapt-emails-production');
  return;
 }
 ensure(value.compatibility_date==='2026-09-28'&&value.limits?.cpu_ms===1000);
 same(value.compatibility_flags,['nodejs_compat']);
 const secrets=['BETTER_AUTH_SECRET','PUBLIC_ORDER_TOKEN_SECRET','RESEND_API_KEY','TURNSTILE_SECRET_KEY',
  'R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'];
 ensure(bindings.filter(b=>b.type==='secret_text').length===8&&secrets.every(name=>find(name)?.type==='secret_text'));
 for(const [name,text] of [['ENVIRONMENT','production'],['REALTIME_ENABLED','true'],['STRIPE_ENVIRONMENT','test']])
  ensure(find(name)?.type==='plain_text'&&find(name).text===text);
 ensure(!find('PUBLIC_CATALOG_COORDINATOR')&&!find('PUBLIC_CATALOG_BUCKET'));
 for(const name of ['PUBLIC_CATALOG_READER_ENABLED','PUBLIC_CATALOG_WRITER_ENABLED'])
  ensure(!find(name)||find(name).type==='plain_text'&&find(name).text==='false');
 ensure(bindings.filter(b=>b.type==='hyperdrive').length===1&&find('HYPERDRIVE')?.type==='hyperdrive'&&find('HYPERDRIVE').id==='2885c609a66641b3b716190c2d467902');
 ensure(bindings.filter(b=>b.type==='durable_object_namespace').length===1&&
  find('RESTAURANT_REALTIME')?.type==='durable_object_namespace'&&find('RESTAURANT_REALTIME').namespace_id==='d3ad7a4008c64124b765f934986956da'&&find('RESTAURANT_REALTIME').class_name==='RestaurantRealtime');
 ensure(bindings.filter(b=>b.type==='r2_bucket').length===1&&find('R2_BUCKET')?.type==='r2_bucket'&&find('R2_BUCKET').bucket_name==='vapt-assets-production');
 const rates=[['AUTH_RATE_LIMIT','13011',20],['BILLING_RATE_LIMIT','13012',60],['ORDERS_RATE_LIMIT','13013',30],
  ['STORAGE_RATE_LIMIT','13014',30],['WEBHOOKS_RATE_LIMIT','13015',300],['PUBLIC_RATE_LIMIT','13016',120]];
 ensure(bindings.filter(b=>b.type==='ratelimit').length===6);
 for(const [name,id,limit] of rates) {
  const binding=find(name);ensure(binding?.type==='ratelimit'&&binding.namespace_id===id);same(binding.simple,{limit,period:60});
 }
 ensure(bindings.every(b=>['plain_text','secret_text','hyperdrive','durable_object_namespace','r2_bucket','ratelimit'].includes(b.type)));
}
function queueState(value,isDead=false) {
 ensure(value?.queue_id===(isDead?dead:queue).split('/').at(-1)&&value.queue_name===(isDead?'vapt-emails-production-dlq':'vapt-emails-production'));
 return {id:value.queue_id,name:value.queue_name,settings:{...value.settings,delivery_paused:value.settings?.delivery_paused??false},
  consumers:value.consumers,producers:value.producers};
}
function validateQueue(value,isDead=false) {
 const canonical=queueState(value,isDead);
 same(canonical.settings,{delivery_delay:0,message_retention_period:86400,delivery_paused:false});
 if(isDead){same(canonical.consumers,[]);same(canonical.producers,[]);}
 else {
  same(canonical.consumers,[{consumer_id:'8fb8e9ad983442aaab49079154d3d799',type:'worker',script:'vapt-billing-email-production',
   dead_letter_queue:'vapt-emails-production-dlq',settings:{batch_size:10,max_retries:3,max_wait_time_ms:5000,retry_delay:60}}]);
  same(canonical.producers,[{type:'worker',script:'vapt-billing-email-production'}]);
 }
}
export async function runProductionMaintenanceWindow(args,ports={}) {
 const report={ok:false,inspectionVerified:false,httpAdmissionClosed:false,queuePaused:false,cronPaused:false,
  drainVerified:false,migrationReady:false,uncertain:false,attempted:[]};
 const failure=code=>({status:1,report:{...report,code}});
 if(!Array.isArray(args)||args.length!==1||!['inspect','close'].includes(args[0]))return failure('window_arguments_invalid');
 const closing=args[0]==='close',transport=ports.fetchControl;
 if(typeof transport!=='function'||closing&&(typeof ports.fetchPublic!=='function'||
  typeof ports.journal?.claim!=='function'||typeof ports.journal?.record!=='function'))return failure('window_ports_missing');
 let stage='preflight',artifact;
 async function request(path,method='GET',body) {
  const response=await transport(base+path,{method,...(body!==undefined?{body}:{}),
   ...(typeof body==='string'?{headers:{'content-type':'application/json'}}:{}),
   redirect:'error',signal:AbortSignal.timeout(20000)});
  return successful(response);
 }
 async function read(path,method,body) {
  const response=await request(path,method,body);
  const value=JSON.parse((await bytes(response,1048576)).toString('utf8'));
  ensure(value.success===true&&value.result!==undefined);return value.result;
 }
 async function history(path) {
  const value=(await read(path+'/deployments')).deployments?.[0];
  ensure(value?.id&&value.versions);return {id:value.id,versions:value.versions};
 }
 async function histories() {
  const output=[];for(const [path] of pins)output.push(await history(path));return output;
 }
 function checkPins(observed) {
  pins.forEach(([,id,version],index)=>same(observed[index],{id,versions:[{version_id:version,percentage:100}]}));
 }
 async function resources() {
  const apiSettings=await read(api+'/settings'),billingSettings=await read(billing+'/settings');
  checkSettings(apiSettings);checkSettings(billingSettings,true);
  const apiIngress=await read(api+'/subdomain'),billingIngress=await read(billing+'/subdomain');
  ensure(apiIngress.enabled===false&&apiIngress.previews_enabled===false&&billingIngress.enabled===false&&billingIngress.previews_enabled===false);
  const apiSchedule=await read(api+'/schedules'),billingSchedule=await read(billing+'/schedules');
  same(apiSchedule.schedules,[]);ensure(Array.isArray(billingSchedule.schedules));
  const allDomains=await read('/workers/domains');ensure(Array.isArray(allDomains));
  const domains=allDomains.filter(d=>['vapt-api-production','vapt-web'].includes(d.service))
   .map(({id,hostname,service})=>({id,hostname,service})).sort((a,b)=>a.hostname.localeCompare(b.hostname));
  same(domains,[
   {id:'f7344b662aa02bcfa576e9cb5b0108d6d59b667f',hostname:'api.vapt.app.br',service:'vapt-api-production'},
   {id:'42d2afe630dc5122d027cf55cb13607c7e0d6bd3',hostname:'vapt.app.br',service:'vapt-web'}]);
  return {apiSettings:settings(apiSettings),billingSettings:settings(billingSettings),apiIngress,billingIngress,
   apiSchedule,billingCrons:billingSchedule.schedules.map(s=>s.cron).sort(),domains,
   queue:queueState(await read(queue)),dead:queueState(await read(dead),true)};
 }
 async function metrics() {
  for(const path of [queue,dead]) {
   const value=await read(path+'/metrics');ensure(value.backlog_count===0&&value.backlog_bytes===0);
  }
 }
 async function attempt(phase,perform) {
  await ports.journal.record(phase+'_attempt');
  report.attempted.push(phase);
  return perform();
 }
 try {
  if(closing&&!await ports.journal.claim())return failure('window_already_started');
  checkPins(await histories());
  const before=await resources();
  same(before.billingCrons,['*/30 * * * *']);
  validateQueue(await read(queue));validateQueue(await read(dead),true);await metrics();
  artifact=await (ports.prepareSource??readPinnedProductionMaintenanceArtifact)(transport);
  ensure(artifact?.originalSourceSha256===sourceSha&&artifact.mainModule==='__vapt_production_maintenance__.mjs');
  same(artifact.metadata,{main_module:'__vapt_production_maintenance__.mjs'});
  ensure(Array.isArray(artifact.modules)&&artifact.modules.length===2&&artifact.modules.every(m=>Buffer.isBuffer(m.bytes)));
  same(artifact.modules.map(m=>m.name).sort(),['__vapt_production_maintenance__.mjs','realtime-entry.js']);
  ensure(artifact.modules.every(m=>m.type==='application/javascript+module'));
  ensure(sha(artifact.modules.find(m=>m.name===artifact.mainModule).bytes)==='f4c53e3380f8dcbaf74e347731b142ee3ac54ce5c3c542aa255b8460067f0f32');
  artifact={...artifact,metadata:{...artifact.metadata},modules:artifact.modules.map(m=>({...m,bytes:Buffer.from(m.bytes)}))};
  checkPins(await histories());same(await resources(),before);await metrics();
  report.inspectionVerified=true;
  if(!closing)return {status:0,report:{...report,ok:true,readOnly:true,sourceSha256:sourceSha}};
  stage='api';
  const form=new FormData();form.set('metadata',JSON.stringify(artifact.metadata));
  for(const part of artifact.modules)form.set(part.name,new Blob([part.bytes],{type:part.type}),part.name);
  await attempt('api',async()=>{report.httpAdmissionClosed=null;await read(api+'/content','PUT',form);});
  const after=await histories();same(after.slice(1),pins.slice(1).map(([,id,version])=>({id,versions:[{version_id:version,percentage:100}]})));
  ensure(uuid(after[0].id)&&after[0].id!==pins[0][1]&&after[0].versions.length===1&&
   uuid(after[0].versions[0].version_id)&&after[0].versions[0].version_id!==pins[0][2]&&after[0].versions[0].percentage===100);
  same(await resources(),before);
  const actual=await sourceParts(await request(api+'/content/v2'));
  ensure(actual.entrypoint===artifact.mainModule&&actual.modules.length===artifact.modules.length);
  for(const expected of artifact.modules) {
   const found=actual.modules.find(part=>part.name===expected.name);
   ensure(found&&found.type===expected.type&&found.bytes.equals(expected.bytes));
  }
  const probe=await ports.fetchPublic('https://api.vapt.app.br/health',{method:'GET',headers:{},credentials:'omit',
   redirect:'error',signal:AbortSignal.timeout(15000)});
  ensure(probe.status===503&&probe.headers.get('cache-control')==='no-store'&&probe.headers.get('retry-after')==='60'&&!probe.headers.has('set-cookie'));
  same(JSON.parse((await bytes(probe,4096)).toString('utf8')),{error:{code:'service_unavailable',message:'Service unavailable'}});
  report.httpAdmissionClosed=true;report.apiDeploymentId=after[0].id;report.apiVersion=after[0].versions[0].version_id;
  await ports.journal.record('api_confirmed');
  stage='queue';
  await attempt('queue',async()=>{report.queuePaused=null;await read(queue,'PATCH',JSON.stringify({settings:{delivery_paused:true}}));});
  const paused=structuredClone(before);paused.queue.settings.delivery_paused=true;
  same(await resources(),paused);
  report.queuePaused=true;await ports.journal.record('queue_confirmed');
  stage='cron';
  await attempt('cron',async()=>{report.cronPaused=null;await read(billing+'/schedules','PUT','[]');});
  paused.billingCrons=[];same(await resources(),paused);same(await histories(),after);
  report.cronPaused=true;await ports.journal.record('cron_confirmed');
  return {status:0,report:{...report,ok:true,restoration:{queueDeliveryPaused:false,billingCrons:['*/30 * * * *']},
   nextGate:'drain_and_schema_readiness_required'}};
 } catch {
  report.stoppedAtStage=stage;
  report.uncertain=report.attempted.length>0;
  return failure(report.uncertain?'window_partial_or_uncertain':'window_preflight_failed');
 } finally {artifact=undefined;}
}
