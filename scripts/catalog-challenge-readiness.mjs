// Isolated human callback diagnostic. No R2/Neon/auth client, credentials, or persisted token.
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createProductionCatalogChallengeReadiness} from './production-tenant-challenge.mjs';

export async function runCatalogChallengeReadiness({signal,onEvent=()=>{}}={}){
  const deadline=AbortSignal.timeout(5*60*1000);
  const active=signal?AbortSignal.any([signal,deadline]):deadline;
  const result={ok:false,callbackReceived:false,serverVerified:false,loginRequests:0,credentialsCreated:0};
  let bridge,stage='preflight',token;
  async function bounded(promise){
    let abort;
    const interrupted=new Promise((_,reject)=>{abort=()=>reject(Error('Readiness stopped'));if(active.aborted)abort();else active.addEventListener('abort',abort,{once:true});});
    try{return await Promise.race([promise,interrupted]);}finally{active.removeEventListener('abort',abort);}
  }
  try{
    active.throwIfAborted();bridge=await createProductionCatalogChallengeReadiness();
    stage='waiting_start';await bounded(Promise.resolve(onEvent({stage,url:bridge.url})));
    await bounded(bridge.waitForStart());
    stage='waiting_challenge';
    const pending=bridge.captcha({index:0,role:'owner',signal:active});pending.catch(()=>{});
    await bounded(Promise.resolve(onEvent({stage})));
    token=await bounded(pending);active.throwIfAborted();
    result.callbackReceived=true;token=undefined;
    bridge.complete({ok:true,cleaned:true});stage='callback_received';
    await bounded(Promise.resolve(onEvent({stage})));result.ok=true;
  }catch{result.failedStage=stage;}
  finally{
    token=undefined;
    try{await bridge?.close();}catch{result.ok=false;result.failedStage='close';}
  }
  return result;
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  if(process.argv.length!==3||process.argv[2]!=='run'){
    process.stderr.write('Usage: node scripts/catalog-challenge-readiness.mjs run\n');process.exitCode=1;
  }else{
    const abort=new AbortController(),stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{
      const result=await runCatalogChallengeReadiness({signal:abort.signal,onEvent:async event=>{
        process.stdout.write(JSON.stringify(event)+'\n');
        if(event.stage==='callback_received')await delay(3000,undefined,{signal:abort.signal});
      }});
      process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=1;
    }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  }
}
