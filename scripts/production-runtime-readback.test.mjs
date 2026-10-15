import test from 'node:test';
import assert from 'node:assert/strict';
async function checker() {
  const module = await import('./production-runtime-readback.mjs').catch(() => ({}));
  assert.equal(typeof module.checkProductionRuntimeReadback, 'function', 'explicit runtime checker must exist');
  return module.checkProductionRuntimeReadback;
}
const apiVersion = '11111111-1111-4111-8111-111111111111', webVersion = '22222222-2222-4222-8222-222222222222';
const expected = {apiVersion,webVersion,realtime:'disabled'};
function state(enabled=false) {
  const names = ['BETTER_AUTH_SECRET','PUBLIC_ORDER_TOKEN_SECRET','RESEND_API_KEY','TURNSTILE_SECRET_KEY','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'];
  return { ingress:{enabled:false,previews_enabled:false}, settings:{limits:{cpu_ms:1000},bindings:[
    ...names.map(name=>({name,type:'secret_text'})),
    {name:'HYPERDRIVE',type:'hyperdrive',id:'2885c609a66641b3b716190c2d467902'},
    {name:'R2_BUCKET',type:'r2_bucket',bucket_name:'vapt-assets-production'},
    {name:'RESTAURANT_REALTIME',type:'durable_object_namespace',namespace_id:'d3ad7a4008c64124b765f934986956da'},
    {name:'REALTIME_ENABLED',type:'plain_text',text:String(enabled)},
    {name:'STRIPE_ENVIRONMENT',type:'plain_text',text:'test'},
    ...[['AUTH_RATE_LIMIT','13011',20],['BILLING_RATE_LIMIT','13012',60],['ORDERS_RATE_LIMIT','13013',30],['STORAGE_RATE_LIMIT','13014',30],['WEBHOOKS_RATE_LIMIT','13015',300],['PUBLIC_RATE_LIMIT','13016',120]]
      .map(([name,namespace_id,limit])=>({name,type:'ratelimit',namespace_id,simple:{limit,period:60}})),
  ]}, schedules:{schedules:[]}, domains:[
    {service:'vapt-api-production',hostname:'api.vapt.app.br',id:'f7344b662aa02bcfa576e9cb5b0108d6d59b667f'},
    {service:'vapt-web',hostname:'vapt.app.br',id:'42d2afe630dc5122d027cf55cb13607c7e0d6bd3'},
  ], r2:{enabled:false}, apiDeployment:{deployments:[{versions:[{version_id:apiVersion,percentage:100}]}]},
  webDeployment:{deployments:[{versions:[{version_id:webVersion,percentage:100}]}]} };
}
test('readback requires explicit exact version and mode; enabled cannot satisfy disabled', async () => {
  const check = await checker();
  assert.equal(check(state(), expected).verified, true);
  assert.throws(()=>check(state(true),expected)); assert.throws(()=>check(state(),{...expected,realtime:'enabled'}));
  assert.equal(check(state(true),{...expected,realtime:'enabled'}).realtime,true);
  for (const changed of [{realtime:'auto'}, {apiVersion:''}, {webVersion:'latest'}, {bearer:'synthetic-secret'}]) assert.throws(()=>check(state(),{...expected,...changed}));
});
test('readback never accepts relaxed CPU, ingress, secrets, storage or partial deployment', async () => {
  const check = await checker();
  const mutations = [s=>s.settings.limits.cpu_ms=30000,s=>s.ingress.previews_enabled=true,
    s=>s.settings.bindings.push({name:'EXTRA',type:'secret_text'}),s=>s.settings.bindings[0].type='plain_text',
    s=>s.settings.bindings.find(b=>b.name==='HYPERDRIVE').id='preview',s=>s.r2.enabled=true,
    s=>s.apiDeployment.deployments[0].versions[0].percentage=50,s=>s.webDeployment.deployments[0].versions[0].version_id=apiVersion,
    s=>s.domains.push({service:'vapt-api-production',hostname:'extra.example.invalid'}),
    s=>s.schedules.schedules.push({cron:'* * * * *'})];
  for (const mutate of mutations) {const value=state();mutate(value);assert.throws(()=>check(value,expected));}
});
test('readback refuses missing, expanded or cross-environment native limiter', async () => {
  const check = await checker();
  for (const mutation of [s=>s.settings.bindings=s.settings.bindings.filter(b=>b.name!=='AUTH_RATE_LIMIT'),
    s=>s.settings.bindings.find(b=>b.name==='PUBLIC_RATE_LIMIT').simple.limit=100000,
    s=>s.settings.bindings.find(b=>b.name==='ORDERS_RATE_LIMIT').namespace_id='preview']) {
    const value=state();mutation(value);assert.throws(()=>check(value,expected));
  }
});
