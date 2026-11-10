import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkPublicProductionConfig } from './verify-public-production-config.mjs';

const disabled = () => JSON.parse(readFileSync(new URL('../wrangler.worker-production-public.jsonc', import.meta.url), 'utf8'));
const enabled = () => { const config = disabled(); config.vars.REALTIME_ENABLED = 'true'; return config; };
async function feature() {
  const module = await import('./verify-realtime-production-config.mjs').catch(() => null);
  assert.equal(typeof module?.checkRealtimeProductionConfig, 'function', 'explicit realtime production gate not implemented');
  return module.checkRealtimeProductionConfig;
}

test('separate activation gate accepts realtime only while the existing public gate still rejects it', async () => {
  const check = await feature();
  assert.deepEqual(check(enabled()), { ok: true, failures: [] });
  assert.equal(checkPublicProductionConfig(enabled()).ok, false);
  assert.equal(check(disabled()).ok, false);
});

test('activation retains every original isolation and cost guard without mutating inputs', async () => {
  const check = await feature();
  for (const mutate of [
    c => { c.limits.cpu_ms = 30000; }, c => { c.vars.REALTIME_ENABLED = true; },
    c => { c.vars.STRIPE_ENVIRONMENT = 'live'; }, c => { c.vars.CORS_ORIGINS = '*'; },
    c => { c.account_id = 'other'; }, c => { c.keep_vars = false; },
    c => { c.workers_dev = true; }, c => { c.preview_urls = true; },
    c => { c.routes[0].pattern = '*.vapt.app.br'; }, c => { c.routes = []; },
    c => { c.hyperdrive[0].id = '0c05fec2924b4f3b9225f3d689ba7ea9'; },
    c => { c.r2_buckets[0].bucket_name = 'vapt-assets-preview'; },
    c => { c.durable_objects.bindings[0].script_name = 'vapt-api-parallel'; },
    c => { c.migrations.push({ tag: 'delete', deleted_classes: ['RestaurantRealtime'] }); },
    c => { c.ratelimits[0].simple.limit = 200; }, c => { c.vars.RESEND_API_KEY = 'synthetic-secret'; },
    c => { c.triggers = { crons: ['* * * * *'] }; },
  ]) {
    const config = enabled(); mutate(config); const before = structuredClone(config);
    const result = check(config);
    assert.equal(result.ok, false); assert.deepEqual(config, before);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  }
  const valid = enabled(), before = structuredClone(valid);
  assert.equal(check(valid).ok, true); assert.deepEqual(valid, before);
  for (const value of [null, undefined, [], {}, { vars: null }]) assert.equal(check(value).ok, false);
});

test('committed activation config differs from the rollback config only by realtime flag', async () => {
  const check = await feature();
  const config = JSON.parse(readFileSync(new URL('../wrangler.worker-production-realtime.jsonc', import.meta.url), 'utf8'));
  assert.equal(check(config).ok, true);
  assert.deepEqual(config, enabled());
});

test('activation CLI validates the exact config and refuses unsafe paths with sanitized output', async () => {
  await feature();
  const script = fileURLToPath(new URL('./verify-realtime-production-config.mjs', import.meta.url));
  const valid = spawnSync(process.execPath, [script, fileURLToPath(new URL('../wrangler.worker-production-realtime.jsonc', import.meta.url))], { encoding: 'utf8' });
  assert.equal(valid.status, 0); assert.match(valid.stdout, /"ok":true/);
  for (const args of [['synthetic-secret'], [], ['synthetic-secret', 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stdout, /"ok":false/);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
  }
});
