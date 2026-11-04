import test from 'node:test';
import assert from 'node:assert/strict';
const secret='synthetic-human-response-private-value';
async function feature(){const m=await import('./catalog-pre-issuance-challenge.mjs').catch(()=>({}));assert.equal(typeof m.prepareCatalogChallengeBeforeIssuance,'function','pre-issuance workflow missing');return m.prepareCatalogChallengeBeforeIssuance;}
function fixture(){
  const events=[],abort=new AbortController();let time=1000;
  const collector={async close(){events.push('close_input');}};
  const options={signal:abort.signal,now:()=>time,
    captcha:async({index,role,signal})=>{assert.equal(index,0);assert.equal(role,'owner');assert.ok(signal);events.push('human');return secret;},
    confirmIssuance:async({remainingMs,signal})=>{assert.equal(remainingMs,120000);assert.ok(signal);events.push('issuance_ack');},
    recordChallenge:async()=>{events.push('challenge_journal');},
    openInput:async({signal})=>{assert.ok(signal);events.push('possible_issuance');return collector;},
    receiveCredentials:async({collector:input,signal})=>{assert.equal(input,collector);assert.ok(signal);events.push('credential_delivery');},
    confirmRun:async({signal})=>{assert.ok(signal);events.push('run_ack');},
  };
  return{events,options,abort,advance:ms=>{time+=ms;},setTime:value=>{time=value;}};
}
test('human response and explicit acknowledgement precede possible issuance; token is single-use and never returned in the report',async t=>{
  const run=await feature(),f=fixture(),prepared=await run(f.options);t.after(()=>prepared.close());
  assert.deepEqual(f.events,['human','issuance_ack','challenge_journal','possible_issuance','credential_delivery','close_input','run_ack']);
  assert.doesNotMatch(JSON.stringify(prepared),/synthetic-human-response/);
  assert.equal(await prepared.captcha({index:0,role:'owner',signal:f.abort.signal}),secret);
  await assert.rejects(()=>prepared.captcha({index:0,role:'owner',signal:f.abort.signal}));
});
for(const bad of ['short','XXXX.DUMMY.TOKEN.XXXX','x'.repeat(2049),'x'.repeat(20)+'\r\n'])test('invalid challenge blocks issuance: '+bad.length,async()=>{
  const run=await feature(),f=fixture();f.options.captcha=async()=>bad;
  await assert.rejects(()=>run(f.options),e=>!e.message.includes(bad));assert.deepEqual(f.events,[]);
});
for(const phase of ['confirmIssuance','recordChallenge'])test('expiry during '+phase+' prevents opening credential input',async()=>{
  const run=await feature(),f=fixture();f.options[phase]=async()=>f.advance(120000);
  await assert.rejects(()=>run(f.options));assert.equal(f.events.includes('possible_issuance'),false);
});
test('expiry after input is opened closes it without publishing its URL or waiting for keys',async()=>{
  const run=await feature(),f=fixture(),open=f.options.openInput;
  f.options.openInput=async args=>{const c=await open(args);f.advance(120000);return c;};
  await assert.rejects(()=>run(f.options));assert.deepEqual(f.events.slice(-2),['possible_issuance','close_input']);
  assert.equal(f.events.includes('credential_delivery'),false);
});
test('expiry after delivery closes input, stops the gate and cannot consume the old token',async()=>{
  const run=await feature(),f=fixture();f.options.receiveCredentials=async()=>{f.events.push('credential_delivery');f.advance(120000);};
  await assert.rejects(()=>run(f.options));assert.equal(f.events.filter(e=>e==='close_input').length,1);assert.equal(f.events.includes('run_ack'),false);
});
test('external cancellation while keys are pending settles the wait and closes input once',async()=>{
  const run=await feature(),f=fixture();f.options.receiveCredentials=async()=>{f.abort.abort();return new Promise(()=>{});};
  await assert.rejects(()=>run(f.options));assert.equal(f.events.filter(e=>e==='close_input').length,1);
});
test('expired or reversed monotonic clock blocks token consumption',async t=>{
  const run=await feature();for(const time of [0,121000,NaN]){const f=fixture(),p=await run(f.options);t.after(()=>p.close());f.setTime(time);await assert.rejects(()=>p.captcha({index:0,role:'owner',signal:f.abort.signal}));}
});
test('login authorization is once-only, after consumption, with an independent three-minute limit',async t=>{
  const run=await feature(),f=fixture(),p=await run(f.options);t.after(()=>p.close());
  assert.throws(()=>p.authorizeLogin());await p.captcha({index:0,role:'owner',signal:f.abort.signal});
  f.advance(179999);assert.doesNotThrow(()=>p.authorizeLogin());assert.throws(()=>p.authorizeLogin());
  const g=fixture(),q=await run(g.options);t.after(()=>q.close());await q.captcha({index:0,role:'owner',signal:g.abort.signal});g.advance(180000);assert.throws(()=>q.authorizeLogin());
});
test('wrong identity, cancellation and disposal prevent handing a token to a gate',async()=>{
  const run=await feature();for(const mode of ['identity','cancel','close']){
    const f=fixture(),p=await run(f.options);if(mode==='cancel')f.abort.abort();if(mode==='close')p.close();
    try{await assert.rejects(()=>p.captcha({index:mode==='identity'?1:0,role:'owner',signal:f.abort.signal}));}finally{p.close();}
  }
});
test('cancellation drains in-flight input setup and closes the late collector before returning failure',async()=>{
  const run=await feature(),f=fixture();let release,settled=false;
  f.options.openInput=()=>new Promise(resolve=>{release=()=>resolve({close:async()=>f.events.push('close_late_input')});});
  const pending=run(f.options).finally(()=>{settled=true;});const rejected=assert.rejects(pending);
  await new Promise(resolve=>setImmediate(resolve));f.abort.abort();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);release();await rejected;assert.equal(f.events.at(-1),'close_late_input');
});
