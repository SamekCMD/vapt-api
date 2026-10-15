import assert from 'node:assert/strict';
import test from 'node:test';
import { compareParallelApi, validateReadOnlyMatrix } from './compare-parallel-api.mjs';

const input = {
  coolifyBaseUrl: 'https://api.vapt.app.br',
  previewBaseUrl: 'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev',
  previewHeaders: { 'Cf-Access-Token': 'access-value-must-stay-private', Authorization: 'Bearer private-preview-bearer-value' },
};
const origin = 'https://infra-foundation-vapt-web.autoistloko.workers.dev';
function response(path, side = 'same') {
  const health = path === '/health';
  return Response.json(health ? { status: 'ok', timestamp: side, requestId: side }
    : { error: { code: 'unauthorized', message: side, requestId: side } }, {
    status: health ? 200 : 401,
    headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'set-cookie': 'private-session-value' },
  });
}

test('compares fixed GET contracts without copying Preview credentials to Coolify', async () => {
  const seen = [];
  const results = await compareParallelApi({ ...input, fetcher: async (url, options) => {
    seen.push({ url, options });
    return response(new URL(url).pathname);
  } });
  assert.equal(results.length, 5);
  assert.deepEqual(results.map(x => x.outcome), ['match', 'match', 'match', 'match', 'match']);
  assert.deepEqual(results.map(x => x.path), ['/health', '/auth/me', '/restaurants/me', '/public/restaurants/__stage11_missing__/catalog', '/__stage11_missing__/%not-hex']);
  for (const { url, options } of seen) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    if (url.startsWith(input.coolifyBaseUrl)) {
      assert.equal(new Headers(options.headers).has('authorization'), false);
      assert.equal(new Headers(options.headers).has('cf-access-token'), false);
      assert.equal(new Headers(options.headers).has('cookie'), false);
    }
  }
  const printed = JSON.stringify(results);
  for (const value of ['access-value-must-stay-private', 'private-preview-bearer-value', 'private-session-value']) assert.equal(printed.includes(value), false);
});

test('ignores volatile IDs and body text but retains safe HTTP and error differences', async () => {
  const matching = await compareParallelApi({ ...input, fetcher: async url => response(new URL(url).pathname, url.startsWith(input.coolifyBaseUrl) ? 'old-id' : 'new-id') });
  assert.equal(matching.every(x => x.outcome === 'match'), true);
  const changed = await compareParallelApi({ ...input, fetcher: async url => url.startsWith(input.previewBaseUrl)
    ? Response.json({ error: { code: 'not_found', message: 'secret body value', token: 'private-token' } }, { status: 404 })
    : response(new URL(url).pathname) });
  assert.equal(changed[1].outcome, 'different');
  assert.ok(changed[1].differences.includes('status'));
  assert.ok(changed[1].differences.includes('errorCode'));
  assert.ok(changed[1].differences.includes('allowedOrigin'));
  assert.ok(changed[1].differences.includes('allowCredentials'));
  assert.equal(JSON.stringify(changed).includes('secret body value'), false);
  assert.equal(JSON.stringify(changed).includes('private-token'), false);
});

test('reports Access redirection instead of treating login HTML as API parity', async () => {
  const results = await compareParallelApi({ ...input, fetcher: async url => url.startsWith(input.previewBaseUrl)
    ? new Response('private login HTML', { status: 302, headers: { location: 'https://shy-mouse-d86f.cloudflareaccess.com/cdn-cgi/access/login?token=private-query' } })
    : response(new URL(url).pathname) });
  assert.equal(results.every(x => x.outcome === 'access_denied'), true);
  assert.equal(JSON.stringify(results).includes('private'), false);
});

test('rejects mutations, bodies, unapproved paths, hosts and session cookies before fetching', async () => {
  for (const entry of [
    { method: 'POST', path: '/health' },
    { method: 'GET', path: '/health', body: '{}' },
    { method: 'GET', path: '/billing/checkout' },
  ]) assert.throws(() => validateReadOnlyMatrix([entry]), /Invalid read-only matrix/);
  let calls = 0;
  for (const change of [
    { coolifyBaseUrl: 'https://other.example' },
    { previewBaseUrl: 'https://api.vapt.app.br' },
    { previewHeaders: { ...input.previewHeaders, Cookie: 'session=private' } },
    { previewHeaders: { Authorization: input.previewHeaders.Authorization } },
  ]) await assert.rejects(compareParallelApi({ ...input, ...change, fetcher: async () => { calls++; return response('/health'); } }), /Invalid comparison input/);
  assert.equal(calls, 0);
});

test('records unavailable transport without emitting connection errors or credential strings', async () => {
  const results = await compareParallelApi({ ...input, fetcher: async url => {
    if (url.startsWith(input.coolifyBaseUrl)) throw new Error('secret connection URI');
    return response(new URL(url).pathname);
  } });
  assert.equal(results.every(x => x.outcome === 'unavailable'), true);
  assert.equal(results[0].coolify.status, null);
  assert.equal(results[0].preview.status, 200);
  assert.equal(JSON.stringify(results).includes('secret connection URI'), false);
});
