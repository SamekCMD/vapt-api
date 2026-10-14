import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRealtimeProductionConfig } from './verify-realtime-production-config.mjs';

const realtime = () => JSON.parse(readFileSync(new URL('../wrangler.worker-production-realtime.jsonc', import.meta.url), 'utf8'));
const policy = () => ({ enabled: true, head_sampling_rate: 0.01, redact_query_string: true,
  logs: { enabled: true, invocation_logs: false, persist: true, destinations: [] },
  traces: { enabled: false, persist: false, destinations: [] }, issues: { enabled: false } });
const observed = () => ({ ...realtime(), observability: policy() });
async function checker() {
  const module = await import('./verify-observability-production-config.mjs').catch(() => ({}));
  assert.equal(typeof module.checkObservabilityProductionConfig, 'function', 'explicit safe logging gate not implemented');
  return module.checkObservabilityProductionConfig;
}

test('logging gate accepts only explicit 1% collection while ordinary realtime deployment refuses it', async () => {
  const check = await checker();
  const input = observed(), before = structuredClone(input);
  assert.equal(check(input).ok, true);
  assert.deepEqual(input, before);
  assert.equal(checkRealtimeProductionConfig(input).ok, false);
  assert.equal(check(realtime()).ok, false);
});

test('logging gate rejects automatic URLs, traces, raw-query retention, extra destinations and unbounded sampling', async () => {
  const check = await checker();
  for (const change of [
    c => { c.observability.head_sampling_rate = 1; },
    c => { delete c.observability.head_sampling_rate; },
    c => { c.observability.head_sampling_rate = '0.01'; },
    c => { c.observability.enabled = false; },
    c => { c.observability.redact_query_string = false; },
    c => { delete c.observability.redact_query_string; },
    c => { c.observability.logs.invocation_logs = true; },
    c => { delete c.observability.logs.invocation_logs; },
    c => { c.observability.logs.enabled = false; },
    c => { c.observability.logs.persist = false; },
    c => { c.observability.logs.destinations = ['synthetic-external-secret']; },
    c => { c.observability.logs.head_sampling_rate = 1; },
    c => { c.observability.traces.enabled = true; },
    c => { c.observability.traces.persist = true; },
    c => { c.observability.traces.destinations = ['external']; },
    c => { c.observability.issues.enabled = true; },
    c => { c.observability.newDefault = true; },
    c => { c.observability = null; },
  ]) {
    const input = observed(); change(input); const before = structuredClone(input);
    const result = check(input);
    assert.equal(result.ok, false);
    assert.deepEqual(input, before);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-external-secret/);
  }
});

test('logging gate retains production auth, CPU, rate, resource and ingress isolation', async () => {
  const check = await checker();
  for (const change of [
    c => { c.limits.cpu_ms = 30000; }, c => { c.vars.REALTIME_ENABLED = 'false'; },
    c => { c.vars.STRIPE_ENVIRONMENT = 'live'; }, c => { c.vars.CORS_ORIGINS = '*'; },
    c => { c.account_id = 'preview'; }, c => { c.keep_vars = false; },
    c => { c.workers_dev = true; }, c => { c.preview_urls = true; },
    c => { c.routes[0].pattern = '*.vapt.app.br'; },
    c => { c.hyperdrive[0].id = 'preview'; }, c => { c.r2_buckets[0].bucket_name = 'vapt-assets-preview'; },
    c => { c.ratelimits[0].simple.limit = 100000; },
    c => { c.durable_objects.bindings[0].script_name = 'vapt-api-parallel'; },
    c => { c.vars.RESEND_API_KEY = 'synthetic-private'; },
  ]) {
    const input = observed(); change(input);
    const result = check(input);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  }
});

test('committed logging config changes only the approved policy, never ordinary deployment defaults', async () => {
  const check = await checker();
  const input = JSON.parse(readFileSync(new URL('../wrangler.worker-production-observability.jsonc', import.meta.url), 'utf8'));
  assert.equal(check(input).ok, true);
  assert.deepEqual(input, observed());
  assert.equal(checkRealtimeProductionConfig(realtime()).ok, true);
});

test('logging CLI validates the exact file and rejects malformed arguments without echoing secrets', async () => {
  await checker();
  const script = fileURLToPath(new URL('./verify-observability-production-config.mjs', import.meta.url));
  const valid = spawnSync(process.execPath, [script, fileURLToPath(new URL('../wrangler.worker-production-observability.jsonc', import.meta.url))], { encoding: 'utf8' });
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /"ok":true/);
  for (const args of [[], ['synthetic-private'], ['synthetic-private', 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /"ok":false/);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private/);
  }
});
