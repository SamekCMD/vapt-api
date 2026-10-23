// Operator-only, specifically approved Preview32 -> writer window -> closed.
// No CLI activation entry, generic deployment bypass, fixture or product changes.
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { runCatalogInertPreview } from './catalog-preview-inert.mjs';
import { assertCacheDisabledResource } from './verify-hyperdrive-preview.mjs';
const base='https://api.cloudflare.com/client/v4/accounts/3ce69408aa5112617a282957aba71932';
const path='/workers/workers/vapt-api-parallel/previews/stage11-inert';
const baselineId='35fd7ac3-2601-46bb-adec-39ef46813131';
const controlPaths=['vapt-api-production','vapt-web','vapt-api-parallel'].map(name=>`/workers/scripts/${name}/deployments`);
const ensure=(value,code)=>{if(!value)throw Object.assign(new Error('Catalog canary guard failed'),{safeCode:code});};
const failed=(code,writerMayBeActive=false)=>({status:1,report:{ok:false,code,writerMayBeActive,cpuWorkloadVerified:false,activationReady:false}});
const stable=value=>Object.fromEntries(['limits','compatibility_date','compatibility_flags','main_module','usage_model','migration_tag','env'].map(key=>[key,value[key]]));
const metaStable=value=>Object.fromEntries(['id','name','slug','urls','observability','logpush','tail_consumers'].map(key=>[key,value[key]]));
const urls=value=>[`https://${value.id.slice(0,8)}-vapt-api-parallel.autoistloko.workers.dev`];
export async function openCatalogPreviewCanary(bearer,ports={}) {
  if(typeof bearer!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(bearer))return failed('catalog_canary_input_invalid');
  const execute=ports.execute??spawnSync,transport=ports.fetch??fetch;
  let credential,attempted=false,closeAttempted=false,windowVerified=false,openId,expected,initialMeta,controlsBefore;
  async function read(endpoint) {
    const response=await transport(base+endpoint,{method:'GET',headers:{Authorization:`Bearer ${credential}`},redirect:'error',signal:AbortSignal.timeout(15000)});
    ensure(response.ok,'catalog_canary_read_failed');const text=await response.text();ensure(text.length<=262144,'catalog_canary_read_failed');
    const body=JSON.parse(text);ensure(body.success===true&&body.result,'catalog_canary_read_failed');return body.result;
  }
  async function controls(){return Promise.all(controlPaths.map(async endpoint=>{
    const result=await read(endpoint);ensure(Array.isArray(result.deployments)&&result.deployments.length>0,'catalog_canary_controls_invalid');
    return result.deployments.map(value=>({id:value.id,versions:value.versions}));
  }));}
  async function resources(){
    const blocked=await transport('https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000)});
    const location=new URL(blocked.headers.get('location')??'');await blocked.body?.cancel();
    ensure(blocked.status===302&&location.protocol==='https:'&&location.hostname.endsWith('.cloudflareaccess.com')&&location.pathname.startsWith('/cdn-cgi/access/login/'),'catalog_canary_access_invalid');
    ensure((await read('/r2/buckets/vapt-catalog-preview/domains/managed')).enabled===false,'catalog_canary_bucket_public');
    ensure(isDeepStrictEqual((await read('/r2/buckets/vapt-catalog-preview/domains/custom')).domains,[]),'catalog_canary_bucket_public');
    const database=await read('/hyperdrive/configs/0c05fec2924b4f3b9225f3d689ba7ea9');
    ensure(database.id==='0c05fec2924b4f3b9225f3d689ba7ea9'&&database.origin?.host==='ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech'&&database.origin.scheme==='postgres','catalog_canary_database_invalid');
    assertCacheDisabledResource(database,database.origin.host);
  }
  async function checkCurrent(id,number,shape,checkMeta=true){
    const value=await read(path+'/deployments/latest');
    ensure(value.id===id&&value.number===number&&isDeepStrictEqual(stable(value),shape)&&isDeepStrictEqual(value.urls,urls(value)),'catalog_canary_baseline_changed');
    if(checkMeta)ensure(isDeepStrictEqual(metaStable(await read(path)),initialMeta),'catalog_canary_meta_changed');return value;
  }
  async function patch(env,message){
    const response=await transport(base+path+'/deployments/latest',{method:'PATCH',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/merge-patch+json'},
      body:JSON.stringify({env,annotations:{'workers/message':message}}),redirect:'error',signal:AbortSignal.timeout(30000)});
    ensure(response.ok,'catalog_canary_patch_failed');const text=await response.text();ensure(text.length<=262144,'catalog_canary_patch_failed');
    const body=JSON.parse(text);ensure(body.success===true&&body.result?.id,'catalog_canary_patch_failed');return body.result;
  }
  async function close(){
    if(closeAttempted||!credential)return failed('catalog_canary_close_unavailable',true);
    closeAttempted=true;let closing=false,admissionClosed=false;
    try{
      await checkCurrent(openId,33,expected,false);
      // Closing admission must not depend on metrics/resource availability;
      // the executor and already accepted operations remain deployed unchanged.
      closing=true;const uploaded=await patch({PUBLIC_CATALOG_WRITER_ENABLED:{type:'plain_text',text:'false'}},'Close approved catalog preview writer window');
      const closed=structuredClone(expected);closed.env.PUBLIC_CATALOG_WRITER_ENABLED.text='false';
      ensure(uploaded.id!==openId,'catalog_canary_close_mismatch');
      const after=await checkCurrent(uploaded.id,34,closed,false);
      admissionClosed=true;
      ensure(isDeepStrictEqual(metaStable(await read(path)),initialMeta),'catalog_canary_meta_changed');
      ensure(isDeepStrictEqual(await controls(),controlsBefore),'catalog_canary_control_changed');await resources();
      return {status:0,report:{ok:true,writer:false,reader:false,cpuLimitMs:1000,deploymentId:after.id,deploymentNumber:34,
        admissionClosed:true,acceptedExecutorPreserved:true,cleanupVerified:false,cpuWorkloadVerified:false,activationReady:false}};
    }catch(error){const result=failed(admissionClosed?'catalog_canary_closed_postcheck_failed':closing?'catalog_canary_close_uncertain':error.safeCode??'catalog_canary_close_preflight_failed',!admissionClosed);
      if(admissionClosed)result.report.admissionClosed=true;return result;}
    finally{credential=undefined;}
  }
  try{
    const inspected=await runCatalogInertPreview(['inspect'],{...ports,execute(exe,args,options){
      ensure(args[1]==='auth','catalog_canary_command_invalid');const result=execute(exe,args,options);
      if(result.status===0)credential=JSON.parse(result.stdout).token;return result;
    }});
    ensure(inspected.status===0&&credential,'catalog_canary_preflight_failed');
    ensure(inspected.report.deploymentId===baselineId&&inspected.report.deploymentNumber===32,'catalog_canary_baseline_changed');
    const before=await read(path+'/deployments/latest');
    ensure(before.id===baselineId&&before.number===32&&isDeepStrictEqual(before.urls,urls(before)),'catalog_canary_baseline_changed');
    initialMeta=structuredClone(metaStable(await read(path)));
    const original=structuredClone(stable(before));expected=structuredClone(original);expected.env.PUBLIC_CATALOG_WRITER_ENABLED.text='true';
    controlsBefore=await controls();await resources();
    await checkCurrent(baselineId,32,original);
    attempted=true;
    const uploaded=await patch({PUBLIC_CATALOG_WRITER_ENABLED:{type:'plain_text',text:'true'},PARALLEL_PREVIEW_TOKEN:{type:'secret_text',text:bearer}},'Approved isolated catalog preview writer canary');
    openId=uploaded.id;ensure(openId!==baselineId,'catalog_canary_open_mismatch');
    const after=await checkCurrent(openId,33,expected,false);
    windowVerified=true;
    ensure(isDeepStrictEqual(metaStable(await read(path)),initialMeta),'catalog_canary_meta_changed');
    ensure(isDeepStrictEqual(await controls(),controlsBefore),'catalog_canary_control_changed');await resources();
    return {status:0,report:{ok:true,writer:true,reader:false,cpuLimitMs:1000,deploymentId:after.id,deploymentNumber:33,
      bearerRenewed:true,cleanupVerified:false,cpuWorkloadVerified:false,activationReady:false},close};
  }catch(error){const result=failed(windowVerified?'catalog_canary_open_postcheck_failed':attempted?'catalog_canary_open_uncertain':error.safeCode??'catalog_canary_preflight_failed',attempted);
    if(windowVerified)result.close=close;else credential=undefined;return result;}
  finally{bearer=undefined;}
}
