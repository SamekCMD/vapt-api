import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const topKeys = new Set(['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags',
  'workers_dev', 'preview_urls', 'routes', 'vars', 'hyperdrive', 'r2_buckets', 'durable_objects', 'migrations', 'ratelimits']);
const fixedVars = {
  ENVIRONMENT: 'production', REALTIME_ENABLED: 'false', STRIPE_ENVIRONMENT: 'test',
  CORS_ORIGINS: 'https://vapt.app.br', FRONTEND_URL: 'https://vapt.app.br',
  API_PUBLIC_URL: 'https://api.vapt.app.br', BETTER_AUTH_URL: 'https://api.vapt.app.br',
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://vapt.app.br,https://api.vapt.app.br',
  RESEND_TEMPLATE_VERIFY_ACCOUNT: 'account-confirmation', RESEND_TEMPLATE_RESET_PASSWORD: 'password-reset',
  EMAIL_FROM: 'Vapt <no-reply@vapt.app.br>', R2_ACCOUNT_ID: '3ce69408aa5112617a282957aba71932',
  R2_BUCKET_NAME: 'vapt-assets-production', R2_PUBLIC_BASE_URL: 'https://pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev',
  R2_UPLOAD_URL_TTL_SECONDS: '60',
};
const dynamicVars = { STRIPE_PORTAL_CONFIGURATION_ID: /^bpc_[A-Za-z0-9]+$/,
  STRIPE_PRICE_STARTER: /^price_[A-Za-z0-9]+$/, STRIPE_PRICE_PRO: /^price_[A-Za-z0-9]+$/, STRIPE_PRICE_BUSINESS: /^price_[A-Za-z0-9]+$/ };
const limits = new Map([
  ['AUTH_RATE_LIMIT', ['13011', 20]], ['BILLING_RATE_LIMIT', ['13012', 60]],
  ['ORDERS_RATE_LIMIT', ['13013', 30]], ['STORAGE_RATE_LIMIT', ['13014', 30]],
  ['WEBHOOKS_RATE_LIMIT', ['13015', 300]], ['PUBLIC_RATE_LIMIT', ['13016', 120]],
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const one = value => Array.isArray(value) && value.length === 1;
const invalid = () => { throw new Error(); };

// Preparation-only static gate. It never provisions anything or establishes
// actual ACLs, namespace resolution, secret scope, public R2 availability or cost.
export function checkProductionPreparationConfig(config) {
  try {
    if (!record(config) || Object.keys(config).some(key => !topKeys.has(key)) ||
      config.name !== 'vapt-api-production' || config.main !== 'src/worker/realtime-entry.ts' ||
      config.compatibility_date !== '2026-09-28' || !one(config.compatibility_flags) || config.compatibility_flags[0] !== 'nodejs_compat' ||
      config.workers_dev !== false || config.preview_urls !== false || !Array.isArray(config.routes) || config.routes.length !== 0) invalid();
    if (!keys(config.vars, [...Object.keys(fixedVars), ...Object.keys(dynamicVars)]) ||
      Object.entries(fixedVars).some(([key, value]) => config.vars[key] !== value) ||
      Object.entries(dynamicVars).some(([key, pattern]) => typeof config.vars[key] !== 'string' || !pattern.test(config.vars[key]))) invalid();
    if (!one(config.hyperdrive) || !keys(config.hyperdrive[0], ['binding', 'id']) ||
      config.hyperdrive[0].binding !== 'HYPERDRIVE' || config.hyperdrive[0].id !== '2885c609a66641b3b716190c2d467902' ||
      !one(config.r2_buckets) || !keys(config.r2_buckets[0], ['binding', 'bucket_name']) ||
      config.r2_buckets[0].binding !== 'R2_BUCKET' || config.r2_buckets[0].bucket_name !== 'vapt-assets-production') invalid();
    if (!keys(config.durable_objects, ['bindings']) || !one(config.durable_objects.bindings) ||
      !keys(config.durable_objects.bindings[0], ['name', 'class_name']) ||
      config.durable_objects.bindings[0].name !== 'RESTAURANT_REALTIME' || config.durable_objects.bindings[0].class_name !== 'RestaurantRealtime' ||
      !one(config.migrations) || !keys(config.migrations[0], ['tag', 'new_sqlite_classes']) ||
      config.migrations[0].tag !== 'stage13-realtime-production-sqlite-v1' ||
      !one(config.migrations[0].new_sqlite_classes) || config.migrations[0].new_sqlite_classes[0] !== 'RestaurantRealtime') invalid();
    if (!Array.isArray(config.ratelimits) || config.ratelimits.length !== limits.size) invalid();
    const names = new Set();
    for (const binding of config.ratelimits) {
      const expected = record(binding) ? limits.get(binding.name) : undefined;
      if (!expected || !keys(binding, ['name', 'namespace_id', 'simple']) || names.has(binding.name) || binding.namespace_id !== expected[0] ||
        !keys(binding.simple, ['limit', 'period']) || binding.simple.limit !== expected[1] || binding.simple.period !== 60) invalid();
      names.add(binding.name);
    }
    return { ok: true, failures: [] };
  } catch { return { ok: false, failures: ['Invalid unexposed production preparation configuration'] }; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = checkProductionPreparationConfig(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, failures: ['Configuration could not be read'] }));
    process.exitCode = 1;
  }
}
