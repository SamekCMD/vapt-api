import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const feature = () => import('./catalog-preview-canary.mjs').catch(() => ({}));
const config = JSON.parse(readFileSync(new URL('../wrangler.worker-catalog-preview.jsonc', import.meta.url)));
const base = 'https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932';
const path = '/workers/workers/vapt-api-parallel/previews/stage11-inert';
const bearer = 'synthetic-preview-bearer-aaaaaaaaaaaaaaaa';
function fixture() {
  const env = Object.fromEntries(Object.entries(config.previews.vars).map(([name,text]) => [name,{type:'plain_text',text}]));
  for (const name of ['BETTER_AUTH_SECRET','PARALLEL_PREVIEW_TOKEN','PUBLIC_ORDER_TOKEN_SECRET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','TURNSTILE_SECRET_KEY']) env[name]={type:'secret_text'};
  for (const rate of config.previews.ratelimits) env[rate.name]={type:'ratelimit',namespace_id:rate.namespace_id,simple:rate.simple};
  env.HYPERDRIVE={type:'hyperdrive',id:'0c05fec2924b4f3b9225f3d689ba7ea9'};
  env.R2_BUCKET={type:'r2_bucket',bucket_name:'vapt-assets-preview'};
  env.PUBLIC_CATALOG_BUCKET={type:'r2_bucket',bucket_name:'vapt-catalog-preview'};
  env.RESTAURANT_REALTIME={type:'durable_object_namespace',class_name:'RestaurantRealtime',namespace_id:'69fbe1f54ad64a93b7cb761910da094a'};
  env.PUBLIC_CATALOG_COORDINATOR={type:'durable_object_namespace',class_name:'PublicCatalogCoordinator',namespace_id:'eeda94fea90349be8b62b82067c79b27'};
  const deployment={id:'35fd7ac3-2601-46bb-adec-39ef46813131',number:32,limits:{cpu_ms:1000},env,
    migration_tag:'catalog-publication-preview-sqlite-v1',main_module:'index.js',compatibility_date:'2026-09-28',compatibility_flags:['nodejs_compat'],usage_model:'standard',startup_time_ms:10,
    urls:['https://35fd7ac3-vapt-api-parallel.autoistloko.workers.dev']};
  const meta={id:'56efdbf131174b8fba43387369c6f1e3',name:'stage11-inert',slug:'stage11-inert',urls:['https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev'],
    observability:{enabled:false,logs:{enabled:false},traces:{enabled:false}},logpush:false,tail_consumers:[]};
  const value={deployment,meta,patches:[],latestReads:0,beforeRead:()=>{},afterPatch:()=>{},control:'unchanged'};
  value.ports={
    execute(exe,args,options) {
      assert.equal(args[1],'auth');assert.equal(options.env.WRANGLER_WRITE_LOGS,'false');
      return {status:0,stdout:JSON.stringify({type:'oauth',token:'synthetic-provider-token'})};
    },
    async fetch(url,options) {
      if(url==='https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev')
        return new Response(null,{status:302,headers:{location:'https://test.cloudflareaccess.com/cdn-cgi/access/login/test'}});
      assert.equal(options.headers.Authorization,'Bearer synthetic-provider-token');
      const endpoint=url.slice(base.length);let result;
      if(options.method==='PATCH') {
        assert.equal(endpoint,path+'/deployments/latest');
        assert.equal(options.headers['Content-Type'],'application/merge-patch+json');
        const body=JSON.parse(options.body);value.patches.push(body);
        // Provider boundary double: merge env but never return secret values.
        for(const [key,binding] of Object.entries(body.env)) deployment.env[key]=binding.type==='secret_text'?{type:'secret_text'}:binding;
        deployment.number++;deployment.id=deployment.number===33?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        deployment.urls=[`https://${deployment.id.slice(0,8)}-vapt-api-parallel.autoistloko.workers.dev`];
        await value.afterPatch();result=deployment;
      } else {
        assert.equal(options.method,'GET');
        if(endpoint===path) result=meta;
        else if(endpoint===path+'/deployments/latest') {value.latestReads++;value.beforeRead(value.latestReads);result=deployment;}
        else if(endpoint.endsWith('/deployments')) result={deployments:[{id:value.control,versions:[{version_id:'same',percentage:100}]}]};
        else if(endpoint.endsWith('/domains/managed')) result={enabled:false};
        else if(endpoint.endsWith('/domains/custom')) result={domains:[]};
        else if(endpoint.startsWith('/hyperdrive/')) result={id:'0c05fec2924b4f3b9225f3d689ba7ea9',origin:{host:'ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech',scheme:'postgres',database:'vapt',user:'vapt_api_preview',port:5432},caching:{disabled:true}};
        else throw Error('Unexpected provider endpoint');
      }
      return Response.json({success:true,result});
    },
  };
  return value;
}
test('one preview-only writer window preserves reader/CPU/resources and closes once without serializing credentials',async()=>{
  const {openCatalogPreviewCanary}=await feature();assert.equal(typeof openCatalogPreviewCanary,'function');
  const f=fixture();const window=await openCatalogPreviewCanary(bearer,f.ports);
  assert.equal(window.status,0);assert.equal(window.report.writer,true);assert.equal(window.report.reader,false);
  assert.equal(window.report.deploymentNumber,33);assert.equal(window.report.cpuLimitMs,1000);
  assert.deepEqual(Object.keys(f.patches[0].env).sort(),['PARALLEL_PREVIEW_TOKEN','PUBLIC_CATALOG_WRITER_ENABLED']);
  assert.equal(f.patches[0].env.PARALLEL_PREVIEW_TOKEN.text,bearer);
  const closed=await window.close();assert.equal(closed.status,0);assert.equal(closed.report.deploymentNumber,34);
  assert.equal(closed.report.writer,false);assert.equal(f.deployment.env.PUBLIC_CATALOG_READER_ENABLED.text,'false');
  assert.deepEqual(f.patches[1].env,{PUBLIC_CATALOG_WRITER_ENABLED:{type:'plain_text',text:'false'}});
  assert.equal((await window.close()).status,1);assert.equal(f.patches.length,2);
  assert.doesNotMatch(JSON.stringify([window,closed]),/synthetic-provider-token|synthetic-preview-bearer/);
  assert.equal(closed.report.activationReady,false);
});
for(const [name,mutate] of [
  ['baseline changed',f=>f.deployment.number=33],
  ['old baseline ID',f=>f.deployment.id='6110a9fe-0ee6-4faa-920e-23f73f7a504d'],
  ['CPU raised',f=>f.deployment.limits.cpu_ms=30000],
  ['reader enabled',f=>f.deployment.env.PUBLIC_CATALOG_READER_ENABLED.text='true'],
  ['logs enabled',f=>f.meta.observability.enabled=true],
])test(`open rejects ${name} before any write`,async()=>{
  const {openCatalogPreviewCanary}=await feature();assert.equal(typeof openCatalogPreviewCanary,'function');
  const f=fixture();mutate(f);const result=await openCatalogPreviewCanary(bearer,f.ports);
  assert.equal(result.status,1);assert.equal(f.patches.length,0);
});
test('invalid credential input does not authenticate or issue any provider call',async()=>{
  const {openCatalogPreviewCanary}=await feature();assert.equal(typeof openCatalogPreviewCanary,'function');
  const result=await openCatalogPreviewCanary('bad',{execute(){assert.fail('No authentication expected');},fetch(){assert.fail('No HTTP expected');}});
  assert.equal(result.status,1);
});
test('intervening deployment before PATCH is rejected rather than overwritten',async()=>{
  const {openCatalogPreviewCanary}=await feature();assert.equal(typeof openCatalogPreviewCanary,'function');
  const f=fixture();f.beforeRead=n=>{if(n===3) f.deployment.number=99;};
  assert.equal((await openCatalogPreviewCanary(bearer,f.ports)).status,1);assert.equal(f.patches.length,0);
});
test('uncertain PATCH is not retried, repaired or reported as a successful window',async()=>{
  const {openCatalogPreviewCanary}=await feature();assert.equal(typeof openCatalogPreviewCanary,'function');
  const f=fixture();f.afterPatch=()=>{throw Error('synthetic-provider-token');};
  const result=await openCatalogPreviewCanary(bearer,f.ports);
  assert.equal(result.status,1);assert.equal(result.report.code,'catalog_canary_open_uncertain');assert.equal(f.patches.length,1);
  assert.equal(result.report.writerMayBeActive,true);assert.doesNotMatch(JSON.stringify(result),/synthetic-provider-token/);
});
test('close refuses a different active deployment and never rolls back unrelated code',async()=>{
  const {openCatalogPreviewCanary}=await feature();assert.equal(typeof openCatalogPreviewCanary,'function');
  const f=fixture();const window=await openCatalogPreviewCanary(bearer,f.ports);assert.equal(window.status,0);
  f.deployment.id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const result=await window.close();assert.equal(result.status,1);assert.equal(f.patches.length,1);
  assert.equal(result.report.writerMayBeActive,true);
});
test('post-PATCH resource drift fails the canary without false CPU certification',async()=>{
  const {openCatalogPreviewCanary}=await feature();assert.equal(typeof openCatalogPreviewCanary,'function');
  const f=fixture();f.afterPatch=()=>{f.deployment.limits.cpu_ms=30000;};
  const result=await openCatalogPreviewCanary(bearer,f.ports);
  assert.equal(result.status,1);assert.equal(result.report.cpuWorkloadVerified,false);assert.equal(f.patches.length,1);
});
for(const [name,mutate] of [
  ['reader activated',f=>f.deployment.env.PUBLIC_CATALOG_READER_ENABLED.text='true'],
  ['lost secret',f=>delete f.deployment.env.STRIPE_SECRET_KEY],
  ['changed binding',f=>f.deployment.env.HYPERDRIVE.id='production'],
  ['production control changed',f=>f.control='changed'],
])test(`open detects post-PATCH ${name} without retry`,async()=>{
  const {openCatalogPreviewCanary}=await feature();const f=fixture();f.afterPatch=()=>mutate(f);
  const result=await openCatalogPreviewCanary(bearer,f.ports);assert.equal(result.status,1);assert.equal(f.patches.length,1);
  assert.equal(result.report.writerMayBeActive,true);
});
test('opening refuses a public catalog bucket before any PATCH',async()=>{
  const {openCatalogPreviewCanary}=await feature();const f=fixture();const fetch=f.ports.fetch;
  f.ports.fetch=(url,options)=>url.endsWith('/domains/managed')?Response.json({success:true,result:{enabled:true}}):fetch(url,options);
  assert.equal((await openCatalogPreviewCanary(bearer,f.ports)).status,1);assert.equal(f.patches.length,0);
});
test('closing never retries a lost PATCH response and does not certify fixture cleanup',async()=>{
  const {openCatalogPreviewCanary}=await feature();const f=fixture();const window=await openCatalogPreviewCanary(bearer,f.ports);
  f.afterPatch=()=>{throw Error('Lost close response');};
  const result=await window.close();assert.equal(result.status,1);assert.equal(result.report.code,'catalog_canary_close_uncertain');
  assert.equal(f.patches.length,2);assert.equal((await window.close()).status,1);assert.equal(f.patches.length,2);
});
test('a confirmed own writer window can still close when an external post-check fails',async()=>{
  const {openCatalogPreviewCanary}=await feature();const f=fixture();f.afterPatch=()=>{if(f.patches.length===1)f.control='changed';};
  const window=await openCatalogPreviewCanary(bearer,f.ports);assert.equal(window.status,1);
  assert.equal(typeof window.close,'function','confirmed own window must retain its scoped admission closer');
  const closed=await window.close();assert.equal(closed.status,1,'external control drift remains a failed canary');
  assert.equal(closed.report.admissionClosed,true);assert.equal(closed.report.writerMayBeActive,false);
  assert.equal(f.deployment.env.PUBLIC_CATALOG_WRITER_ENABLED.text,'false');assert.equal(f.patches.length,2);
});
test('metadata drift cannot strand an otherwise confirmed own writer admission open',async()=>{
  const {openCatalogPreviewCanary}=await feature();const f=fixture();f.afterPatch=()=>{f.meta.observability.logs.enabled=true;};
  const window=await openCatalogPreviewCanary(bearer,f.ports);assert.equal(window.status,1);assert.equal(typeof window.close,'function');
  const closed=await window.close();assert.equal(closed.status,1);assert.equal(closed.report.admissionClosed,true);
  assert.equal(f.deployment.env.PUBLIC_CATALOG_WRITER_ENABLED.text,'false');
  assert.equal(f.meta.observability.logs.enabled,true,'admission close must not overwrite external metadata');
});
