import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const feature = () => import('./catalog-operator.mjs');

for (const environment of ['preview', 'production']) {
  test(`${environment} deployment is blocked before any subprocess, regardless of local readiness`, async () => {
    const { runCatalogOperator } = await feature();
    const result = runCatalogOperator(['deploy', environment], () => { throw new Error('Must not invoke Wrangler'); });
    assert.equal(result.status, 1);
    assert.equal(result.report.code, 'catalog_deployment_blocked');
    assert.equal(result.report.activationReady, false);
  });
  test(`${environment} preparation check cannot become deployment permission`, async () => {
    const { runCatalogOperator } = await feature();
    const result = runCatalogOperator(['check', environment], () => { throw new Error('Check must remain offline'); });
    assert.equal(result.status, 0);
    assert.equal(result.report.ok, true);
    assert.equal(result.report.activationReady, false);
  });
}

for (const args of [[], ['build', 'preview'], ['build', 'production', '--dry-run=false'],
  ['deploy', 'production', '--approve'], ['check', 'production', '--config', 'synthetic-secret'],
  ['build', 'production', '--var', 'PUBLIC_CATALOG_WRITER_ENABLED:true'], ['deploy', 'synthetic-secret']]) {
  test(`invalid operator shape ${JSON.stringify(args)} cannot forward arguments or expose values`, async () => {
    const { runCatalogOperator } = await feature();
    const result = runCatalogOperator(args, () => { throw new Error('Invalid input must not start a child'); });
    assert.equal(result.status, 1);
    assert.equal(result.report.code, 'catalog_operator_invalid');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|PUBLIC_CATALOG_WRITER_ENABLED/);
  });
}

test('production build invokes only pinned local Wrangler with a non-overridable dry-run and guarded config', async () => {
  const { runCatalogOperator } = await feature();
  let calls = 0;
  const result = runCatalogOperator(['build', 'production'], (executable, args, options) => {
    calls++;
    assert.equal(executable, process.execPath);
    assert.equal(args.length, 5);
    assert.match(args[0], /node_modules[/\\]wrangler[/\\]bin[/\\]wrangler\.js$/);
    assert.deepEqual(args.slice(1), ['deploy', '--dry-run', '--config', 'wrangler.worker-catalog-production.jsonc']);
    assert.equal(options.cwd, root);
    assert.equal(options.shell, false);
    assert.equal(options.env.WRANGLER_SEND_METRICS, 'false');
    assert.equal(options.env.CLOUDFLARE_PREVIEW_BUILD, 'false');
    return { status: 0 };
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 0);
  assert.equal(result.report.deployed, false);
  assert.equal(result.report.activationReady, false);
});

for (const outcome of [{ status: 7 }, { status: null, error: new Error('synthetic-secret') }]) {
  test(`failed or interrupted dry-run cannot report a successful build (${outcome.status})`, async () => {
    const { runCatalogOperator } = await feature();
    const result = runCatalogOperator(['build', 'production'], () => outcome);
    assert.equal(result.status, 1);
    assert.equal(result.report.code, 'catalog_build_failed');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  });
}

test('all registered deployment aliases really execute the blocking gate, never their previous Wrangler commands', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  const names = Object.keys(scripts).filter(name => name.startsWith('deploy:'));
  assert.deepEqual(names.sort(), ['deploy:worker-production-observability', 'deploy:worker-production-public', 'deploy:worker-production-realtime']);
  for (const name of names) {
    // Safety preflight: never execute the legacy live command during a RED test.
    assert.equal(scripts[name], 'node scripts/catalog-operator.mjs deploy production');
    const child = spawnSync(process.execPath, scripts[name].split(' ').slice(1), {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: 'synthetic-must-not-leak' },
    });
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout.trim()).code, 'catalog_deployment_blocked');
    assert.doesNotMatch(child.stdout + child.stderr, /synthetic-must-not-leak|wrangler [0-9]/i);
  }
});

test('real CLI rejects attempts to override dry-run without starting Wrangler or echoing arguments', async () => {
  await feature();
  const child = spawnSync(process.execPath, ['scripts/catalog-operator.mjs', 'build', 'production', '--dry-run=false', 'synthetic-secret'],
    { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout.trim()).code, 'catalog_operator_invalid');
  assert.doesNotMatch(child.stdout + child.stderr, /synthetic-secret|wrangler [0-9]/i);
});
