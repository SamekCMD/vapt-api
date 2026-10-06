import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertParallelPreviewConfig } from './verify-parallel-preview-config.mjs';

const apiOrigin = 'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const frontendOrigin = 'https://infra-foundation-vapt-web.autoistloko.workers.dev';

// Static guard only. Actual Access policy, account plan and resolved namespace
// isolation must also be inspected before remote smoke. Never claim otherwise.
export function checkRealtimePreviewConfig(config) {
  try {
    assertParallelPreviewConfig(config);
    if (config.main !== 'src/worker/parallel-preview-entry.ts' ||
        config.previews.vars.API_PUBLIC_URL !== apiOrigin ||
        config.previews.vars.BETTER_AUTH_URL !== apiOrigin ||
        config.previews.vars.FRONTEND_URL !== frontendOrigin ||
        config.previews.vars.CORS_ORIGINS !== frontendOrigin ||
        config.previews.vars.BETTER_AUTH_TRUSTED_ORIGINS !== `${frontendOrigin},${apiOrigin}`) throw new Error();
    return { ok: true, failures: [] };
  } catch { return { ok: false, failures: ['Invalid isolated realtime Preview configuration'] }; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = checkRealtimePreviewConfig(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, failures: ['Configuration could not be read'] }));
    process.exitCode = 1;
  }
}
