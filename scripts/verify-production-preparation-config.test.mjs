import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const valid = () => ({
  name: 'vapt-api-production', main: 'src/worker/realtime-entry.ts',
  compatibility_date: '2026-09-28', compatibility_flags: ['nodejs_compat'],
  workers_dev: false, preview_urls: false, routes: [],
  vars: {
    ENVIRONMENT: 'production', REALTIME_ENABLED: 'false', STRIPE_ENVIRONMENT: 'test',
    FRONTEND_URL: 'https://vapt.app.br', CORS_ORIGINS: 'https://vapt.app.br',
    API_PUBLIC_URL: 'https://api.vapt.app.br', BETTER_AUTH_URL: 'https://api.vapt.app.br',
    BETTER_AUTH_TRUSTED_ORIGINS: 'https://vapt.app.br,https://api.vapt.app.br',
    STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_synthetic',
    STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_BUSINESS: 'price_business',
    RESEND_TEMPLATE_VERIFY_ACCOUNT: 'account-confirmation', RESEND_TEMPLATE_RESET_PASSWORD: 'password-reset',
    EMAIL_FROM: 'Vapt <no-reply@vapt.app.br>', R2_ACCOUNT_ID: '3ce69408aa5112617a282957aba71932',
    R2_BUCKET_NAME: 'vapt-assets-production', R2_PUBLIC_BASE_URL: 'https://pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev',
    R2_UPLOAD_URL_TTL_SECONDS: '60',
  },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: '2885c609a66641b3b716190c2d467902' }],
  r2_buckets: [{ binding: 'R2_BUCKET', bucket_name: 'vapt-assets-production' }],
  durable_objects: { bindings: [{ name: 'RESTAURANT_REALTIME', class_name: 'RestaurantRealtime' }] },
  migrations: [{ tag: 'stage13-realtime-production-sqlite-v1', new_sqlite_classes: ['RestaurantRealtime'] }],
  ratelimits: ['AUTH', 'BILLING', 'ORDERS', 'STORAGE', 'WEBHOOKS', 'PUBLIC'].map((prefix, index) => ({
    name: `${prefix}_RATE_LIMIT`, namespace_id: String(13011 + index),
    simple: { limit: [20, 60, 30, 30, 300, 120][index], period: 60 },
  })),
});
async function checker() {
  const feature = await import('./verify-production-preparation-config.mjs').catch(() => null);
  assert.equal(typeof feature?.checkProductionPreparationConfig, 'function', 'production preparation guard is not implemented');
  return feature.checkProductionPreparationConfig;
}
async function rejects(mutators) {
  const check = await checker();
  for (const mutate of mutators) {
    const config = valid(); mutate(config);
    const result = check(config);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  }
}
test('accepts isolated production resources while all public ingress and realtime remain off', async () => {
  const check = await checker();
  assert.deepEqual(check(valid()), { ok: true, failures: [] });
  assert.equal(check(null).ok, false);
});
test('rejects preview database, bucket, origins and credential-bearing configuration', async () => {
  await rejects([
    c => { c.hyperdrive[0].id = '0c05fec2924b4f3b9225f3d689ba7ea9'; },
    c => { c.hyperdrive[0].origin = { user: 'neondb_owner' }; },
    c => { c.r2_buckets[0].bucket_name = 'vapt-assets-preview'; },
    c => { c.vars.FRONTEND_URL = 'https://infra-foundation-vapt-web.autoistloko.workers.dev'; },
    c => { c.vars.R2_PUBLIC_BASE_URL = 'https://pub-c7718cfb495f4c83866dfe3ed8c52890.r2.dev'; },
    c => { c.vars.RESEND_API_KEY = 'synthetic-secret'; },
    c => { c.vars.DATABASE_URL = 'postgres://synthetic-secret@example/vapt'; },
  ]);
});
test('rejects public routes, previews, triggers, queues, paid settings and premature activation', async () => {
  await rejects([
    c => { c.workers_dev = true; }, c => { c.preview_urls = true; },
    c => { c.routes = [{ pattern: 'api.vapt.app.br', custom_domain: true }]; },
    c => { delete c.routes; }, c => { c.previews = {}; },
    c => { c.triggers = { crons: ['* * * * *'] }; }, c => { c.queues = {}; },
    c => { c.usage_model = 'unbound'; }, c => { c.limits = { cpu_ms: 30000 }; },
    c => { c.vars.REALTIME_ENABLED = 'true'; }, c => { c.vars.STRIPE_ENVIRONMENT = 'live'; },
  ]);
});
test('rejects cross-worker or shared DO namespaces and destructive or paid migrations', async () => {
  await rejects([
    c => { c.main = 'src/worker/parallel-preview-entry.ts'; },
    c => { c.durable_objects.bindings[0].script_name = 'vapt-api-parallel'; },
    c => { c.durable_objects.bindings[0].namespace_id = '69fbe1f54ad64a93b7cb761910da094a'; },
    c => { c.migrations[0] = { tag: 'stage13-realtime-production-sqlite-v1', new_classes: ['RestaurantRealtime'] }; },
    c => { c.migrations.push({ tag: 'v2', deleted_classes: ['RestaurantRealtime'] }); },
  ]);
});
test('rejects weak or reused rate-limit authority and broader CORS/auth origins', async () => {
  await rejects([
    c => { c.ratelimits[0].simple.limit = 200; },
    c => { c.ratelimits[0].namespace_id = '11011'; },
    c => { c.ratelimits[1].namespace_id = c.ratelimits[0].namespace_id; },
    c => { c.vars.CORS_ORIGINS = '*'; },
    c => { c.vars.BETTER_AUTH_TRUSTED_ORIGINS += ',https://other.example'; },
  ]);
});
test('committed preparation config passes the same gate', async () => {
  const check = await checker();
  assert.deepEqual(check(JSON.parse(readFileSync(new URL('../wrangler.worker-production.jsonc', import.meta.url), 'utf8'))), { ok: true, failures: [] });
});
test('CLI fails closed without reflecting unsafe inputs', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-production-preparation-config.mjs', import.meta.url)), 'synthetic-secret'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
  assert.match(result.stdout, /"ok":false/);
});
