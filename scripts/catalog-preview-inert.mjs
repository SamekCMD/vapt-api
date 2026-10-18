import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkCatalogConfig } from './verify-catalog-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const account = '3ce69408aa5112617a282957aba71932';
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const previewPath = '/workers/workers/vapt-api-parallel/previews/stage11-inert';
const previewId = '56efdbf131174b8fba43387369c6f1e3';
const realtimeId = '69fbe1f54ad64a93b7cb761910da094a';
const configuration = 'wrangler.worker-catalog-preview.jsonc';
const migration = 'catalog-publication-preview-sqlite-v1';
const secretNames = ['BETTER_AUTH_SECRET','PARALLEL_PREVIEW_TOKEN','PUBLIC_ORDER_TOKEN_SECRET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','TURNSTILE_SECRET_KEY'];
const controlPaths = ['vapt-api-production','vapt-web','vapt-api-parallel'].map(name=>`/workers/scripts/${name}/deployments`);
const ensure = (condition,code) => { if(!condition) throw Object.assign(new Error('Catalog preview guard failed'),{safeCode:code}); };
const failed = code => ({status:1,report:{ok:false,code,activationReady:false}});

function checkPreview(meta,deployment,config,prepared) {
  ensure(meta?.id===previewId && meta.name==='stage11-inert' && meta.slug==='stage11-inert'
    && isDeepStrictEqual(meta.urls,['https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev']), 'catalog_preview_identity_invalid');
  ensure(meta.observability?.enabled===false && meta.observability.logs?.enabled===false
    && meta.observability.traces?.enabled===false && meta.logpush===false && isDeepStrictEqual(meta.tail_consumers,[]),'catalog_preview_telemetry_invalid');
  ensure(deployment?.migration_tag===(prepared?migration:'stage12-realtime-sqlite-v1'), 'catalog_preview_migration_invalid');
  const env=deployment.env??{}; const expectedNames=[...secretNames];
  for(const [name,text] of Object.entries(config.previews.vars)) {
    if(!prepared && name.startsWith('PUBLIC_CATALOG_')) continue;
    expectedNames.push(name); ensure(env[name]?.type==='plain_text' && env[name].text===text,'catalog_preview_vars_invalid');
  }
  for(const name of secretNames) ensure(env[name]?.type==='secret_text','catalog_preview_secrets_invalid');
  for(const rate of config.previews.ratelimits) {
    expectedNames.push(rate.name); const binding=env[rate.name];
    ensure(binding?.type==='ratelimit' && binding.namespace_id===rate.namespace_id && isDeepStrictEqual(binding.simple,rate.simple),'catalog_preview_rates_invalid');
  }
  for(const bucket of config.previews.r2_buckets) {
    if(!prepared && bucket.binding==='PUBLIC_CATALOG_BUCKET') continue;
    expectedNames.push(bucket.binding); ensure(env[bucket.binding]?.type==='r2_bucket' && env[bucket.binding].bucket_name===bucket.bucket_name,'catalog_preview_storage_invalid');
  }
  expectedNames.push('HYPERDRIVE','RESTAURANT_REALTIME');
  ensure(env.HYPERDRIVE?.type==='hyperdrive' && env.HYPERDRIVE.id==='0c05fec2924b4f3b9225f3d689ba7ea9','catalog_preview_database_invalid');
  ensure(env.RESTAURANT_REALTIME?.type==='durable_object_namespace' && env.RESTAURANT_REALTIME.class_name==='RestaurantRealtime'
    && env.RESTAURANT_REALTIME.namespace_id===realtimeId,'catalog_preview_realtime_invalid');
  if(prepared) {
    expectedNames.push('PUBLIC_CATALOG_COORDINATOR'); const room=env.PUBLIC_CATALOG_COORDINATOR;
    ensure(room?.type==='durable_object_namespace' && room.class_name==='PublicCatalogCoordinator'
      && /^[a-f0-9]{32}$/.test(room.namespace_id) && ![realtimeId,'d3ad7a4008c64124b765f934986956da'].includes(room.namespace_id),'catalog_preview_namespace_invalid');
  }
  ensure(isDeepStrictEqual(Object.keys(env).sort(),expectedNames.sort()),'catalog_preview_bindings_invalid');
}

// This narrow, separately authorized operation never opens the general deploy
// operator. No supplied worker/account/config/flags/secrets or automatic retry.
export async function runCatalogInertPreview(args,ports={}) {
  if(!Array.isArray(args)||args.length!==1||!['inspect','apply'].includes(args[0])) return failed('catalog_preview_arguments_invalid');
  const execute=ports.execute??spawnSync; const transport=ports.fetch??fetch;
  let attempted=false; let credential;
  const options={cwd:root,shell:false,windowsHide:true,encoding:'utf8',stdio:'pipe',maxBuffer:2_097_152,timeout:120_000,
    env:{...process.env,CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_ENV:'',CLOUDFLARE_PREVIEW_BUILD:'false',
      WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG:'log'}};
  const cli=resolve(root,'node_modules/wrangler/bin/wrangler.js');
  async function read(path) {
    const response=await transport(base+path,{method:'GET',headers:{Authorization:`Bearer ${credential}`},redirect:'error',signal:AbortSignal.timeout(15000)});
    ensure(response.ok,'catalog_preview_read_failed');
    const text=await response.text(); ensure(text.length<=262_144,'catalog_preview_read_failed');
    const body=JSON.parse(text); ensure(body.success===true && body.result,'catalog_preview_read_failed'); return body.result;
  }
  async function controls() {
    const snapshots=[];
    for(const path of controlPaths) {
      const result=await read(path); ensure(Array.isArray(result.deployments) && result.deployments.length>0,'catalog_preview_control_invalid');
      snapshots.push(result.deployments.map(d=>({id:d.id,versions:d.versions})));
    }
    return snapshots;
  }
  try {
    const config=JSON.parse(readFileSync(resolve(root,configuration),'utf8'));
    ensure(checkCatalogConfig(config).ok,'catalog_preview_configuration_invalid');
    const auth=execute(process.execPath,[cli,'auth','token','--json','--config',configuration],options);
    ensure(auth.status===0&&!auth.error&&!auth.signal,'catalog_preview_auth_unavailable');
    const parsed=JSON.parse(auth.stdout);
    ensure(['oauth','api_token'].includes(parsed.type)&&typeof parsed.token==='string'&&parsed.token.length>0,'catalog_preview_auth_unavailable');
    credential=parsed.token; parsed.token='';
    const meta=await read(previewPath); const before=await read(previewPath+'/deployments/latest');
    const alreadyPrepared=before.migration_tag===migration;
    checkPreview(meta,before,config,alreadyPrepared);
    if(args[0]==='inspect'||alreadyPrepared) return {status:0,report:{ok:true,prepared:alreadyPrepared,previewId,deploymentId:before.id,deploymentNumber:before.number,activationReady:false}};
    // The provider evicts oldest deployments at its 100-deployment limit. A
    // cumulative number below 100 is conservative proof this apply cannot do so.
    ensure(Number.isInteger(before.number)&&before.number>=1&&before.number<100,'catalog_preview_history_requires_check');
    const controlBefore=await controls();
    attempted=true;
    const deployed=execute(process.execPath,[cli,'preview','--name','stage11-inert','--worker-name','vapt-api-parallel','--config',configuration,'--json'],options);
    ensure(deployed.status===0&&!deployed.error&&!deployed.signal,'catalog_preview_deployment_uncertain');
    const upload=JSON.parse(deployed.stdout); checkPreview(upload.preview,upload.deployment,config,true);
    const afterMeta=await read(previewPath); const after=await read(previewPath+'/deployments/latest');
    checkPreview(afterMeta,after,config,true);
    ensure(after.id===upload.deployment.id && after.id!==before.id,'catalog_preview_readback_mismatch');
    ensure(isDeepStrictEqual(await controls(),controlBefore),'catalog_preview_control_changed');
    return {status:0,report:{ok:true,prepared:true,previewId,deploymentId:after.id,previousDeploymentId:before.id,
      catalogNamespaceId:after.env.PUBLIC_CATALOG_COORDINATOR.namespace_id,realtimeNamespaceId:realtimeId,
      reader:false,writer:false,controlDeploymentsUnchanged:true,cpuLimitRequested:1000,cpuReadbackVerified:false,activationReady:false}};
  } catch(error) { return failed(attempted?'catalog_preview_deployment_uncertain':error?.safeCode??'catalog_preview_preflight_failed'); }
  finally { credential=undefined; }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await runCatalogInertPreview(process.argv.slice(2));console.log(JSON.stringify(result.report));process.exitCode=result.status;
}
