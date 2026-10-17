import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCatalogConfig } from './verify-catalog-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rejected = code => ({ status: 1, report: { ok: false, code, activationReady: false } });

// Preparation-only operator. No deployment branch invokes Wrangler, auth, HTTP,
// provider readback or provisioning. Opening that gate needs reviewed code and
// real evidence, not a CLI approval boolean or inherited environment variable.
export function runCatalogOperator(args, execute = spawnSync) {
  if (!Array.isArray(args) || args.length !== 2
    || !['check', 'build', 'deploy'].includes(args[0])
    || !['preview', 'production'].includes(args[1])
    || (args[0] === 'build' && args[1] !== 'production')) return rejected('catalog_operator_invalid');
  const [mode, environment] = args;
  if (mode === 'deploy') return rejected('catalog_deployment_blocked');
  const configuration = `wrangler.worker-catalog-${environment}.jsonc`;
  try {
    const validation = checkCatalogConfig(JSON.parse(readFileSync(resolve(root, configuration), 'utf8')));
    if (!validation.ok) return rejected('catalog_configuration_invalid');
    if (mode === 'check') return { status: 0, report: { ...validation, configuration } };
    // Do not forward caller args. npm's trailing arguments cannot remove or
    // override --dry-run, select another environment, set vars or change config.
    const result = execute(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy', '--dry-run', '--config', configuration], {
      cwd: root, shell: false, windowsHide: true, stdio: 'inherit', timeout: 120_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_ENV: '', CLOUDFLARE_PREVIEW_BUILD: 'false' },
    });
    if (result.status !== 0 || result.error || result.signal) return rejected('catalog_build_failed');
    return { status: 0, report: { ok: true, code: 'catalog_build_prepared', configuration,
      deployed: false, activationReady: false } };
  } catch { return rejected(mode === 'build' ? 'catalog_build_failed' : 'catalog_configuration_invalid'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runCatalogOperator(process.argv.slice(2));
  console.log(JSON.stringify(result.report));
  process.exitCode = result.status;
}
