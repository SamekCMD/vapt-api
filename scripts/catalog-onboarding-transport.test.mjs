import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionCatalogOnboardingFixtureDriver} from './catalog-onboarding-fixtures.mjs';
import {runProductionCatalogOnboardingGate} from './catalog-onboarding-gate.mjs';
const tag='catalog-writer-44444444-4444-4444-8444-444444444444';
const manifest={tag,user:{id:'11111111-1111-4111-8111-111111111111',name:tag,email:tag+'-0@example.invalid'},accountId:'77777777-7777-4777-8777-777777777777',operationIds:{draft:'55555555-5555-4555-8555-555555555555',finalize:'66666666-6666-4666-8666-666666666666'}};
const ownerUrl='postgresql://neondb_owner:synthetic-only@ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full';

// External SQL transport only is controlled: dropping it settles its in-flight
// read. The actual driver must destroy/release before returning, not abandon it.
for(const boundary of ['BEGIN','insert','COMMIT','ROLLBACK','cleanup'])test('stalled '+boundary+' destroys the connection and reaches independent gate revocation',async t=>{
  const events=[],queries=[];let enter,rejectRead,deadline,settled=false,broken=false,firstInsert=true;
  const entered=new Promise(ok=>enter=ok),nativeTimeout=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
    if(ms===15000){deadline=callback;return nativeTimeout(callback,60000,...args);}return nativeTimeout(callback,ms,...args);
  });
  const sql=async text=>{
    queries.push(text);
    if(text.includes('current_database()'))return{rows:[{database:'vapt',role:'neondb_owner'}]};
    if(text===boundary||boundary==='insert'&&text.startsWith('insert')||boundary==='cleanup'&&text.startsWith('select id from better_auth.')){
      enter();return new Promise((ok,fail)=>{rejectRead=error=>{settled=true;fail(error);};});
    }
    if(boundary==='ROLLBACK'&&text.startsWith('insert')&&firstInsert){firstInsert=false;throw Object.assign(Error('synthetic constraint'),{code:'23505'});}
    if(text.startsWith('select (('))return{rows:[{n:0}]};
    return{rows:[],rowCount:1};
  };
  const raw={query:sql,connect:async()=>({query:sql,release(reason){events.push(reason?'destroy':'release');if(reason){broken=true;rejectRead?.(Error('private socket closed'));}}}),end:async()=>events.push('end')};
  const driver=await createProductionCatalogOnboardingFixtureDriver({ownerUrl,manifest,createPool:()=>raw,hash:async()=> 'synthetic-hash'});
  const running=runProductionCatalogOnboardingGate({baseUrl:'https://api.vapt.app.br',driver,preflight:async()=>{},record:async name=>{events.push(name);if(boundary==='cleanup'&&name==='seed_confirmed')throw Error('synthetic disk failure');},
    captcha:async()=> 'synthetic-private-challenge-value',fetcher:async()=>{assert.fail('login must not follow uncertain seed');},
    storage:{ready:async()=>({bucket:'vapt-catalog-production',expiresAt:Date.now()+1800000}),forPublication:async()=>({}),close:async()=>events.push('storage_close'),
      revoke:async()=>{assert.equal(broken,true);assert.equal(settled,true);events.push('revoke');return{revoked:true,attempted:true,status:403};}}});
  let watchdog;
  try{
    await entered;assert.equal(typeof deadline,'function','driver must install a client read deadline');deadline();
    const result=await Promise.race([running,new Promise(ok=>watchdog=nativeTimeout(()=>ok(null),1000))]);
    assert(result,'transport deadline must release the gate');assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(result.credentialRevoked,true);
    assert(events.indexOf('destroy')<events.indexOf('revoke'));assert.equal(events.filter(v=>v==='destroy').length,1);assert.equal(events.filter(v=>v==='revoke').length,1);
    if(boundary!=='ROLLBACK')assert(!queries.includes('ROLLBACK'),'do not send rollback on the dead connection');
    assert.doesNotMatch(JSON.stringify(result),/private socket|synthetic-hash|synthetic-only/);await assert.rejects(driver.seed());
  }finally{clearTimeout(watchdog);rejectRead?.(Error('test transport closed'));await running;}
});
