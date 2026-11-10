import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRealtimeProductionConfig } from './verify-realtime-production-config.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const empty = value => Array.isArray(value) && value.length === 0;

// Explicit opt-in only. This checks policy, not platform metadata sanitization,
// real retention, completeness, delivery, readiness or a ceiling on costs.
export function checkProductionLoggingPolicy(policy) {
  return keys(policy, ['enabled', 'head_sampling_rate', 'redact_query_string', 'logs', 'traces', 'issues']) &&
    policy.enabled === true && policy.head_sampling_rate === 0.01 && policy.redact_query_string === true &&
    keys(policy.logs, ['enabled', 'invocation_logs', 'persist', 'destinations']) &&
    policy.logs.enabled === true && policy.logs.invocation_logs === false && policy.logs.persist === true && empty(policy.logs.destinations) &&
    keys(policy.traces, ['enabled', 'persist', 'destinations']) &&
    policy.traces.enabled === false && policy.traces.persist === false && empty(policy.traces.destinations) &&
    keys(policy.issues, ['enabled']) && policy.issues.enabled === false;
}

export function checkObservabilityProductionConfig(config) {
  const failure = { ok: false, failures: ['Invalid production logging configuration'] };
  try {
    if (!checkProductionLoggingPolicy(config?.observability)) return failure;
    const { observability, ...existing } = config;
    return checkRealtimeProductionConfig(existing).ok ? { ok: true, failures: [] } : failure;
  } catch { return failure; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 3) throw Error();
    const result = checkObservabilityProductionConfig(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ ok: false, failures: ['Configuration could not be read'] }));
    process.exitCode = 1;
  }
}
