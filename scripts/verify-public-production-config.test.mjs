import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProductionPreparationConfig } from './verify-production-preparation-config.mjs';

const privateConfig = () => JSON.parse(readFileSync(new URL('../wrangler.worker-production.jsonc', import.meta.url), 'utf8'));
const valid = () => ({ ...privateConfig(), account_id: '3ce69408aa5112617a282957aba71932', keep_vars: true,
  routes: [{ pattern: 'api.vapt.app.br', custom_domain: true }] });
async function checker() {
  const feature = await import('./verify-public-production-config.mjs').catch(() => null);
  assert.equal(typeof feature?.checkPublicProductionConfig, 'function', 'public production guard not implemented');
  return feature.checkPublicProductionConfig;
}
test('accepts only already-authorized API custom domain without weakening private resource checks', async () => {
  assert.deepEqual((await checker())(valid()), { ok: true, failures: [] });
  assert.deepEqual(checkProductionPreparationConfig(privateConfig()), { ok: true, failures: [] });
  assert.equal(checkProductionPreparationConfig(valid()).ok, false);
});
test('rejects absent, broad, preview or extra ingress and wrong account or variable retention', async () => {
  const check = await checker();
  for (const mutate of [
    c => { c.routes = []; }, c => { delete c.routes; },
    c => { c.routes[0].pattern = 'vapt.app.br'; }, c => { c.routes[0].pattern = '*.vapt.app.br/*'; },
    c => { c.routes[0].custom_domain = false; }, c => { c.routes[0].zone_name = 'other.example'; },
    c => { c.routes.push({ pattern: 'extra.vapt.app.br', custom_domain: true }); },
    c => { c.account_id = 'another-account'; }, c => { delete c.account_id; },
    c => { c.keep_vars = false; }, c => { delete c.keep_vars; },
    c => { c.workers_dev = true; }, c => { c.preview_urls = true; },
  ]) { const config = valid(); mutate(config); assert.equal(check(config).ok, false); }
});
test('public gate retains CPU, auth, test providers, resource isolation and safe error output', async () => {
  const check = await checker();
  for (const mutate of [
    c => { c.limits.cpu_ms = 30000; }, c => { c.vars.REALTIME_ENABLED = 'true'; },
    c => { c.vars.STRIPE_ENVIRONMENT = 'live'; }, c => { c.vars.CORS_ORIGINS = '*'; },
    c => { c.hyperdrive[0].id = '0c05fec2924b4f3b9225f3d689ba7ea9'; },
    c => { c.r2_buckets[0].bucket_name = 'vapt-assets-preview'; },
    c => { c.vars.RESEND_API_KEY = 'synthetic-secret'; },
    c => { c.triggers = { crons: ['* * * * *'] }; },
    c => { c.ratelimits[0].simple.limit = 200; },
    c => { c.migrations.push({ tag: 'delete', deleted_classes: ['RestaurantRealtime'] }); },
  ]) { const config = valid(); mutate(config); const result = check(config);
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/); }
  assert.equal(check(null).ok, false);
});
test('committed public config passes while original private config remains separate', async () => {
  const check = await checker();
  assert.deepEqual(check(JSON.parse(readFileSync(new URL('../wrangler.worker-production-public.jsonc', import.meta.url), 'utf8'))), { ok: true, failures: [] });
  assert.equal(check(privateConfig()).ok, false);
});
test('public CLI fails closed without leaking supplied unsafe path', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-public-production-config.mjs', import.meta.url)), 'synthetic-secret'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"ok":false/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
});
