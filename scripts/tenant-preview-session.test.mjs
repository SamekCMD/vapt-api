import test from 'node:test';
import assert from 'node:assert/strict';
const credentials={accessJwt:'synthetic-access-token-long',bearer:'synthetic-bearer-value-at-least-32-characters'};
async function setup(accessRemaining=3600000){
  const {createTenantPreviewSession}=await import('./tenant-preview-session.mjs');
  let time=1000,timer,delay,rotations=0;
  const session=createTenantPreviewSession({...credentials,expiresAt:time+accessRemaining,now:()=>time,
    schedule:(fn,ms)=>{timer=fn;delay=ms;return 1;},cancel:()=>{}});
  return{session,delay,expire(){time+=delay;timer();},rotation:async({bearer,signal})=>{
    assert.equal(bearer,credentials.bearer);assert.equal(signal.aborted,false);rotations++;return{status:0};},rotations:()=>rotations};
}
test('one renewal, failed cleaned attempt waits for explicit resume with identical RAM credentials',async()=>{
  const s=await setup();await s.session.rotate(s.rotation);let attempts=0;
  const run=async input=>{attempts++;assert.equal(input.bearer,credentials.bearer);assert.equal(input.accessJwt,credentials.accessJwt);return{ok:false,cleaned:true};};
  await s.session.attempt(run);assert.equal(s.session.state(),'paused');assert.equal(attempts,1);
  await assert.rejects(s.session.attempt(run));await assert.rejects(s.session.rotate(s.rotation));
  await s.session.attempt(run,{resume:true});assert.equal(attempts,2);assert.equal(s.rotations(),1);
  const report=await s.session.attempt(async()=>({ok:true,cleaned:true}),{resume:true});
  assert.equal(report.ok,true);assert.equal(s.session.state(),'closed');assert.equal(s.session.retainsCredentials(),false);
});
for(const result of [{ok:false,cleaned:false},{ok:false,cleaned:true,failureCode:'seed_uncertain'}]){
  test('unconfirmed cleanup or uncertain seed permanently blocks resume',async()=>{
    const s=await setup();await s.session.rotate(s.rotation);await s.session.attempt(async()=>result);
    assert.equal(s.session.state(),'closed');assert.equal(s.session.retainsCredentials(),false);
    await assert.rejects(s.session.attempt(async()=>assert.fail(),{resume:true}));
  });
}
test('deadline is at most30 minutes or Access expiry, clears credentials and aborts active work',async()=>{
  for(const remaining of [3600000,90000]){
    const s=await setup(remaining);assert.equal(s.delay,Math.min(1800000,remaining));await s.session.rotate(s.rotation);
    let borrowed;
    const pending=s.session.attempt(async input=>{borrowed=input;return new Promise(resolve=>input.signal.addEventListener('abort',()=>resolve({ok:false,cleaned:true}),{once:true}));});
    s.expire();await pending;assert.equal(s.session.retainsCredentials(),false);assert.equal(s.session.state(),'closed');
    assert.equal(borrowed.bearer,undefined);assert.equal(borrowed.accessJwt,undefined);
    await assert.rejects(s.session.attempt(async()=>assert.fail(),{resume:true}));
  }
});
test('exceptions and uncertain renewal close without retry or exposing exception text',async()=>{
  const s=await setup();await assert.rejects(s.session.rotate(async()=>{throw Error('synthetic-secret');}),error=>!error.message.includes('synthetic-secret'));
  assert.equal(s.session.state(),'closed');assert.equal(s.session.retainsCredentials(),false);
  const t=await setup();await t.session.rotate(t.rotation);
  await assert.rejects(t.session.attempt(async()=>{throw Error('synthetic-secret');}),error=>!error.message.includes('synthetic-secret'));
  assert.equal(t.session.state(),'closed');assert.equal(t.session.retainsCredentials(),false);
});
