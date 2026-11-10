import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkRealtimePreviewConfig } from './verify-realtime-preview-config.mjs';

function isolated() {
  const config = JSON.parse(readFileSync(new URL('../wrangler.worker-parallel-preview.jsonc', import.meta.url), 'utf8'));
  config.main = 'src/worker/parallel-preview-entry.ts';
  config.migrations = [{ tag: 'stage12-realtime-sqlite-v1', new_sqlite_classes: ['RestaurantRealtime'] }];
  config.previews.vars.REALTIME_ENABLED = 'true';
  config.previews.durable_objects = { bindings: [{ name: 'RESTAURANT_REALTIME', class_name: 'RestaurantRealtime' }] };
  return config;
}
function rejects(mutate) {
  const config = isolated();
  mutate(config);
  const result = checkRealtimePreviewConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
}
test('accepts only the isolated SQLite realtime Preview', () => {
  assert.deepEqual(checkRealtimePreviewConfig(isolated()), { ok: true, failures: [] });
  assert.equal(checkRealtimePreviewConfig(null).ok, false);
});
test('rejects cross-Worker and shared namespaces or unexpected classes', () => {
  rejects(c => { c.previews.durable_objects.bindings[0].script_name = 'production'; });
  rejects(c => { c.previews.durable_objects.bindings[0].namespace_id = 'shared'; });
  rejects(c => { c.previews.durable_objects.bindings[0].class_name = 'Other'; });
  rejects(c => { c.previews.durable_objects.bindings.push({ name: 'OTHER', class_name: 'Other' }); });
  rejects(c => { delete c.previews.durable_objects; });
});
test('rejects production data bindings and role/host overrides', () => {
  rejects(c => { c.previews.hyperdrive[0].id = '2885c609a66641b3b716190c2d467902'; });
  rejects(c => { c.previews.hyperdrive[0].origin = { user: 'vapt_api_production' }; });
  rejects(c => { c.previews.r2_buckets[0].bucket_name = 'vapt-assets-production'; });
  rejects(c => { c.previews.vars.DATABASE_ROLE = 'vapt_api_production'; });
});
test('rejects top-level authority, paid/KV migrations and disabled Preview flag', () => {
  rejects(c => { c.durable_objects = c.previews.durable_objects; });
  rejects(c => { c.vars = { REALTIME_ENABLED: 'true' }; });
  rejects(c => { c.previews.vars.REALTIME_ENABLED = 'false'; });
  rejects(c => { c.migrations[0] = { tag: 'stage12-realtime-sqlite-v1', new_classes: ['RestaurantRealtime'] }; });
  rejects(c => { c.migrations[0].renamed_classes = [{ from: 'Production', to: 'RestaurantRealtime' }]; });
  rejects(c => { c.migrations[0].tag = 'another-migration'; });
  rejects(c => { c.migrations.push({ tag: 'extra', deleted_classes: ['Production'] }); });
});
test('rejects wrapper/bearer bypass, new reachability, Cron and queues', () => {
  rejects(c => { c.main = 'src/worker/index-entry.ts'; });
  rejects(c => { c.main = 'src/worker/parallel-preview.ts'; });
  rejects(c => { c.preview_urls = true; });
  rejects(c => { c.workers_dev = true; });
  rejects(c => { c.routes = ['api.vapt.app.br/*']; });
  rejects(c => { c.previews.routes = ['other.example/*']; });
  rejects(c => { c.previews.triggers = { crons: ['* * * * *'] }; });
  rejects(c => { c.previews.queues = { consumers: [{ queue: 'production' }] }; });
  rejects(c => { c.previews.vars.API_PUBLIC_URL = 'https://unprotected.example'; });
  rejects(c => { c.previews.vars.CORS_ORIGINS = '*'; });
  rejects(c => { c.previews.vars.PARALLEL_PREVIEW_TOKEN = 'synthetic-secret'; });
});
