// Explicit operator integration test; credentials arrive only on stdin.
// All deliberately unsafe capabilities are introduced inside rollback-only
// transactions. No API traffic or persistent privilege change is performed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
raw = '';
const target = new URL(input.ownerUrl);
if (target.hostname !== 'ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech' ||
    target.pathname !== '/vapt' || target.username !== 'neondb_owner' ||
    !input.verifierPath?.endsWith('verify-worker-production-role.sql')) {
  throw new Error('Unexpected production regression target');
}
const verifier = await readFile(input.verifierPath, 'utf8');
const pool = new Pool({ connectionString: input.ownerUrl, max: 1,
  connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
const cases = [
  { name: 'baseline', sql: null, denied: false },
  { name: 'excluded_column_read', sql: 'GRANT SELECT(payload) ON public.payment_effect_outbox TO vapt_api_production', denied: true },
  { name: 'excluded_routine_execute', sql: 'GRANT EXECUTE ON FUNCTION public.apply_payment_transition(uuid,integer,text,text,text,timestamptz,text[]) TO vapt_api_production', denied: true },
  { name: 'routine_ownership', sql: `
    GRANT vapt_api_production TO neondb_owner;
    GRANT CREATE ON SCHEMA public TO vapt_api_production;
    ALTER FUNCTION public.count_pending_payment_effects() OWNER TO vapt_api_production;
    REVOKE CREATE ON SCHEMA public FROM vapt_api_production;`, denied: true },
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
      console.log(JSON.stringify({ test: scenario.name, result: 'passed' }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ test: scenario.name, result: 'failed', phase,
        sqlstate: error.code ?? null,
        membershipRequired: /must be (?:a )?member|must be able to SET ROLE/.test(error.message ?? '') }));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  // Ensure every introduced capability was rolled back.
  await pool.query(verifier);
  console.log(JSON.stringify({ tests: cases.length, passed: cases.length - failed, failed, rollback: 'verified' }));
  if (failed) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ regression: 'failed', diagnostic: 'Baseline or rollback verification failed' }));
  process.exitCode = 1;
} finally {
  input.ownerUrl = null;
  await pool.end();
}
