import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const feature = () => tsImport('./bootstrap-public-catalog.ts', import.meta.url);
const restaurantId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const cookie = 'better-auth.session_token=synthetic-private-session';
const dry = ['--environment', 'preview', '--restaurant-id', restaurantId];
const apply = [...dry, '--apply', '--operation-id', operationId, '--confirm-project-id', 'dawn-morning-27332079',
  '--confirm-branch-id', 'br-rough-dew-b6ydeygb', '--confirm-writer-coverage', '--confirm-readiness'];
const receipt = (phase = 'ready') => ({ operationId, restaurantId, phase, version: phase === 'accepted' ? null : '12', committed: phase !== 'accepted', retryable: phase !== 'ready' });
function fixture(options = {}) {
  const calls = []; let credentials = 0;
  const ports = { readSession: async () => { credentials++; return cookie; }, request: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'GET') return Response.json({ id: options.ownerId ?? restaurantId, email: 'synthetic-private-email' }, { status: options.getStatus ?? 200 });
    if (options.lostPost) throw new Error(cookie);
    return Response.json(options.response ?? { receipt: receipt(), result: { private: cookie } }, { status: options.postStatus ?? 200 });
  } };
  return { ports, calls, credentials: () => credentials };
}
for (const args of [[], ['--environment', 'preview'], ['--restaurant-id', restaurantId], ['--environment', 'production', '--restaurant-id', 'unknown-slug'],
  [...dry, '--restaurant-id', restaurantId], [...dry, '--api-url', 'https://synthetic-secret.invalid']]) {
  test(`bootstrapRequiresExplicitTargets: rejects invalid/duplicate/unknown arguments ${JSON.stringify(args).length}`, async () => {
    const { bootstrapPublicCatalog } = await feature(); const f = fixture();
    const result = await bootstrapPublicCatalog(args, f.ports);
    assert.equal(result.ok, false); assert.equal(f.calls.length, 0); assert.equal(f.credentials(), 0);
  });
}
test('dryRunDoesNotWrite: default mode does not even read credentials or query an owner', async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture();
  assert.deepEqual(await bootstrapPublicCatalog(dry, f.ports), { ok: true, environment: 'preview', targets: 1, writes: 0, mode: 'dry-run' });
  assert.equal(f.calls.length, 0); assert.equal(f.credentials(), 0);
});
test('multi-restaurant bootstrap never resolves or writes through a legacy me selection',async()=>{
  const {bootstrapPublicCatalog}=await feature();const f=fixture(),request=f.ports.request;
  f.ports.request=(url,init)=>url.includes('/restaurants/me')?Promise.resolve(Response.json({error:{code:'restaurant_selection_required'}},{status:409})):request(url,init);
  const result=await bootstrapPublicCatalog(apply,f.ports);assert.equal(result.ok,true);
  assert.equal(f.calls[0].url,'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev/restaurants/11111111-1111-4111-8111-111111111111');
  assert.equal(f.calls[1].url,'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev/restaurants/11111111-1111-4111-8111-111111111111/catalog/rebuild');
});

for (const flag of ['--confirm-writer-coverage', '--confirm-readiness']) test(`readerRequiresWriterCoverage: apply refuses missing ${flag}`, async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture();
  assert.equal((await bootstrapPublicCatalog(apply.filter(value => value !== flag), f.ports)).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.credentials(), 0);
});
test('apply verifies owner and uses only the fixed preview origin and protected in-memory session', async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture(); const result = await bootstrapPublicCatalog(apply, f.ports);
  assert.equal(result.ok, true); assert.deepEqual(result.receipt, receipt());
  assert.deepEqual(f.calls.map(call => [call.url, call.init.method]), [
    ['https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev/restaurants/11111111-1111-4111-8111-111111111111', 'GET'],
    ['https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev/restaurants/11111111-1111-4111-8111-111111111111/catalog/rebuild', 'POST'],
  ]);
  const post = f.calls[1].init; assert.equal(post.redirect, 'error'); assert.equal(post.headers.Cookie, cookie);
  assert.equal(post.headers['Idempotency-Key'], operationId); assert.equal(post.headers['X-Vapt-Catalog-Protocol'], '1');
  assert.equal(post.headers.Origin, 'https://infra-foundation-vapt-web.autoistloko.workers.dev'); assert.equal(post.body, '{}'); assert.ok(post.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|workers\.dev/);
});
test('production requires its own branch confirmation, never preview fallthrough', async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture();
  const args = apply.map(value => value === 'preview' ? 'production' : value);
  assert.equal((await bootstrapPublicCatalog(args, f.ports)).ok, false); assert.equal(f.calls.length, 0);
  const valid = args.map(value => value === 'br-rough-dew-b6ydeygb' ? 'br-odd-term-b6j2n9ms' : value);
  assert.equal((await bootstrapPublicCatalog(valid, f.ports)).ok, true); assert.equal(f.calls[0].url, 'https://api.vapt.app.br/restaurants/11111111-1111-4111-8111-111111111111');
});
test('another owner or unknown restaurant never starts a rebuild', async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture({ ownerId: operationId });
  assert.equal((await bootstrapPublicCatalog(apply, f.ports)).ok, false); assert.deepEqual(f.calls.map(call => call.init.method), ['GET']);
});
for (const stage of ['get', 'post']) test(`quotaFailureStops at ${stage}: no retries, activation or paid fallback`, async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture(stage === 'get' ? { getStatus: 503 } : { postStatus: 503 });
  assert.equal((await bootstrapPublicCatalog(apply, f.ports)).ok, false); assert.equal(f.calls.length, stage === 'get' ? 1 : 2);
});
test('accepted is not published and no automatic status polling is started', async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture({ response: { receipt: receipt('accepted') }, postStatus: 202 });
  const result = await bootstrapPublicCatalog(apply, f.ports); assert.equal(result.receipt.phase, 'accepted'); assert.equal(result.receipt.committed, false); assert.equal(f.calls.length, 2);
  assert.equal(result.postRequests, 1); assert.equal(Object.hasOwn(result, 'writes'), false, 'submitted is not a claim of a database write');
});

for (const stage of ['get', 'post']) test(`oversized ${stage} response is bounded and never printed`, async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture(); const original = f.ports.request; const seen = [];
  f.ports.request = async (url, init) => { seen.push(init.method); return init.method.toLowerCase() === stage ? Response.json({ id: restaurantId, private: 'synthetic-private'.repeat(5000) }) : original(url, init); };
  const result = await bootstrapPublicCatalog(apply, f.ports); assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  assert.deepEqual(seen, stage === 'get' ? ['GET'] : ['GET', 'POST']);
});

test('real CLI rejects malformed, extra-field and oversized protected input before preflight', async () => {
  await feature();
  for (const input of ['', JSON.stringify({ cookie: 'bad\r\nInjected: secret' }), JSON.stringify({ cookie, token: 'synthetic-private' }), 'x'.repeat(8193)]) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/bootstrap-public-catalog.ts', ...apply], { encoding: 'utf8', input, timeout: 5000 });
    assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).code, 'bootstrap_session_required'); assert.doesNotMatch(run.stdout + run.stderr, /synthetic-private|Injected/);
  }
});
test('explicit repeat keeps operation identity, without claiming client tests prove SQL deduplication', async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture();
  await bootstrapPublicCatalog(apply, f.ports); await bootstrapPublicCatalog(apply, f.ports);
  assert.deepEqual(f.calls.filter(call => call.init.method === 'POST').map(call => call.init.headers['Idempotency-Key']), [operationId, operationId]);
});
for (const response of [{ receipt: { ...receipt(), restaurantId: operationId } }, { receipt: { ...receipt(), token: cookie } }, { receipt: { ...receipt(), operationId: restaurantId } }, { id: restaurantId }]) {
  test('rejects foreign, private or legacy response without exposing it', async () => {
    const { bootstrapPublicCatalog } = await feature(); const f = fixture({ response }); const result = await bootstrapPublicCatalog(apply, f.ports);
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  });
}
test('lost POST response preserves the key for manual investigation, never automatic replay', async () => {
  const { bootstrapPublicCatalog } = await feature(); const f = fixture({ lostPost: true }); const result = await bootstrapPublicCatalog(apply, f.ports);
  assert.equal(result.code, 'bootstrap_confirmation_pending'); assert.equal(result.operationId, operationId); assert.equal(f.calls.length, 2); assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
});
test('missing or header-injecting credentials stop before any request', async () => {
  const { bootstrapPublicCatalog } = await feature();
  for (const value of ['', 'cookie\r\nInjected: secret']) {
    const f = fixture(); f.ports.readSession = async () => value;
    assert.equal((await bootstrapPublicCatalog(apply, f.ports)).ok, false); assert.equal(f.calls.length, 0);
  }
});
test('real CLI dry-run reads no stdin; invalid credential arguments are never echoed', async () => {
  await feature();
  const good = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/bootstrap-public-catalog.ts', ...dry], { encoding: 'utf8', input: cookie, timeout: 5000 });
  assert.equal(good.status, 0); assert.equal(JSON.parse(good.stdout).mode, 'dry-run'); assert.doesNotMatch(good.stdout + good.stderr, /synthetic-private/);
  const bad = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/bootstrap-public-catalog.ts', ...dry, '--cookie', cookie], { encoding: 'utf8', timeout: 5000 });
  assert.equal(bad.status, 1); assert.doesNotMatch(bad.stdout + bad.stderr, /synthetic-private/);
});
