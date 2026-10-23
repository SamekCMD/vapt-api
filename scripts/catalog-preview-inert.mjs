import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkCatalogConfig } from './verify-catalog-config.mjs';
import { assertCacheDisabledResource } from './verify-hyperdrive-preview.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const account = '3ce69408aa5112617a282957aba71932';
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const previewPath = '/workers/workers/vapt-api-parallel/previews/stage11-inert';
const previewId = '56efdbf131174b8fba43387369c6f1e3';
const realtimeId = '69fbe1f54ad64a93b7cb761910da094a';
const configuration = 'wrangler.worker-catalog-preview.jsonc';
const migration = 'catalog-publication-preview-sqlite-v1';
// One specifically authorized code refresh, not a general deploy or retry path.
const compatibleBaseline = '7b51fca2-207e-4e29-948e-159761b362ea';
const compatibleCatalogNamespace = 'eeda94fea90349be8b62b82067c79b27';
const secretNames = ['BETTER_AUTH_SECRET','PARALLEL_PREVIEW_TOKEN','PUBLIC_ORDER_TOKEN_SECRET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','TURNSTILE_SECRET_KEY'];
const controlPaths = ['vapt-api-production','vapt-web','vapt-api-parallel'].map(name=>`/workers/scripts/${name}/deployments`);
const ensure = (condition,code) => { if(!condition) throw Object.assign(new Error('Catalog preview guard failed'),{safeCode:code}); };
const failed = code => ({status:1,report:{ok:false,code,activationReady:false}});

async function checkCompatibleResources(read,transport) {
  const access=await transport('https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev',
    {method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000)});
  const location=new URL(access.headers.get('location')??'');
  await access.body?.cancel();
  ensure(access.status===302 && location.protocol==='https:' && location.hostname.endsWith('.cloudflareaccess.com')
    && location.pathname.startsWith('/cdn-cgi/access/login/'),'catalog_preview_access_invalid');
  const managed=await read('/r2/buckets/vapt-catalog-preview/domains/managed');
  const custom=await read('/r2/buckets/vapt-catalog-preview/domains/custom');
  ensure(managed.enabled===false && Array.isArray(custom.domains) && custom.domains.length===0,'catalog_preview_bucket_not_private');
  const database=await read('/hyperdrive/configs/0c05fec2924b4f3b9225f3d689ba7ea9');
  const host=database.origin?.host;
  ensure(database.id==='0c05fec2924b4f3b9225f3d689ba7ea9' && typeof host==='string'
    && host.startsWith('ep-hidden-bird-b673zocn.') && host.endsWith('.neon.tech')
    && database.origin.scheme==='postgres','catalog_preview_database_origin_invalid');
  assertCacheDisabledResource(database,host);
}

function checkPreview(meta,deployment,config,prepared) {
  ensure(meta?.id===previewId && meta.name==='stage11-inert' && meta.slug==='stage11-inert'
    && isDeepStrictEqual(meta.urls,['https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev']), 'catalog_preview_identity_invalid');
  ensure(meta.observability?.enabled===false && meta.observability.logs?.enabled===false
    && meta.observability.traces?.enabled===false && meta.logpush===false && isDeepStrictEqual(meta.tail_consumers,[]),'catalog_preview_telemetry_invalid');
  ensure(deployment?.migration_tag===(prepared?migration:'stage12-realtime-sqlite-v1'), 'catalog_preview_migration_invalid');
  if(prepared) ensure(deployment.limits?.cpu_ms===1000,'catalog_preview_cpu_limit_invalid');
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
  if(!Array.isArray(args)||args.length!==1||!['inspect','apply','publish-compatible'].includes(args[0])) return failed('catalog_preview_arguments_invalid');
  const compatible=args[0]==='publish-compatible';
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
    if(compatible) ensure(alreadyPrepared && before.id===compatibleBaseline && before.number===27
      && before.env.PUBLIC_CATALOG_COORDINATOR.namespace_id===compatibleCatalogNamespace,'catalog_preview_compatible_baseline_changed');
    if(args[0]==='inspect'||(!compatible&&alreadyPrepared)) return {status:0,report:{ok:true,prepared:alreadyPrepared,previewId,deploymentId:before.id,deploymentNumber:before.number,
      ...(alreadyPrepared?{cpuLimitMs:1000,cpuLimitVerified:true,cpuWorkloadVerified:false}:{}),activationReady:false}};
    // The provider evicts oldest deployments at its 100-deployment limit. A
    // cumulative number below 100 is conservative proof this apply cannot do so.
    ensure(Number.isInteger(before.number)&&before.number>=1&&before.number<100,'catalog_preview_history_requires_check');
    if(compatible) await checkCompatibleResources(read,transport);
    const controlBefore=await controls();
    attempted=true;
    const deployed=execute(process.execPath,[cli,'preview','--name','stage11-inert','--worker-name','vapt-api-parallel','--config',configuration,'--json'],options);
    ensure(deployed.status===0&&!deployed.error&&!deployed.signal,'catalog_preview_deployment_uncertain');
    const upload=JSON.parse(deployed.stdout); checkPreview(upload.preview,upload.deployment,config,true);
    if(compatible) ensure(upload.deployment.number===28
      && upload.deployment.env.PUBLIC_CATALOG_COORDINATOR.namespace_id===compatibleCatalogNamespace,'catalog_preview_compatible_resource_changed');
    const afterMeta=await read(previewPath); const after=await read(previewPath+'/deployments/latest');
    checkPreview(afterMeta,after,config,true);
    if(compatible) ensure(after.number===28
      && after.env.PUBLIC_CATALOG_COORDINATOR.namespace_id===compatibleCatalogNamespace,'catalog_preview_compatible_resource_changed');
    ensure(after.id===upload.deployment.id && after.id!==before.id,'catalog_preview_readback_mismatch');
    ensure(isDeepStrictEqual(await controls(),controlBefore),'catalog_preview_control_changed');
    if(compatible) await checkCompatibleResources(read,transport);
    return {status:0,report:{ok:true,prepared:true,previewId,deploymentId:after.id,deploymentNumber:after.number,previousDeploymentId:before.id,
      ...(compatible?{compatiblePublished:true}:{}),
      catalogNamespaceId:after.env.PUBLIC_CATALOG_COORDINATOR.namespace_id,realtimeNamespaceId:realtimeId,
      reader:false,writer:false,controlDeploymentsUnchanged:true,cpuLimitMs:1000,cpuLimitVerified:true,cpuWorkloadVerified:false,activationReady:false}};
  } catch(error) { return failed(attempted?'catalog_preview_deployment_uncertain':error?.safeCode??'catalog_preview_preflight_failed'); }
  finally { credential=undefined; }
}

// Separately approved one-shot credential renewal. PATCH clones the explicitly
// latest deployment AFTER checking the pinned baseline; no bundle upload, flags,
// routes or base-config edit. Provider has no documented atomic compare-and-swap.
// Caller retains its generated bearer in memory for the smoke; never return it.
export async function rotateTenantPreviewBearer(bearer,ports={}) {
  if(typeof bearer!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(bearer))return failed('catalog_preview_rotation_input_invalid');
  const execute=ports.execute??spawnSync,transport=ports.fetch??fetch;let credential,attempted=false,httpStatus,providerCodes;
  try{
    const inspected=await runCatalogInertPreview(['inspect'],{...ports,execute(exe,args,options){
      ensure(args[1]==='auth','catalog_preview_rotation_command_invalid');
      const result=execute(exe,args,options);
      if(result.status===0)credential=JSON.parse(result.stdout).token;
      return result;
    }});
    ensure(inspected.status===0&&credential,'catalog_preview_rotation_preflight_failed');
    const read=async path=>{
      const response=await transport(base+path,{method:'GET',headers:{Authorization:`Bearer ${credential}`},redirect:'error',signal:AbortSignal.timeout(15000)});
      ensure(response.ok,'catalog_preview_rotation_read_failed');const text=await response.text();ensure(text.length<=262144,'catalog_preview_rotation_read_failed');
      const json=JSON.parse(text);ensure(json.success===true&&json.result,'catalog_preview_rotation_read_failed');return json.result;
    };
    const config=JSON.parse(readFileSync(resolve(root,configuration),'utf8'));
    const before=await read(previewPath+'/deployments/latest');checkPreview(await read(previewPath),before,config,true);
    ensure(before.id==='0adb3258-57f0-4ef6-a155-1259780d17b4'&&before.number===29
      &&before.env.PUBLIC_CATALOG_COORDINATOR.namespace_id===compatibleCatalogNamespace,'catalog_preview_rotation_baseline_changed');
    await checkCompatibleResources(read,transport);
    const controls=async()=>Promise.all(controlPaths.map(async path=>{const v=await read(path);ensure(Array.isArray(v.deployments)&&v.deployments.length>0,'catalog_preview_control_invalid');return v.deployments.map(d=>({id:d.id,versions:d.versions}));}));
    const controlBefore=await controls();
    // Startup is a new measured sample, not configuration. A per-deployment URL
    // necessarily incorporates the new ID; validate its exact new shape below.
    const stable=value=>Object.fromEntries(['limits','compatibility_date','compatibility_flags','main_module','usage_model','migration_tag','env'].map(key=>[key,value[key]]));
    const expectedUrls=value=>[`https://${value.id.slice(0,8)}-vapt-api-parallel.autoistloko.workers.dev`];
    ensure(isDeepStrictEqual(before.urls,expectedUrls(before))&&Number.isFinite(before.startup_time_ms)&&before.startup_time_ms>=0,'catalog_preview_rotation_metadata_invalid');
    const stableBefore=structuredClone(stable(before));
    const immediatelyBefore=await read(previewPath+'/deployments/latest');
    ensure(immediatelyBefore.id===before.id&&immediatelyBefore.number===29&&isDeepStrictEqual(stable(immediatelyBefore),stableBefore)
      &&isDeepStrictEqual(immediatelyBefore.urls,before.urls),'catalog_preview_rotation_baseline_changed');
    attempted=true;
    const response=await transport(base+previewPath+'/deployments/latest',{method:'PATCH',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/merge-patch+json'},
      body:JSON.stringify({env:{PARALLEL_PREVIEW_TOKEN:{type:'secret_text',text:bearer}},annotations:{'workers/message':'Approved tenant preview smoke bearer renewal'}}),redirect:'error',signal:AbortSignal.timeout(30000)});
    const text=await response.text();ensure(text.length<=262144,'catalog_preview_rotation_uncertain');
    if(!response.ok){httpStatus=response.status;try{const errors=JSON.parse(text).errors;providerCodes=Array.isArray(errors)?errors.slice(0,5).map(v=>v?.code).filter(Number.isSafeInteger):[];}catch{providerCodes=[];}}
    ensure(response.ok,'catalog_preview_rotation_uncertain');
    const body=JSON.parse(text);ensure(body.success===true&&body.result,'catalog_preview_rotation_uncertain');const uploaded=body.result;
    const after=await read(previewPath+'/deployments/latest');checkPreview(await read(previewPath),after,config,true);
    ensure(after.number===30&&after.id===uploaded.id&&after.id!==before.id&&isDeepStrictEqual(stable(after),stableBefore)
      &&isDeepStrictEqual(after.urls,expectedUrls(after))&&Number.isFinite(after.startup_time_ms)&&after.startup_time_ms>=0,'catalog_preview_rotation_uncertain');
    ensure(isDeepStrictEqual(await controls(),controlBefore),'catalog_preview_control_changed');await checkCompatibleResources(read,transport);
    return{status:0,report:{ok:true,bearerRenewed:true,deploymentId:after.id,deploymentNumber:30,previousDeploymentId:before.id,
      reader:false,writer:false,cpuLimitMs:1000,controlDeploymentsUnchanged:true,activationReady:false}};
  }catch(error){const result=failed(attempted?'catalog_preview_rotation_uncertain':error?.safeCode??'catalog_preview_rotation_preflight_failed');if(httpStatus!==undefined)Object.assign(result.report,{httpStatus,providerCodes});return result;}
  finally{credential=undefined;bearer=undefined;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await runCatalogInertPreview(process.argv.slice(2));console.log(JSON.stringify(result.report));process.exitCode=result.status;
}
