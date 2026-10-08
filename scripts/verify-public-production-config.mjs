import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProductionPreparationConfig } from './verify-production-preparation-config.mjs';

// Static gate only: does not provision domains, verify remote secrets or publish.
export function checkPublicProductionConfig(config) {
  const failure = { ok: false, failures: ['Invalid public production configuration'] };
  try {
    if (!config || config.account_id !== '3ce69408aa5112617a282957aba71932' || config.keep_vars !== true ||
      !Array.isArray(config.routes) || config.routes.length !== 1) return failure;
    const route = config.routes[0];
    if (!route || Object.keys(route).length !== 2 || route.pattern !== 'api.vapt.app.br' || route.custom_domain !== true) return failure;
    const { account_id, keep_vars, ...normalized } = config;
    return checkProductionPreparationConfig({ ...normalized, routes: [] }).ok ? { ok: true, failures: [] } : failure;
  } catch { return failure; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = checkPublicProductionConfig(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, failures: ['Configuration could not be read'] }));
    process.exitCode = 1;
  }
}
