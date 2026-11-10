import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPublicProductionConfig } from './verify-public-production-config.mjs';

// Explicit activation variant: normalize only the deliberately enabled flag,
// then apply every existing strict public-production resource/ingress guard.
// This is static validation, not remote readiness or an authorization bypass.
export function checkRealtimeProductionConfig(config) {
  try {
    if (config?.vars?.REALTIME_ENABLED !== 'true') throw Error();
    if (!checkPublicProductionConfig({ ...config, vars: { ...config.vars, REALTIME_ENABLED: 'false' } }).ok) throw Error();
    return { ok: true, failures: [] };
  } catch { return { ok: false, failures: ['Invalid realtime production configuration'] }; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 3) throw Error();
    const result = checkRealtimeProductionConfig(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, failures: ['Configuration could not be read'] }));
    process.exitCode = 1;
  }
}
