// Fixed operator lifecycle, no CLI/default fetch/credential discovery. The outer
// one-shot controller owns intent journals, current preflights and key issuance.
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {runProductionCatalogOnboardingProbe} from './catalog-onboarding-probe.mjs';
const ensure=value=>{if(!value)throw Error('Onboarding gate stopped');};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export async function runProductionCatalogOnboardingGate(options={}){
  const report={ok:false,seeded:false,cleaned:false,sessionRevoked:false,credentialRevoked:false,uncertain:false,authRequests:0,stage:'input'};
  const deadline=AbortSignal.timeout(1200000),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
  let owned=false,cookie,credential,challenge,phase='input',seedAttempted=false,loginAttempted=false,probeAttempted=false,logoutAttempted=false,retirementAttempted=false,cleanupAttempted=false;
  const mark=value=>{phase=value;options.onProgress?.(value);};
  async function wait(work,active=signal){
    active.throwIfAborted();return new Promise((resolve,reject)=>{
      const abort=()=>{active.removeEventListener('abort',abort);reject(Error('Onboarding wait stopped'));};active.addEventListener('abort',abort,{once:true});if(active.aborted)return abort();
      Promise.resolve().then(()=>{active.throwIfAborted();return work(active);}).then(value=>{active.removeEventListener('abort',abort);resolve(value);},error=>{active.removeEventListener('abort',abort);reject(error);});
    });
  }
  async function record(event,value,cleanup=false){if(!cleanup)signal.throwIfAborted();await options.record(event,value);if(!cleanup)signal.throwIfAborted();}
  function forget(){if(credential)try{credential.password='';}catch{}credential=undefined;challenge=undefined;}
  async function auth(path,{method='GET',body,captcha,expected=200,cleanup=false}={}){
    ensure(['/api/auth/sign-in/email','/api/auth/sign-out','/auth/me'].includes(path)&&report.authRequests<6);
    const active=cleanup?AbortSignal.timeout(30000):signal;
    await wait(bound=>(options.pace??(({signal})=>delay(3300,undefined,{signal})))({signal:bound}),active);
    const bound=AbortSignal.any([active,AbortSignal.timeout(15000)]);report.authRequests++;
    const headers={Origin:'https://vapt.app.br',...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...(captcha?{'X-Captcha-Response':captcha}:{})};
    let response;
    try{response=await wait(async current=>{const value=await options.fetcher(options.baseUrl+path,{method,redirect:'error',credentials:'omit',signal:current,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(current.aborted){void value.body?.cancel().catch(()=>{});current.throwIfAborted();}return value;},bound);}finally{delete headers['X-Captcha-Response'];}
    if(path==='/api/auth/sign-in/email'&&response.status===200){const values=response.headers.getSetCookie().map(value=>value.split(';')[0]).filter(value=>/^__Secure-better-auth\.session_token=[A-Za-z0-9%._~+-]{20,8192}$/.test(value));ensure(values.length===1);cookie=values[0];}
    const reader=response.body?.getReader(),chunks=[];let size=0;ensure(reader);
    try{for(;;){const part=await wait(()=>reader.read(),bound);if(part.done)break;size+=part.value.length;ensure(size<=65536);chunks.push(part.value);}}
    catch{void reader.cancel().catch(()=>{});throw Error('Onboarding auth body stopped');}
    ensure(response.status===expected);const text=Buffer.concat(chunks).toString('utf8');return{status:response.status,value:text?JSON.parse(text):null};
  }
  async function logout(){
    ensure(cookie&&!logoutAttempted);logoutAttempted=true;mark('logout');let journalFailed=false;
    try{await record('logout_attempt',undefined,true);}catch{journalFailed=true;}
    await auth('/api/auth/sign-out',{method:'POST',body:{},cleanup:true});await auth('/auth/me',{expected:401,cleanup:true});report.sessionRevoked=true;
    try{await record('logout_confirmed',undefined,true);}catch{journalFailed=true;}ensure(!journalFailed);
  }
  try{
    ensure(options.baseUrl==='https://api.vapt.app.br'&&['preflight','record','captcha','fetcher'].every(name=>typeof options[name]==='function')
      &&['identifiers','seed','inspectOnboarding','retireOnboarding','cleanupIdentity','close'].every(name=>typeof options.driver?.[name]==='function')
      &&['ready','forPublication','revoke','close'].every(name=>typeof options.storage?.[name]==='function'));
    const manifest=structuredClone(options.driver.identifiers()),u=manifest?.user,ids=manifest?.operationIds;
    ensure(manifest&&typeof manifest.tag==='string'&&manifest.tag.startsWith('catalog-writer-')&&uuid(manifest.tag.slice(15))&&u?.name===manifest.tag&&u.email===manifest.tag+'-0@example.invalid'
      &&Object.keys(manifest).sort().join(',')==='accountId,operationIds,tag,user'&&Object.keys(u).sort().join(',')==='email,id,name'&&Object.keys(ids??{}).sort().join(',')==='draft,finalize'
      &&[u.id,manifest.accountId,ids?.draft,ids?.finalize].every(uuid)&&new Set([u.id,manifest.accountId,ids.draft,ids.finalize]).size===4);
    owned=true;mark('preflight');await wait(active=>options.preflight('before_seed',{manifest,signal:active}));
    mark('storage_ready');const storage=await wait(active=>options.storage.ready({manifest,signal:active}));
    ensure(storage?.bucket==='vapt-catalog-production'&&Number.isSafeInteger(storage.expiresAt)&&storage.expiresAt-Date.now()>=600000&&storage.expiresAt-Date.now()<=1800000);
    mark('human_challenge');challenge=await wait(active=>options.captcha({index:0,role:'owner',signal:active}));
    ensure(typeof challenge==='string'&&challenge.length>=20&&challenge.length<=2048&&!/[\r\n]/.test(challenge)&&!challenge.startsWith('XXXX.DUMMY.'));
    mark('seed');await record('seed_attempt',{manifest});seedAttempted=true;
    // SQL mutation must drain even on cancellation; do not close its pool early.
    credential=await options.driver.seed();report.seeded=true;
    ensure(credential?.id===u.id&&credential.email===u.email&&typeof credential.password==='string'&&credential.password.length>=32);signal.throwIfAborted();await record('seed_confirmed');
    mark('login');await record('login_attempt');loginAttempted=true;
    try{const login=await auth('/api/auth/sign-in/email',{method:'POST',body:{email:u.email,password:credential.password},captcha:challenge});ensure(cookie&&login.value?.user?.id===u.id&&login.value.user.email===u.email);}finally{forget();}
    await record('login_confirmed');mark('probe');await record('probe_attempt');probeAttempted=true;
    report.probe=await runProductionCatalogOnboardingProbe({baseUrl:options.baseUrl,actorId:u.id,tag:manifest.tag,operationIds:ids,cookie,fetcher:options.fetcher,pace:options.pace,signal,
      preflight:({signal})=>options.preflight('before_probe',{manifest,signal})});
    report.uncertain=report.probe.uncertain===true;ensure(report.probe.ok===true&&!report.uncertain);await record('probe_confirmed',{probe:report.probe});
    mark('onboarding_readback');await record('readback_attempt');
    const readback=await wait(active=>options.driver.inspectOnboarding({probe:report.probe,signal:active}));
    ensure(isDeepStrictEqual(readback,{verified:true,trialVerified:true,intentRows:2,restaurantId:report.probe.restaurantId,organizationId:report.probe.organizationId,version:report.probe.receipts[0].version}));report.readback=readback;await record('readback_confirmed');
    await logout();mark('retirement');await wait(active=>options.preflight('before_retirement',{manifest,signal:active}));
    const store=await wait(active=>options.storage.forPublication(report.probe,{signal:active}));await record('retirement_attempt');retirementAttempted=true;
    const retired=await options.driver.retireOnboarding({probe:report.probe,store,signal,verifyLoggedOut:async()=>({status:(await auth('/auth/me',{expected:401,cleanup:true})).status})});
    ensure(retired?.readbackConfirmed===true&&retired.restaurantId===report.probe.restaurantId&&retired.organizationId===report.probe.organizationId
      &&retired.journalRows===0&&retired.revisionRows===0&&retired.intentRows===0&&retired.objectWrites===2);
    report.retired={readbackConfirmed:true,restaurantId:retired.restaurantId,organizationId:retired.organizationId,journalRows:0,revisionRows:0,intentRows:0,objectWrites:2};await record('retirement_confirmed');
    mark('fixture_cleanup');await record('fixture_cleanup_attempt');cleanupAttempted=true;ensure((await options.driver.cleanupIdentity({signal}))?.rows===0);report.cleaned=true;await record('fixture_cleanup_confirmed');
  }catch(error){report.failedStep=phase;if(seedAttempted&&!report.seeded||probeAttempted&&!report.cleaned||loginAttempted&&!report.sessionRevoked||retirementAttempted&&!report.retired||cleanupAttempted&&!report.cleaned||error?.safeCode?.endsWith('_uncertain'))report.uncertain=true;}
  finally{
    forget();
    if(owned){
      if(cookie&&!logoutAttempted)try{await logout();}catch{report.failedStep??='logout';report.uncertain=true;}
      // Only an unused, confirmed seed may be removed after an early abort.
      if(report.seeded&&!probeAttempted&&!cleanupAttempted&&(!loginAttempted||report.sessionRevoked)){
        try{await record('fixture_cleanup_attempt',undefined,true);cleanupAttempted=true;ensure((await options.driver.cleanupIdentity({signal:AbortSignal.timeout(90000)}))?.rows===0);report.cleaned=true;await record('fixture_cleanup_confirmed',undefined,true);}catch{report.uncertain=true;}
      }
      cookie=undefined;
      try{await record('credential_revoke_attempt',undefined,true);}catch{report.failedStep??='credential_journal';}
      try{const result=await wait(()=>options.storage.revoke(),AbortSignal.timeout(300000));
        ensure(typeof result?.revoked==='boolean'&&typeof result.attempted==='boolean'&&(result.status===null||Number.isInteger(result.status)&&result.status>=100&&result.status<=599));
        report.revocation={revoked:result.revoked,attempted:result.attempted,status:result.status};report.credentialRevoked=result.revoked;
      }catch{report.credentialRevoked=false;}
      if(report.credentialRevoked)try{await record('credential_revoke_confirmed',undefined,true);}catch{report.failedStep??='credential_journal';}
      for(const [name,close]of [['storage_close',()=>options.storage.close()],['driver_close',()=>options.driver.close()]])try{await close();}catch{report.failedStep??=name;}
    }
  }
  report.ok=report.cleaned&&report.sessionRevoked&&report.credentialRevoked&&report.probe?.ok===true&&report.readback?.verified===true&&report.retired?.readbackConfirmed===true&&!report.uncertain&&!report.failedStep;
  report.stage=report.ok?'verified':report.failedStep??phase;return report;
}
