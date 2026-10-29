// One-owner operator lifecycle, not an application route or CLI. No credential
// discovery, default fetch, provider provisioning, deploy or schema mutation.
// The fixed enclosing controller owns durable exclusive journals, live/SQL
// preflights, short-lived storage access and verified revocation.
import {setTimeout as delay} from 'node:timers/promises';
import {runProductionCatalogWriterProbe} from './catalog-writer-probe.mjs';
import {runProductionCatalogImageBaseline} from './catalog-image-baseline-probe.mjs';
import {runProductionCatalogImageLeaseProbe} from './catalog-image-lease-probe.mjs';
const ensure=v=>{if(!v)throw Error('Catalog writer gate guard failed');};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const names=['create','patch','private','mixed','delete','rebuild'];
function forgetCredentials(value){
  if(Array.isArray(value))for(const entry of value)if(entry&&typeof entry==='object')try{entry.password='';}catch{}
}
export async function runProductionCatalogWriterGate(options={}){
  return runProductionCatalogGate(options,false);
}
// Fixed branding-only profile, not a caller-selected probe or general job.
export async function runProductionCatalogImageGate(options={}){
  return runProductionCatalogGate(options,true);
}
async function runProductionCatalogGate(options,image){
  const report={ok:false,cleaned:false,seeded:false,sessionRevoked:false,credentialRevoked:false,uncertain:false,authRequests:0,stage:'input'};
  let owned=false,cookie,credentials=[],step='input',seedAttempted=false,loginAttempted=false,loginConfirmed=false,logoutAttempted=false,cleanupAttempted=false,retirementAttempted=false;
  const deadline=AbortSignal.timeout(1200000),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
  const mark=value=>{step=value;options.onProgress?.(value);};
  async function wait(work,activeSignal=signal){
    activeSignal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const cancel=()=>{activeSignal.removeEventListener('abort',cancel);reject(Error('Operator wait stopped'));};
      activeSignal.addEventListener('abort',cancel,{once:true});
      if(activeSignal.aborted)return cancel();
      Promise.resolve().then(()=>{activeSignal.throwIfAborted();return work(activeSignal);}).then(value=>{activeSignal.removeEventListener('abort',cancel);resolve(value);},error=>{activeSignal.removeEventListener('abort',cancel);reject(error);});
    });
  }
  async function record(event,value){await wait(()=>options.record(event,value));}
  async function auth(path,{method='GET',body,captcha,expected=200,cleanup=false}={}){
    ensure(['/api/auth/sign-in/email','/api/auth/sign-out','/auth/me'].includes(path)&&report.authRequests<6);
    const active=cleanup?AbortSignal.timeout(30000):signal;
    await wait(()=>options.pace?options.pace():delay(3300,undefined,{signal:active}),active);active.throwIfAborted();report.authRequests++;
    const headers={Origin:'https://vapt.app.br',...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...(captcha?{'X-Captcha-Response':captcha}:{})};
    let response;
    try{response=await wait(()=>options.fetcher(options.baseUrl+path,{method,credentials:'omit',redirect:'error',headers,signal:AbortSignal.any([active,AbortSignal.timeout(15000)]),...(body===undefined?{}:{body:JSON.stringify(body)})}),active);}
    finally{delete headers['X-Captcha-Response'];}
    if(path==='/api/auth/sign-in/email'&&response.status===200){
      const values=response.headers.getSetCookie().map(v=>v.split(';')[0]).filter(v=>/^__Secure-better-auth\.session_token=[A-Za-z0-9%._~+-]{20,8192}$/.test(v));
      ensure(values.length===1&&values[0].length<=8192);cookie=values[0];
    }
    const reader=response.body?.getReader(),parts=[];let size=0;ensure(reader);
    try{for(;;){const part=await wait(()=>reader.read(),active);if(part.done)break;size+=part.value.length;ensure(size<=65536);parts.push(part.value);}}
    catch{await reader.cancel().catch(()=>{});throw Error('Bounded auth response stopped');}
    ensure(response.status===expected);const text=Buffer.concat(parts).toString('utf8');return{status:response.status,value:text?JSON.parse(text):null};
  }
  async function logout(){
    ensure(cookie&&!logoutAttempted);logoutAttempted=true;mark('logout');
    // Cleanup gets a fresh bounded budget even when the user cancels the test.
    const cleanupSignal=AbortSignal.timeout(90000);
    await wait(()=>options.record('logout_attempt'),cleanupSignal);
    await auth('/api/auth/sign-out',{method:'POST',body:{},cleanup:true});await auth('/auth/me',{expected:401,cleanup:true});
    report.sessionRevoked=true;await wait(()=>options.record('logout_confirmed'),cleanupSignal);
  }
  try{
    ensure(options.baseUrl==='https://api.vapt.app.br'&&['preflight','record','captcha','fetcher'].every(n=>typeof options[n]==='function')
      &&['identifiers','seed','cleanup','close'].every(n=>typeof options.driver?.[n]==='function')
      &&['ready','retire','revoke','close'].every(n=>typeof options.storage?.[n]==='function'));
    owned=true;const manifest=structuredClone(options.driver.identifiers()),ids=structuredClone(options.operationIds);
    ensure(typeof manifest?.tag==='string'&&manifest.tag.startsWith('catalog-writer-')&&uuid(manifest.tag.slice(15))
      &&manifest.users?.length===1&&manifest.organizations?.length===1&&manifest.restaurants?.length===1&&manifest.members?.length===1);
    const actor=manifest.users[0],org=manifest.organizations[0],target=manifest.restaurants[0];
    ensure([actor.id,org.id,target.id].every(uuid)&&new Set([actor.id,org.id,target.id]).size===3&&actor.name===manifest.tag
      &&actor.email===manifest.tag+'-0@example.invalid'&&org.name===manifest.tag&&org.created_by===actor.id
      &&target.owner_id===actor.id&&target.organization_id===org.id&&target.name===manifest.tag&&target.slug===manifest.tag);
    const selectedNames=image?['rebuild','oversized','upload']:names;
    ensure(ids&&Object.keys(ids).sort().join(',')===[...selectedNames].sort().join(',')&&selectedNames.every(n=>uuid(ids[n]))&&new Set(Object.values(ids)).size===selectedNames.length);
    mark('preflight');await wait(()=>options.preflight('before_seed',{manifest}));
    mark('storage_ready');const storage=await wait(()=>options.storage.ready({manifest}));
    ensure(storage?.bucket==='vapt-catalog-production'&&Number.isSafeInteger(storage.expiresAt)&&storage.expiresAt-Date.now()<=1800000);
    mark('human_challenge');let challenge=await wait(active=>options.captcha({index:0,role:'owner',signal:active}));
    ensure(typeof challenge==='string'&&challenge.length>=20&&challenge.length<=8192&&!/[\r\n]/.test(challenge)&&!challenge.startsWith('XXXX.DUMMY.')
      &&storage.expiresAt-Date.now()>=600000);signal.throwIfAborted();
    mark('seed');await record('seed_attempt',{manifest,operationIds:ids});seedAttempted=true;
    credentials=await wait(()=>Promise.resolve(options.driver.seed()).then(value=>{
      if(signal.aborted)forgetCredentials(value);return value;
    }));report.seeded=true;
    ensure(credentials?.length===1&&credentials[0].id===actor.id&&credentials[0].email===actor.email&&credentials[0].role==='owner'
      &&credentials[0].organizationId===org.id&&typeof credentials[0].password==='string'&&credentials[0].password.length>=32);
    await record('seed_confirmed');
    mark('login');await record('login_attempt');loginAttempted=true;
    try{
      const login=await auth('/api/auth/sign-in/email',{method:'POST',body:{email:actor.email,password:credentials[0].password},captcha:challenge});
      ensure(cookie&&login.value?.user?.id===actor.id&&login.value.user.email===actor.email);loginConfirmed=true;
    }finally{challenge=undefined;forgetCredentials(credentials);}
    await record('login_confirmed');
    mark('probe');await record('probe_attempt');
    const input={baseUrl:options.baseUrl,restaurantId:target.id,tag:manifest.tag,cookie,fetcher:options.fetcher,pace:options.pace,signal,
      preflight:()=>options.preflight('before_probe',{manifest})};
    report.probe=image?await runProductionCatalogImageBaseline({...input,operationId:ids.rebuild})
      :await runProductionCatalogWriterProbe({...input,operationIds:ids});
    report.uncertain=report.probe.uncertain===true;ensure(report.probe.ok===true&&!report.uncertain);await record('probe_confirmed');
    if(image){
      mark('image_probe');await record('image_probe_attempt');
      report.imageProbe=await runProductionCatalogImageLeaseProbe({...input,itemId:'branding',operationIds:{oversized:ids.oversized,upload:ids.upload},
        preflight:()=>options.preflight('before_image',{manifest,baseline:report.probe})});
      report.uncertain=report.imageProbe.uncertain===true;ensure(report.imageProbe.ok===true&&!report.uncertain);await record('image_probe_confirmed');
    }
    await logout();
    mark('retirement');await wait(()=>options.preflight('before_retirement',{manifest}));await record('retirement_attempt');
    // Mutating transactions must drain/roll back before revocation and pool
    // close. Unlike read-only/human waits, never abandon their promise on abort.
    signal.throwIfAborted();retirementAttempted=true;
    const retired=await options.storage.retire({manifest,operationIds:image?{rebuild:ids.rebuild}:ids,probe:report.probe,...(image?{imageProbe:report.imageProbe}:{}),signal,
      verifyLoggedOut:async()=>({status:(await auth('/auth/me',{expected:401,cleanup:true})).status})});
    ensure(retired?.restaurantId===target.id&&retired.readbackConfirmed===true&&retired.journalRows===0&&retired.revisionRows===0&&(!image||retired.imageAbsentConfirmed===true));
    report.retired={journalRows:0,revisionRows:0,readbackConfirmed:true,...(image?{imageAbsentConfirmed:true}:{})};await record('retirement_confirmed');
    mark('fixture_cleanup');await record('fixture_cleanup_attempt');cleanupAttempted=true;
    signal.throwIfAborted();ensure((await options.driver.cleanup({signal}))?.rows===0);report.cleaned=true;await record('fixture_cleanup_confirmed');
  }catch(error){
    report.failedStep=step;
    if(error?.safeCode==='tenant_seed_uncertain'||error?.safeCode==='catalog_writer_retirement_uncertain'||seedAttempted&&!report.seeded||loginAttempted&&!loginConfirmed||retirementAttempted&&!report.retired||cleanupAttempted&&!report.cleaned)report.uncertain=true;
  }finally{
    if(owned){
      if(cookie&&!logoutAttempted)try{await logout();}catch{report.uncertain=true;report.failedStep??='logout';}
      else if(logoutAttempted&&!report.sessionRevoked)report.uncertain=true;
      cookie=undefined;forgetCredentials(credentials);credentials=[];
      const cleanupSignal=AbortSignal.timeout(90000);
      try{await wait(()=>options.record('credential_revoke_attempt'),cleanupSignal);}catch{report.failedStep??='credential_journal';}
      // A broken disk/journal must stop test mutations, not prevent security
      // cleanup. Revocation still gets exactly one attempt, never a retry.
      try{report.credentialRevoked=(await wait(()=>options.storage.revoke(),cleanupSignal))?.revoked===true;}catch{report.credentialRevoked=false;}
      if(report.credentialRevoked)try{await wait(()=>options.record('credential_revoke_confirmed'),cleanupSignal);}catch{report.failedStep??='credential_journal';}
      try{await wait(()=>options.storage.close(),cleanupSignal);}catch{report.failedStep??='storage_close';}
      try{await wait(()=>options.driver.close(),cleanupSignal);}catch{report.failedStep??='driver_close';}
    }
  }
  report.ok=report.cleaned&&report.sessionRevoked&&report.credentialRevoked&&report.probe?.ok===true&&(!image||report.imageProbe?.ok===true)&&!report.uncertain&&!report.failedStep;
  report.stage=report.ok?'verified':report.failedStep??step;return report;
}
