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
