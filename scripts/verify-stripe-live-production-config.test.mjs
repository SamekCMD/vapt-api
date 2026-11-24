import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {checkStripeLiveProductionConfig} from './verify-stripe-live-production-config.mjs';
const load=()=>JSON.parse(readFileSync(new URL('../wrangler.worker-stripe-live-production.jsonc',import.meta.url),'utf8'));
test('current production profile uses Live prices and keeps catalog and realtime enabled',()=>{
 const config=load();assert.equal(config.vars.STRIPE_ENVIRONMENT,'live');
 for(const name of ['REALTIME_ENABLED','PUBLIC_CATALOG_READER_ENABLED','PUBLIC_CATALOG_WRITER_ENABLED'])assert.equal(config.vars[name],'true');
 assert.equal(config.vars.STRIPE_PRICE_STARTER,'price_1Uf88EH4hY0s7wXrnPGXecAB');
 assert.equal(config.vars.STRIPE_PRICE_PRO,'price_1Uf88DH4hY0s7wXrkun2uQvf');
 assert.equal(config.vars.STRIPE_PRICE_BUSINESS,'price_1Uf88DH4hY0s7wXrY2m0aa7U');
 assert.equal(config.vars.STRIPE_PORTAL_CONFIGURATION_ID,'bpc_1Uf8AEH4hY0s7wXrsYf89Gma');
 assert.deepEqual(checkStripeLiveProductionConfig(config),{ok:true,deployed:false,livePaymentVerified:false});
});
for(const [name,poison]of Object.entries({
 testMode:c=>{c.vars.STRIPE_ENVIRONMENT='test'},oldPrice:c=>{c.vars.STRIPE_PRICE_PRO='price_1UKLz7QYNWCekS7FA9lBwZEd'},
 readerOff:c=>{c.vars.PUBLIC_CATALOG_READER_ENABLED='false'},writerOff:c=>{c.vars.PUBLIC_CATALOG_WRITER_ENABLED='false'},
 previewDatabase:c=>{c.hyperdrive[0].id='0c05fec2924b4f3b9225f3d689ba7ea9'},previewBucket:c=>{c.r2_buckets[1].bucket_name='vapt-catalog-preview'},
 cpu:c=>{c.limits.cpu_ms=30000},publicAlternative:c=>{c.workers_dev=true},secret:c=>{c.vars.STRIPE_SECRET_KEY='rk_live_synthetic_marker'},
 rateLimit:c=>{c.ratelimits[0].simple.limit=9999},
}))test('reject '+name+' drift without disclosing config values',()=>{const c=load();poison(c);const r=checkStripeLiveProductionConfig(c);assert.equal(r.ok,false);assert.doesNotMatch(JSON.stringify(r),/synthetic_marker|price_1UKLz|0c05fec/);});
