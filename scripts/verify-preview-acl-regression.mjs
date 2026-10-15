// Credentials enter only on stdin. Every temporary privilege/ownership change
// is transaction-local and rolled back, including when verification rejects it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

export function assertPreviewAclTarget(input) {
  try {
    const target = new URL(input.ownerUrl);
    if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
        target.hostname !== 'ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech' ||
        !['', '5432'].includes(target.port) || target.pathname !== '/vapt' ||
        target.username !== 'neondb_owner' || !target.password || target.hash ||
        typeof input.verifierPath !== 'string' ||
        basename(input.verifierPath) !== 'verify-worker-preview-role.sql' ||
        win32.basename(input.verifierPath) !== 'verify-worker-preview-role.sql' ||
        [...target.searchParams].some(([key, value]) =>
          !((key === 'sslmode' && ['require', 'verify-full'].includes(value)) ||
            (key === 'channel_binding' && value === 'require')))) throw new Error();
  } catch { throw new Error('Unexpected preview regression target'); }
}

export async function runPreviewAclRegression(input, {
  createPool = options => new Pool(options), log = value => console.log(JSON.stringify(value)),
} = {}) {
  assertPreviewAclTarget(input); // Must precede file reads, pool creation and DB IO.
  const verifier = await readFile(input.verifierPath, 'utf8');
  const pool = createPool({ connectionString: input.ownerUrl, max: 1,
    connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  const cases = [
    { name: 'baseline', sql: null, denied: false },
    { name: 'excluded_column_read', sql: 'GRANT SELECT(payload) ON public.payment_effect_outbox TO vapt_api_preview', denied: true },
    { name: 'excluded_routine_execute', sql: 'GRANT EXECUTE ON FUNCTION public.apply_payment_transition(uuid,integer,text,text,text,timestamptz,text[]) TO vapt_api_preview', denied: true },
    { name: 'routine_ownership', sql: `
      GRANT vapt_api_preview TO neondb_owner;
      GRANT CREATE ON SCHEMA public TO vapt_api_preview;
      ALTER FUNCTION public.count_pending_payment_effects() OWNER TO vapt_api_preview;
      REVOKE CREATE ON SCHEMA public FROM vapt_api_preview;`, denied: true },
  ];
  let failed = 0;
  try {
    for (const scenario of cases) {
      const client = await pool.connect();
      let phase = 'setup';
      try {
        await client.query('BEGIN');
        if (scenario.sql) await client.query(scenario.sql);
        await client.query('SAVEPOINT verify_acl');
        phase = 'verification';
        let rejection = null;
        try { await client.query(verifier); } catch (error) { rejection = error; }
        await client.query('ROLLBACK TO SAVEPOINT verify_acl');
        assert.equal(rejection?.code ?? null, scenario.denied ? 'P0001' : null);
        log({ test: scenario.name, result: 'passed' });
      } catch (error) {
        failed++;
        log({ test: scenario.name, result: 'failed', phase,
          sqlstate: /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : null,
          membershipRequired: /must be (?:a )?member|must be able to SET ROLE/.test(error.message ?? '') });
      } finally {
        try { await client.query('ROLLBACK'); } finally { client.release(); }
      }
    }
    await pool.query(verifier);
    log({ tests: cases.length, passed: cases.length - failed, failed, rollback: 'verified' });
    return failed === 0;
  } finally {
    input.ownerUrl = null;
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let raw = '';
  let input;
  try {
    for await (const chunk of process.stdin) raw += chunk;
    input = JSON.parse(raw); raw = '';
    if (!await runPreviewAclRegression(input)) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ regression: 'failed', diagnostic: 'Target, baseline or rollback verification failed' }));
    process.exitCode = 1;
  } finally { raw = ''; if (input) input.ownerUrl = null; }
}
