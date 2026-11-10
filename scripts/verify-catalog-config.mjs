import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRealtimePreviewConfig } from './verify-realtime-preview-config.mjs';
import { checkRealtimeProductionConfig } from './verify-realtime-production-config.mjs';

const root = new URL('../', import.meta.url);
const pending = ['postgres-integration', 'r2-privacy', 'active-writers', 'cpu-8mib', 'final-review', 'remote-readback'];
const failure = () => ({ ok: false, activationReady: false, failures: ['Invalid catalog preparation configuration'] });

export function expectedCatalogConfig(environment) {
  if (!['preview', 'production'].includes(environment)) throw new Error('Invalid catalog environment');
  const filename = environment === 'preview' ? 'wrangler.worker-parallel-preview.jsonc' : 'wrangler.worker-production-realtime.jsonc';
  const config = JSON.parse(readFileSync(new URL(filename, root), 'utf8'));
  if (!(environment === 'preview' ? checkRealtimePreviewConfig(config) : checkRealtimeProductionConfig(config)).ok) throw new Error('Invalid catalog baseline');
  config.limits = { cpu_ms: 1000 };
  const active = config.previews ?? config;
  active.vars.PUBLIC_CATALOG_READER_ENABLED = 'false';
  active.vars.PUBLIC_CATALOG_WRITER_ENABLED = 'false';
  active.r2_buckets.push({ binding: 'PUBLIC_CATALOG_BUCKET', bucket_name: `vapt-catalog-${environment}` });
  active.durable_objects.bindings.push({ name: 'PUBLIC_CATALOG_COORDINATOR', class_name: 'PublicCatalogCoordinator' });
  config.migrations.push({ tag: `catalog-publication-${environment}-sqlite-v1`, new_sqlite_classes: ['PublicCatalogCoordinator'] });
  return config;
}

// Offline PREPARATION validation, never an activation/deployment permit. Public
// image URLs in the existing bucket do not prove snapshot privacy. Real R2 ACL,
// PostgreSQL, CPU and active writers are separate gates; no caller can pass an
// approval boolean to silently waive them.
export function checkCatalogConfig(config, options = {}) {
  try {
    if (!isDeepStrictEqual(options, {})) return failure();
    const environment = (config?.previews ?? config)?.vars?.ENVIRONMENT;
    if (!isDeepStrictEqual(config, expectedCatalogConfig(environment))) return failure();
    return { ok: true, activationReady: false, failures: [], pending: [...pending] };
  } catch { return failure(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error();
    const result = checkCatalogConfig(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
  } catch { console.log(JSON.stringify(failure())); process.exitCode = 1; }
}
