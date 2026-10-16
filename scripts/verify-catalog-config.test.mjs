import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const feature = () => import('./verify-catalog-config.mjs');
const candidate = environment => JSON.parse(readFileSync(new URL(`../wrangler.worker-catalog-${environment}.jsonc`, import.meta.url), 'utf8'));

for (const environment of ['preview', 'production']) {
  test(`${environment} candidate preserves baseline and stays preparation-only`, async () => {
    const { checkCatalogConfig, expectedCatalogConfig } = await feature();
    const config = candidate(environment);
    assert.deepEqual(config, expectedCatalogConfig(environment));
    const result = checkCatalogConfig(config);
    assert.equal(result.ok, true); assert.equal(result.activationReady, false);
    assert.ok(result.pending.includes('r2-privacy')); assert.ok(result.pending.includes('postgres-integration'));
    assert.equal(checkCatalogConfig(config, { activation: true }).ok, false);
  });
  const poisons = {
    cpu: (value, active) => { value.limits.cpu_ms = 1001; },
    writer: (value, active) => { active.vars.PUBLIC_CATALOG_WRITER_ENABLED = 'true'; },
    reader: (value, active) => { active.vars.PUBLIC_CATALOG_READER_ENABLED = 'true'; },
    secret: (value, active) => { active.vars.RESEND_API_KEY = 'synthetic-secret'; },
    namespace: (value, active) => { active.durable_objects.bindings[1].namespace_id = 'invented'; },
    migration: value => { value.migrations.shift(); },
    deleteClass: value => { value.migrations[1].deleted_classes = ['RestaurantRealtime']; },
    rate: (value, active) => { active.ratelimits[0].simple.limit = 9999; },
    publicURL: value => { value.workers_dev = true; },
    bucket: (value, active) => { active.r2_buckets[0].bucket_name = environment === 'preview' ? 'vapt-assets-production' : 'vapt-assets-preview'; },
    sql: (value, active) => { active.hyperdrive[0].id = 'other-branch'; },
  };
  for (const [name, poison] of Object.entries(poisons)) test(`${environment} rejects ${name} drift without exposing values`, async () => {
    const { checkCatalogConfig } = await feature(); const config = candidate(environment); poison(config, config.previews ?? config);
    const result = checkCatalogConfig(config); assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|invented|other-branch/);
  });
}

test('CLI never accepts an activation argument or echoes supplied credentials', async () => {
  await feature();
  const result = spawnSync(process.execPath, ['scripts/verify-catalog-config.mjs', 'synthetic-secret', '--activate'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
});
