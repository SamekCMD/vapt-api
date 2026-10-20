// Disposable local PostgreSQL only. No dotenv, cloud CLI, service installation or remote URL.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = resolve(apiRoot, '../..');
const workspace = resolve(schemaRoot, '.superpowers/sdd/2026-10-19-tenant-parity-restoration');
const bin = resolve(schemaRoot,
  '.superpowers/sdd/infra-migration-public-catalog-event-driven-plan/pg-runtime/extracted/pgsql/bin');
const stages = ['009', '010', '011', '012'];
const args = process.argv.slice(2);
if (args.length > 2 || args.some(arg=>!/^--through=(009|010|011|012)$/.test(arg) && arg!=='--only=organization-billing') ||
  new Set(args.map(arg=>arg.split('=')[0])).size!==args.length) {
  throw new Error('Usage: npm run test:tenant-pg -- [--through=009|010|011|012] [--only=organization-billing]');
}
const onlyBilling=args.includes('--only=organization-billing');
const through = args.find(arg=>arg.startsWith('--through='))?.split('=')[1] ?? [...stages].reverse().find((n) =>
  existsSync(resolve(schemaRoot, `infra/neon/${n}_${({
    '009': 'public_catalog_publication', '010': 'tenant_foundation',
    '011': 'organization_billing', '012': 'tenant_onboarding',
  })[n]}.sql`)));
if(onlyBilling && through==='009') throw new Error('Organization billing requires the tenant foundation');
const exe = (name) => resolve(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
if (!existsSync(exe('initdb'))) throw new Error('Existing local PostgreSQL runtime is absent; no installation attempted');
const password = randomBytes(32).toString('hex');
const runId = randomBytes(8).toString('hex');
const cluster = resolve(workspace, `pg-${runId}`);
const data = resolve(cluster, 'data');
await mkdir(cluster, { recursive: true });
const safe = (value) => String(value).split(password).join('[redacted]')
  .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[local database URL redacted]');
async function command(program, argv, env = process.env) {
  const child = spawn(program, argv, { cwd: apiRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (part) => { output += part; });
  const code = await new Promise((ok, fail) => {
    child.once('error', fail); child.once('close', ok);
  });
  return { code, output: safe(output) };
}
async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}
const port = await freePort();
const url = new URL(`postgresql://vapt_tenant_admin@127.0.0.1:${port}/postgres`);
url.password = password;
url.searchParams.set('options', `-c vapt.tenant_test_through=${through}`);
let postgres;
let serverLog;
try {
  // initdb reads a generated password from a named pipe, never argv or a credential file.
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\vapt_tenant_${runId}` : resolve(cluster, 'password.sock');
  const pipe = createServer((socket) => socket.end(`${password}\n`));
  await new Promise((ok, fail) => { pipe.once('error', fail); pipe.listen(pipeName, ok); });
  try {
    const init = await command(exe('initdb'), ['-D', data, '-U', 'vapt_tenant_admin',
      '--auth=scram-sha-256', `--pwfile=${pipeName}`, '--encoding=UTF8', '--no-locale', '--no-instructions']);
    if (init.code !== 0) throw new Error(`Local initdb failed: ${init.output}`);
  } finally { await new Promise((ok) => pipe.close(ok)); }
  serverLog = await open(resolve(cluster, 'server.log'), 'a');
  postgres = spawn(exe('postgres'), ['-D', data, '-h', '127.0.0.1', '-p', String(port),
    '-c', 'max_connections=20', '-c', 'shared_buffers=32MB', '-c', 'log_statement=none',
    '-c', 'log_connections=off', '-c', 'log_disconnections=off', '-c', 'timezone=UTC'],
  { windowsHide: true, stdio: ['ignore', serverLog.fd, serverLog.fd] });
  let serverError;
  postgres.on('error', (error) => { serverError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverError) throw serverError;
    const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 500 });
    try { await client.connect(); await client.query('select 1'); ready = true; break; }
    catch { await new Promise((ok) => setTimeout(ok, 100)); }
    finally { await client.end().catch(() => {}); }
  }
  if (!ready) throw new Error('Disposable loopback PostgreSQL did not become ready');
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  try {
    for (const role of ['vapt_api_preview', 'vapt_api_production']) {
      await admin.query(`create role ${role} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    }
  } finally { await admin.end(); }
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/(?:DATABASE|^PG|^NEON|^DOTENV|^NODE_OPTIONS|^TENANT_)/i.test(key)));
  // These are the only database/test configuration values inherited by the test child.
  childEnv.TENANT_TEST_DATABASE_URL = url.href;
  childEnv.TENANT_SCHEMA_ROOT = schemaRoot;
  let tests = ['src/modules/tenancy/schema.pg-integration.ts'];
  if (through !== '009') tests.push('src/modules/tenancy/authorization.pg-integration.ts');
  if (through !== '009') tests.push('src/modules/tenancy/restaurant-scope.pg-integration.ts');
  if (through !== '009') tests.push('src/modules/tenancy/operational-scope.pg-integration.ts');
  if (through !== '009') tests.push('src/modules/tenancy/catalog-scope.pg-integration.ts');
  if (through !== '009') tests.push('src/modules/catalog-publication/transaction.pg-integration.ts');
  if (through !== '009') tests.push('src/modules/tenancy/payment-realtime.pg-integration.ts');
  if (through !== '009') tests.push('src/modules/billing/stripe/organization-billing.pg-integration.ts');
  if(onlyBilling) tests=['src/modules/billing/stripe/organization-billing.pg-integration.ts'];
  const result = await command(process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests], childEnv);
  process.stdout.write(result.output);
  process.exitCode = result.code ?? 1;
} catch (error) {
  process.stderr.write(`${safe(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
} finally {
  if (postgres) {
    const stopped = await command(exe('pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop']);
    if (stopped.code !== 0 && postgres.exitCode === null) {
      postgres.kill();
      process.stderr.write('Local PostgreSQL required fallback shutdown\n');
      process.exitCode = 1;
    }
  }
  await serverLog?.close();
}
