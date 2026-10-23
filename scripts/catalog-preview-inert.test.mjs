import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const feature = () => import('./catalog-preview-inert.mjs').catch(() => ({}));
const config = JSON.parse(readFileSync(new URL('../wrangler.worker-catalog-preview.jsonc', import.meta.url), 'utf8'));
const base = 'https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932';
const previewPath = '/workers/workers/vapt-api-parallel/previews/stage11-inert';
const secretNames = ['BETTER_AUTH_SECRET','PARALLEL_PREVIEW_TOKEN','PUBLIC_ORDER_TOKEN_SECRET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','TURNSTILE_SECRET_KEY'];
const oldRoom = '69fbe1f54ad64a93b7cb761910da094a';
const newRoom = 'bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb';
function fixture(mutate = () => {}) {
  let applied = false; const commands = []; const gets = [];
  const meta = { id:'56efdbf131174b8fba43387369c6f1e3',name:'stage11-inert',slug:'stage11-inert',
    urls:['https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev'],observability:{enabled:false,logs:{enabled:false},traces:{enabled:false}},logpush:false,tail_consumers:[] };
  const env = Object.fromEntries(Object.entries(config.previews.vars).filter(([key])=>!key.startsWith('PUBLIC_CATALOG_')).map(([key,text])=>[key,{type:'plain_text',text}]));
  for(const name of secretNames) env[name]={type:'secret_text'};
  for(const item of config.previews.ratelimits) env[item.name]={type:'ratelimit',namespace_id:item.namespace_id,simple:item.simple};
  env.HYPERDRIVE={type:'hyperdrive',id:'0c05fec2924b4f3b9225f3d689ba7ea9'};
  env.R2_BUCKET={type:'r2_bucket',bucket_name:'vapt-assets-preview'};
  env.RESTAURANT_REALTIME={type:'durable_object_namespace',namespace_id:oldRoom,class_name:'RestaurantRealtime'};
  const deployment={id:'cede8793-b761-4124-b326-e0016614e295',number:42,migration_tag:'stage12-realtime-sqlite-v1',env};
  mutate({meta,deployment});
  const ports = {
    execute(exe,args,options) {
      commands.push({exe,args,options});
      if(args[1]==='auth') { assert.equal(options.env.WRANGLER_WRITE_LOGS,'false'); return {status:0,stdout:JSON.stringify({type:'oauth',token:'synthetic-secret'}),stderr:''}; }
      assert.deepEqual(args.slice(1),['preview','--name','stage11-inert','--worker-name','vapt-api-parallel','--config','wrangler.worker-catalog-preview.jsonc','--json']);
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID,'3ce69408aa5112617a282957aba71932');
      assert.equal(options.env.WRANGLER_WRITE_LOGS,'false'); assert.notEqual(options.stdio,'inherit');
      applied=true;
      deployment.id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; deployment.migration_tag='catalog-publication-preview-sqlite-v1';
      deployment.limits={cpu_ms:1000};
      Object.assign(env,{PUBLIC_CATALOG_READER_ENABLED:{type:'plain_text',text:'false'},PUBLIC_CATALOG_WRITER_ENABLED:{type:'plain_text',text:'false'},
        PUBLIC_CATALOG_BUCKET:{type:'r2_bucket',bucket_name:'vapt-catalog-preview'},PUBLIC_CATALOG_COORDINATOR:{type:'durable_object_namespace',namespace_id:newRoom,class_name:'PublicCatalogCoordinator'}});
      return {status:0,stdout:JSON.stringify({preview:meta,deployment}),stderr:''};
    },
    async fetch(url,options) {
      gets.push(url); assert.equal(options.method,'GET'); assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,'Bearer synthetic-secret');
      const path=url.slice(base.length); let result;
      if(path===previewPath) result=meta;
      else if(path===previewPath+'/deployments/latest') result=deployment;
      else if(path.endsWith('/deployments')) result={deployments:[{id:'unchanged',versions:[{version_id:'same',percentage:100}]}]};
      else throw Error('Unexpected provider endpoint');
      return Response.json({success:true,result});
    },
  };
  return {ports,commands,gets,meta,deployment,applied:()=>applied};
}
test('inert apply publishes only the existing named preview and verifies the new binding without activating it',async()=>{
  const {runCatalogInertPreview}=await feature(); assert.equal(typeof runCatalogInertPreview,'function');
  const value=fixture(); const report=await runCatalogInertPreview(['apply'],value.ports);
  assert.equal(report.status,0); assert.equal(report.report.prepared,true); assert.equal(report.report.activationReady,false);
  assert.equal(report.report.previewId,'56efdbf131174b8fba43387369c6f1e3'); assert.equal(report.report.catalogNamespaceId,newRoom);
  assert.equal(value.applied(),true); assert.equal(value.commands.length,2);
  assert.doesNotMatch(JSON.stringify(report),/synthetic-secret|Bearer|author_email/);
});
test('inspect is read-only and unknown or production targets fail before authentication',async()=>{
  const {runCatalogInertPreview}=await feature(); assert.equal(typeof runCatalogInertPreview,'function');
  const value=fixture(); const report=await runCatalogInertPreview(['inspect'],value.ports);
  assert.equal(report.status,0); assert.equal(value.applied(),false); assert.equal(value.commands.length,1);
  for(const args of [[],['apply','production'],['apply','--name','other'],['apply','--var','secret']]) {
    const rejected=await runCatalogInertPreview(args,{execute(){throw Error('Must not start');}});
    assert.equal(rejected.status,1); assert.doesNotMatch(JSON.stringify(rejected),/other|--var|secret/);
  }
});
for(const [label,mutate] of [
  ['wrong preview',({meta})=>{meta.id='another-preview';}],
  ['missing bearer secret',({deployment})=>{delete deployment.env.PARALLEL_PREVIEW_TOKEN;}],
  ['production DB',({deployment})=>{deployment.env.HYPERDRIVE.id='2885c609a66641b3b716190c2d467902';}],
  ['changed realtime namespace',({deployment})=>{deployment.env.RESTAURANT_REALTIME.namespace_id=newRoom;}],
  ['unexpected migration',({deployment})=>{deployment.migration_tag='unknown';}],
  ['observability',({meta})=>{meta.observability.logs.enabled=true;}],
  ['unknown binding',({deployment})=>{deployment.env.EXTRA={type:'service',service:'production'};}],
  ['history at automatic eviction boundary',({deployment})=>{deployment.number=100;}],
]) test(`${label} refuses deployment rather than repairing or provisioning`,async()=>{
  const {runCatalogInertPreview}=await feature(); assert.equal(typeof runCatalogInertPreview,'function');
  const value=fixture(mutate); const report=await runCatalogInertPreview(['apply'],value.ports);
  assert.equal(report.status,1); assert.equal(value.applied(),false);
});
test('an uncertain deployment is not retried and never reports preparation or leaks CLI errors',async()=>{
  const {runCatalogInertPreview}=await feature(); assert.equal(typeof runCatalogInertPreview,'function');
  const value=fixture(); const execute=value.ports.execute;
  value.ports.execute=(exe,args,options)=>args[1]==='auth'?execute(exe,args,options):{status:1,stderr:'synthetic-secret',stdout:'synthetic-secret'};
  const report=await runCatalogInertPreview(['apply'],value.ports);
  assert.equal(report.status,1); assert.equal(report.report.code,'catalog_preview_deployment_uncertain');
  assert.equal(report.report.activationReady,false); assert.doesNotMatch(JSON.stringify(report),/synthetic-secret/);
});
for(const [label,change] of [
  ['lost secret',v=>{delete v.deployment.env.PARALLEL_PREVIEW_TOKEN;}],
  ['reader enabled',v=>{v.deployment.env.PUBLIC_CATALOG_READER_ENABLED.text='true';}],
  ['wrong catalog bucket',v=>{v.deployment.env.PUBLIC_CATALOG_BUCKET.bucket_name='vapt-catalog-production';}],
  ['changed old namespace',v=>{v.deployment.env.RESTAURANT_REALTIME.namespace_id=newRoom;}],
  ['expanded CPU limit',v=>{v.deployment.limits.cpu_ms=30000;}],
]) test(`post-deployment ${label} fails readback without retry or repair`,async()=>{
  const {runCatalogInertPreview}=await feature(); const value=fixture(); const execute=value.ports.execute;
  value.ports.execute=(exe,args,options)=>{const result=execute(exe,args,options);if(args[1]==='preview') change(value);return result;};
  const report=await runCatalogInertPreview(['apply'],value.ports);
  assert.equal(report.status,1); assert.equal(report.report.code,'catalog_preview_deployment_uncertain');
  assert.equal(value.commands.length,2);
});
test('production or top-level deployment drift fails the post-check without attempting rollback',async()=>{
  const {runCatalogInertPreview}=await feature(); const value=fixture(); const transport=value.ports.fetch;
  value.ports.fetch=async(url,options)=>value.applied()&&url.endsWith('/workers/scripts/vapt-api-production/deployments')
    ? Response.json({success:true,result:{deployments:[{id:'changed',versions:[]}]}}):transport(url,options);
  const report=await runCatalogInertPreview(['apply'],value.ports);
  assert.equal(report.status,1); assert.equal(report.report.code,'catalog_preview_deployment_uncertain');assert.equal(value.commands.length,2);
});
test('a second apply only inspects a verified already prepared preview',async()=>{
  const {runCatalogInertPreview}=await feature(); const value=fixture();
  assert.equal((await runCatalogInertPreview(['apply'],value.ports)).status,0);
  const again=await runCatalogInertPreview(['apply'],value.ports);
  assert.equal(again.status,0);assert.equal(again.report.prepared,true);assert.equal(value.commands.length,3);
});

const existingCatalogRoom = 'eeda94fea90349be8b62b82067c79b27';
const compatibleBaseline = '7b51fca2-207e-4e29-948e-159761b362ea';
function compatibleFixture(mutate = () => {}) {
  const value = fixture(({meta,deployment}) => {
    deployment.id=compatibleBaseline; deployment.number=27;
    deployment.migration_tag='catalog-publication-preview-sqlite-v1'; deployment.limits={cpu_ms:1000};
    for(const [name,text] of Object.entries(config.previews.vars)) deployment.env[name]={type:'plain_text',text};
    deployment.env.PUBLIC_CATALOG_BUCKET={type:'r2_bucket',bucket_name:'vapt-catalog-preview'};
    deployment.env.PUBLIC_CATALOG_COORDINATOR={type:'durable_object_namespace',namespace_id:existingCatalogRoom,class_name:'PublicCatalogCoordinator'};
    mutate({meta,deployment});
  });
  const execute=value.ports.execute;
  value.ports.execute=(exe,args,options)=>{
    const result=execute(exe,args,options);
    if(args[1]!=='preview') return result;
    value.deployment.number=28;
    value.deployment.env.PUBLIC_CATALOG_COORDINATOR.namespace_id=existingCatalogRoom;
    return {...result,stdout:JSON.stringify({preview:value.meta,deployment:value.deployment})};
  };
  value.accessBlocked=true;
  value.bucketManaged={enabled:false}; value.bucketDomains={domains:[]};
  value.hyperdrive={id:'0c05fec2924b4f3b9225f3d689ba7ea9',origin:{database:'vapt',user:'vapt_api_preview',
    host:'ep-hidden-bird-b673zocn.c-2.us-east-1.aws.neon.tech',port:5432,scheme:'postgres'},caching:{disabled:true}};
  const transport=value.ports.fetch;
  value.ports.fetch=async(url,options)=>{
    if(url==='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev') {
      assert.equal(options.method,'GET'); assert.equal(options.redirect,'manual'); assert.equal(options.headers,undefined);
      return value.accessBlocked?new Response(null,{status:302,headers:{location:'https://synthetic.cloudflareaccess.com/cdn-cgi/access/login/preview'}}):Response.json({public:true});
    }
    if(url===base+'/hyperdrive/configs/0c05fec2924b4f3b9225f3d689ba7ea9') return Response.json({success:true,result:value.hyperdrive});
    if(url===base+'/r2/buckets/vapt-catalog-preview/domains/managed') return Response.json({success:true,result:value.bucketManaged});
    if(url===base+'/r2/buckets/vapt-catalog-preview/domains/custom') return Response.json({success:true,result:value.bucketDomains});
    return transport(url,options);
  };
  return value;
}

test('compatible publication replaces only the pinned inert deployment and retains both namespaces',async()=>{
  const {runCatalogInertPreview}=await feature(); const value=compatibleFixture();
  const result=await runCatalogInertPreview(['publish-compatible'],value.ports);
  assert.equal(result.status,0); assert.equal(value.applied(),true);
  assert.equal(result.report.compatiblePublished,true);
  assert.equal(result.report.previousDeploymentId,compatibleBaseline);
  assert.equal(result.report.catalogNamespaceId,existingCatalogRoom);
  assert.equal(result.report.realtimeNamespaceId,oldRoom);
  assert.equal(result.report.reader,false); assert.equal(result.report.writer,false);
  assert.equal(result.report.activationReady,false); assert.equal(value.commands.length,2);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|Bearer/);
});

test('compatible publication is one-shot; inspect and old apply retain read-only prepared behavior',async()=>{
  const {runCatalogInertPreview}=await feature(); const value=compatibleFixture();
  for(const action of ['inspect','apply']) assert.equal((await runCatalogInertPreview([action],value.ports)).status,0);
  assert.equal(value.applied(),false);
  assert.equal((await runCatalogInertPreview(['publish-compatible'],value.ports)).status,0);
  const again=await runCatalogInertPreview(['publish-compatible'],value.ports);
  assert.equal(again.status,1); assert.equal(value.commands.filter(c=>c.args[1]==='preview').length,1);
});

for(const [label,change] of [
  ['another deployment',({deployment})=>{deployment.id='11111111-1111-4111-8111-111111111111';}],
  ['another generation',({deployment})=>{deployment.number=28;}],
  ['unprepared preview',({deployment})=>{deployment.migration_tag='stage12-realtime-sqlite-v1';}],
  ['different catalog namespace',({deployment})=>{deployment.env.PUBLIC_CATALOG_COORDINATOR.namespace_id=newRoom;}],
  ['writer already enabled',({deployment})=>{deployment.env.PUBLIC_CATALOG_WRITER_ENABLED.text='true';}],
]) test(`compatible publication rejects ${label} before the write`,async()=>{
  const {runCatalogInertPreview}=await feature(); const value=compatibleFixture(change);
  const result=await runCatalogInertPreview(['publish-compatible'],value.ports);
  assert.equal(result.status,1); assert.equal(value.applied(),false);
});

for(const [label,change] of [
  ['recreated catalog namespace',v=>{v.deployment.env.PUBLIC_CATALOG_COORDINATOR.namespace_id=newRoom;}],
  ['unexpected generation',v=>{v.deployment.number=29;}],
  ['reader enabled',v=>{v.deployment.env.PUBLIC_CATALOG_READER_ENABLED.text='true';}],
  ['lost secret',v=>{delete v.deployment.env.BETTER_AUTH_SECRET;}],
  ['larger CPU',v=>{v.deployment.limits.cpu_ms=30000;}],
]) test(`compatible publication reports uncertain ${label} without retry`,async()=>{
  const {runCatalogInertPreview}=await feature(); const value=compatibleFixture(); const execute=value.ports.execute;
  value.ports.execute=(exe,args,options)=>{const result=execute(exe,args,options);if(args[1]==='preview') change(value);return result;};
  const result=await runCatalogInertPreview(['publish-compatible'],value.ports);
  assert.equal(value.applied(),true); assert.equal(result.status,1);
  assert.equal(result.report.code,'catalog_preview_deployment_uncertain');
  assert.equal(value.commands.filter(c=>c.args[1]==='preview').length,1);
});

test('compatible publication rejects target overrides before auth and hides uncertain CLI failures',async()=>{
  const {runCatalogInertPreview}=await feature();
  for(const args of [['publish-compatible','production'],['publish-compatible','--force']]) {
    assert.equal((await runCatalogInertPreview(args,{execute(){throw Error('Must not start');}})).status,1);
  }
  const value=compatibleFixture(); const execute=value.ports.execute;
  value.ports.execute=(exe,args,options)=>args[1]==='auth'?execute(exe,args,options):{status:1,stdout:'synthetic-secret',stderr:'synthetic-secret'};
  const result=await runCatalogInertPreview(['publish-compatible'],value.ports);
  assert.equal(result.status,1); assert.equal(result.report.code,'catalog_preview_deployment_uncertain');
  assert.equal(result.report.activationReady,false); assert.doesNotMatch(JSON.stringify(result),/synthetic-secret/);
});

for(const worker of ['vapt-api-production','vapt-web','vapt-api-parallel']) {
  test(`compatible publication detects drift in ${worker} without repairing it`,async()=>{
    const {runCatalogInertPreview}=await feature(); const value=compatibleFixture(); const transport=value.ports.fetch;
    value.ports.fetch=async(url,options)=>value.applied()&&url.endsWith(`/workers/scripts/${worker}/deployments`)
      ?Response.json({success:true,result:{deployments:[{id:'unexpected',versions:[]}]}}):transport(url,options);
    const result=await runCatalogInertPreview(['publish-compatible'],value.ports);
    assert.equal(value.applied(),true); assert.equal(result.status,1);
    assert.equal(result.report.code,'catalog_preview_deployment_uncertain');
    assert.equal(value.commands.filter(c=>c.args[1]==='preview').length,1);
  });
}

for(const [label,change] of [
  ['Access removed',v=>{v.accessBlocked=false;}],
  ['public R2',v=>{v.bucketManaged.enabled=true;}],
  ['R2 custom domain',v=>{v.bucketDomains.domains=[{domain:'public.invalid'}];}],
  ['wrong database host',v=>{v.hyperdrive.origin.host='ep-holy-wildflower-b6vtv1dd-pooler.c-2.us-east-1.aws.neon.tech';}],
  ['wrong database role',v=>{v.hyperdrive.origin.user='neondb_owner';}],
  ['database query cache',v=>{v.hyperdrive.caching.disabled=false;}],
]) test(`compatible publication rejects ${label} at resource readback`,async()=>{
  const {runCatalogInertPreview}=await feature(); const value=compatibleFixture(); change(value);
  const result=await runCatalogInertPreview(['publish-compatible'],value.ports);
  assert.equal(result.status,1); assert.equal(value.applied(),false);
});

test('compatible publication treats lost Access after write as uncertain without another write',async()=>{
  const {runCatalogInertPreview}=await feature(); const value=compatibleFixture(); const execute=value.ports.execute;
  value.ports.execute=(exe,args,options)=>{const result=execute(exe,args,options);if(args[1]==='preview')value.accessBlocked=false;return result;};
  const result=await runCatalogInertPreview(['publish-compatible'],value.ports);
  assert.equal(value.applied(),true); assert.equal(result.status,1);
  assert.equal(result.report.code,'catalog_preview_deployment_uncertain');
  assert.equal(value.commands.filter(c=>c.args[1]==='preview').length,1);
});

function rotationFixture(){
  const value=compatibleFixture(({deployment})=>{deployment.id='fca1102f-05b4-488e-bc6a-11d1f82e0bd9';deployment.number=28;deployment.main_module='parallel-preview-entry.js';});
  const transport=value.ports.fetch;value.patches=[];
  value.ports.fetch=async(url,options)=>{
    if(options.method==='PATCH'){
      value.patches.push({url,options});
      // Wrangler's secret operator uses the supported latest PATCH endpoint;
      // immutable deployment UUIDs remain valid GET targets, not clone targets.
      assert.equal(url,base+previewPath+'/deployments/latest');
      assert.equal(options.headers['Content-Type'],'application/merge-patch+json');
      const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body.env),['PARALLEL_PREVIEW_TOKEN']);
      assert.deepEqual(body.env.PARALLEL_PREVIEW_TOKEN,{type:'secret_text',text:'synthetic-new-bearer-32-characters-long'});
      value.deployment.id='22222222-2222-4222-8222-222222222222';value.deployment.number=29;
      return Response.json({success:true,result:value.deployment});
    }
    return transport(url,options);
  };return value;
}
test('bearer rotation patches only the pinned preview secret without a source upload and verifies deployment29',async()=>{
  const {rotateTenantPreviewBearer}=await feature();assert.equal(typeof rotateTenantPreviewBearer,'function','scoped bearer rotation not implemented');
  const value=rotationFixture(),result=await rotateTenantPreviewBearer('synthetic-new-bearer-32-characters-long',value.ports);
  assert.equal(result.status,0);assert.equal(result.report.deploymentNumber,29);assert.equal(result.report.reader,false);assert.equal(result.report.writer,false);
  assert.equal(value.patches.length,1);assert.equal(value.commands.length,1);assert.equal(value.applied(),false);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-new-bearer|synthetic-secret|author_email/);
  assert.equal((await rotateTenantPreviewBearer('synthetic-new-bearer-32-characters-long',value.ports)).status,1);assert.equal(value.patches.length,1);
});
for(const [label,change]of [
  ['changed baseline',v=>{v.deployment.number=29;}],['enabled writer',v=>{v.deployment.env.PUBLIC_CATALOG_WRITER_ENABLED.text='true';}],
  ['public bucket',v=>{v.bucketManaged.enabled=true;}],['Access removed',v=>{v.accessBlocked=false;}],
])test(`bearer rotation rejects ${label} before PATCH`,async()=>{
  const {rotateTenantPreviewBearer}=await feature();assert.equal(typeof rotateTenantPreviewBearer,'function');const value=rotationFixture();change(value);
  assert.equal((await rotateTenantPreviewBearer('synthetic-new-bearer-32-characters-long',value.ports)).status,1);assert.equal(value.patches.length,0);
});
test('bearer rotation rejects malformed secret before auth and never retries uncertain PATCH',async()=>{
  const {rotateTenantPreviewBearer}=await feature();assert.equal(typeof rotateTenantPreviewBearer,'function');
  assert.equal((await rotateTenantPreviewBearer('short',{execute(){throw Error('Must not auth');}})).status,1);
  const value=rotationFixture(),transport=value.ports.fetch;let writes=0;
  value.ports.fetch=async(url,options)=>{if(options.method==='PATCH'){writes++;throw Error('synthetic-secret');}return transport(url,options);};
  const result=await rotateTenantPreviewBearer('synthetic-new-bearer-32-characters-long',value.ports);assert.equal(writes,1);assert.equal(result.status,1);assert.equal(result.report.code,'catalog_preview_rotation_uncertain');assert.doesNotMatch(JSON.stringify(result),/synthetic-secret/);
});
test('bearer rotation detects metadata drift after PATCH without repairing or rolling back',async()=>{
  const {rotateTenantPreviewBearer}=await feature();assert.equal(typeof rotateTenantPreviewBearer,'function');const value=rotationFixture(),transport=value.ports.fetch;
  value.ports.fetch=async(url,options)=>{const response=await transport(url,options);if(options.method==='PATCH')value.deployment.main_module='another.js';return response;};
  const result=await rotateTenantPreviewBearer('synthetic-new-bearer-32-characters-long',value.ports);assert.equal(result.status,1);assert.equal(value.patches.length,1);
});
test('bearer rotation rechecks pinned latest immediately before PATCH and refuses concurrent deployment drift',async()=>{
  const {rotateTenantPreviewBearer}=await feature();const value=rotationFixture(),transport=value.ports.fetch;let latestReads=0;
  value.ports.fetch=async(url,options)=>{
    if(options.method==='GET'&&url.endsWith('/deployments/latest')&&++latestReads===3){value.deployment.id='33333333-3333-4333-8333-333333333333';value.deployment.number=29;}
    return transport(url,options);
  };
  assert.equal((await rotateTenantPreviewBearer('synthetic-new-bearer-32-characters-long',value.ports)).status,1);
  assert.equal(value.patches.length,0);
});
test('bearer rotation reports only allowlisted HTTP diagnostics for provider rejection, without echoing body or retry',async()=>{
  const {rotateTenantPreviewBearer}=await feature();const value=rotationFixture(),transport=value.ports.fetch;let writes=0;
  value.ports.fetch=async(url,options)=>{if(options.method==='PATCH'){writes++;return Response.json({success:false,errors:[{code:10032,message:'synthetic-secret',details:'synthetic-new-bearer'}]},{status:400});}return transport(url,options);};
  const result=await rotateTenantPreviewBearer('synthetic-new-bearer-32-characters-long',value.ports);
  assert.equal(result.status,1);assert.equal(result.report.httpStatus,400);assert.deepEqual(result.report.providerCodes,[10032]);assert.equal(writes,1);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|synthetic-new-bearer/);
});
