import test from 'node:test';
import assert from 'node:assert/strict';

const input = { baseUrl: 'https://api.vapt.app.br', origin: 'https://vapt.app.br' };
async function runner() {
  const module = await import('./verify-realtime-production.mjs');
  assert.equal(typeof module.runRealtimeProduction, 'function', 'production runner must exist');
  return module.runRealtimeProduction;
}
test('runner refuses non-production target before fixture or challenge IO', async () => {
  const run = await runner(); let io = 0;
  await assert.rejects(run({ ...input, origin: 'https://preview.example.invalid' }, {
    fixtures: { seed() { io++; }, cleanup() { io++; } }, captchaProvider() { io++; },
  }));
  assert.equal(io, 0);
});
test('runner refuses dummy challenges before seed and never reflects external errors', async () => {
  const run = await runner();
  for (const challenge of ['XXXX.DUMMY.TOKEN.XXXX', 'short', 'a'.repeat(2049), 'a'.repeat(20) + '\n']) {
    let seeded = 0, requests = 0, cleaned = 0;
    const result = await run(input, { captchaProvider: async () => challenge,
      fetcher: async () => { requests++; throw Error('synthetic-secret'); },
      fixtures: { async seed() { seeded++; }, async cleanup() { cleaned++; return { rows: 0, tablesChecked: 12 }; } } });
    assert.equal(result.ok, false); assert.equal(result.failure, 'challenge');
    assert.equal(seeded, 0); assert.equal(requests, 0); assert.equal(cleaned, 1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic|DUMMY|secret|https:/);
  }
});
test('partial fixture failure still cleans, while residual rows cannot produce success', async () => {
  const run = await runner();
  for (const rows of [0, 1]) {
    let cleanup = 0;
    const result = await run(input, { captchaProvider: async () => 'synthetic-challenge-valid-00000001',
      fixtures: { async seed() { throw Error('synthetic-password db-url'); }, async cleanup() { cleanup++; return { rows, tablesChecked: 12 }; } } });
    assert.equal(cleanup, 1); assert.equal(result.ok, false); assert.equal(result.cleaned, rows === 0);
    assert.equal(result.failure, rows === 0 ? 'fixtures' : 'cleanup');
    assert.doesNotMatch(JSON.stringify(result), /synthetic|password|db-url/);
  }
});
test('malformed fixture results cannot skip cleanup or leak an unhandled exception', async () => {
  const run = await runner();
  for (const value of [null,undefined,{},[{userId:'wrong'}]]) {
    let cleanup=0;
    const result=await run(input,{captchaProvider:async()=>'synthetic-challenge-valid-00000001',
      fixtures:{async seed(){return value;},async cleanup(){cleanup++;return {rows:0,tablesChecked:12};}}});
    assert.equal(result.ok,false);assert.equal(result.failure,'fixtures');assert.equal(result.cleaned,true);assert.equal(cleanup,1);
  }
});
test('two-tenant operator requires signed admission, filtering, snapshot and freshly renewed revocation socket', async () => {
  const run = await runner();
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const owners = [0, 1].map(n => ({ userId: id(n+1), restaurantId: id(n+3), itemId: id(n+5),
    slug: 'synthetic-tenant-'+n, email: 'synthetic-'+n+'@example.invalid', password: 'synthetic-password',
    tag: 'synthetic-tag', orders: [], sessionId: id(n+7), status: 'open' }));
  const sessions = new Map(), tickets = new Map(), connections = [], challenges = [];
  let logins = 0, orderNumber = 10, cleaned = false, afterThirdChallenge = false, freshRevocation = false;
  function publish(owner, orderId, reason, topics) {
    for (const c of connections.filter(c => c.owner === owner && c.code === null)) {
      if (c.cookie && !sessions.has(c.cookie)) { c.code = 1008; continue; }
      if (c.orderId && c.orderId !== orderId) continue;
      for (const topic of c.orderId ? ['orders'] : topics) c.frames.push({ version: 1, eventId: id(100+c.frames.length),
        sequence: c.frames.length+1, entityId: c.orderId ?? orderId, reason, topic });
    }
  }
  const captchaProvider = async phase => {
    challenges.push(phase);
    if (challenges.length === 3) {
      // Human delay can expire every existing lease. It must not count as revocation evidence.
      connections.forEach(c => { if (c.code === null) c.code = 1008; }); afterThirdChallenge = true;
    }
    return 'synthetic-challenge-valid-0000000'+challenges.length;
  };
  const fetcher = async (url, options) => {
    assert.equal(new URL(url).origin, input.baseUrl); assert.equal(options.headers.get('Origin'), input.origin);
    assert.equal(options.headers.has('Authorization'), false); assert.equal(options.headers.has('Cf-Access-Token'), false);
    assert.equal(options.redirect, 'manual');
    const path = new URL(url).pathname, h = options.headers, body = options.body ? JSON.parse(options.body) : null;
    const cookie = h.get('Cookie'), owner = sessions.get(cookie), json = (v, status=200, headers={}) => Response.json(v, {status, headers});
    if (path === '/api/auth/sign-in/email') {
      assert.equal(h.get('X-Captcha-Response'), 'synthetic-challenge-valid-0000000'+(logins+1));
      const user = owners.find(o => o.email === body.email && o.password === body.password); assert.ok(user); logins++;
      const value = '__Secure-better-auth.session_token=synthetic-cookie-'+logins; sessions.set(value, user);
      return json({ user: { id: user.userId } }, 200, { 'Set-Cookie': value+'; Path=/; Secure; HttpOnly; SameSite=Lax' });
    }
    if (path === '/auth/me') { assert.ok(owner); return json({ userId: owner.userId }); }
    if (path === '/api/auth/sign-out') {
      assert.ok(freshRevocation, 'renew old-session socket after third human challenge and before logout');
      sessions.delete(cookie); return json({success:true});
    }
    if (path === '/v1/realtime/tickets') {
      let grant;
      if (body.mode === 'owner') {
        if (!owner) return json({}, 401);
        if (owner.restaurantId !== body.restaurantId) return json({}, 403);
        grant = { owner, cookie };
      } else {
        const tenant = owners.find(o => o.orders.some(v => v.orderId === body.orderId));
        const order = tenant?.orders.find(o => o.orderId === body.orderId);
        if (!order || h.get('X-Vapt-Order-Token') !== order.publicToken) return json({}, 404);
        grant = { owner: tenant, orderId: order.orderId };
      }
      const expiresAt = Date.now()+30000, token = `rt1.${'t'.repeat(42)+tickets.size}.${expiresAt}.${'b'.repeat(43)}`;
      tickets.set(token, { ...grant, used: false }); return json({ restaurantId: grant.owner.restaurantId, ticket: token, expiresAt });
    }
    if (path === '/public/orders') {
      const tenant = owners.find(o => o.slug === body.restaurantSlug); assert.ok(tenant);
      assert.equal(body.items[0].menuItemId, tenant.itemId); assert.ok(h.get('Idempotency-Key'));
      const order = { orderId: id(orderNumber++), publicToken: 'synthetic-order-token-'+orderNumber, status: 'pending' };
      tenant.orders.push(order); publish(tenant, order.orderId, 'created', ['orders','kitchen','table_sessions']); return json(order, 201);
    }
    if (path.startsWith('/public/orders/')) {
      const order = owners.flatMap(o => o.orders).find(o => o.orderId === path.split('/').at(-1));
      assert.equal(h.get('X-Vapt-Order-Token'), order.publicToken); return json(order);
    }
    if (path.endsWith('/status')) {
      assert.ok(owner); const order = owner.orders.find(o => o.orderId === path.split('/').at(-2)); assert.ok(order);
      order.status = body.status; publish(owner, order.orderId, 'updated', ['orders','kitchen','table_sessions']); return json({status:order.status});
    }
    if (path === '/restaurants/me/kitchen/orders') return json(owner.orders.map(o => ({id:o.orderId,status:o.status})));
    if (path === '/restaurants/me/table-sessions') return json([{id:owner.sessionId,orderCount:2,status:owner.status}]);
    if (path.endsWith('/request-check')) {
      const tenant = owners.find(o => o.sessionId === path.split('/').at(-2));
      assert.equal(body.publicOrderToken, tenant.orders[0].publicToken); tenant.status = 'check_requested';
      publish(tenant, body.publicOrderId, 'check_requested', ['orders','table_sessions']); return json({status:tenant.status});
    }
    throw Error('Unhandled synthetic request');
  };
  const connect = async (_input, ticket) => {
    const grant = tickets.get(ticket.ticket); assert.ok(grant && !grant.used); grant.used = true;
    assert.equal(ticket.restaurantId, grant.owner.restaurantId);
    if (afterThirdChallenge) { assert.ok(sessions.has(grant.cookie)); freshRevocation = true; }
    const c = { ...grant, frames: [], code: null, closedCode() { return this.code; },
      async waitFor(fn) { assert.equal(fn(), true); }, async close() { if (this.code === null) this.code = 1000; } };
    connections.push(c); return c;
  };
  const rejections = [];
  const rejectSocket = async (_input, restaurantId, protocols) => {
    const token = protocols[1]?.slice('vapt.ticket.'.length), grant = tickets.get(token);
    assert.match(token, /^rt1\.[A-Za-z0-9_-]{43}\.[0-9]+\.[A-Za-z0-9_-]{43}$/, 'forged probe must test MAC admission, not only malformed syntax');
    const rejected = !grant || grant.used || grant.owner.restaurantId !== restaurantId;
    rejections.push(rejected); return rejected;
  };
  const fixtures = { async seed() { assert.equal(challenges.length, 1); return owners.map(o => ({...o})); },
    async cleanup() { cleaned = true; return {rows:0,tablesChecked:12}; } };
  const result = await run(input, { fixtures, fetcher, connect, rejectSocket, captchaProvider, quietWait: async () => {} });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.cleaned, true); assert.equal(cleaned, true);
  assert.deepEqual(result.counts, {tenants:2,orders:4,connections:6});
  assert.equal(owners.flatMap(o=>o.orders).length, 4);
  assert.deepEqual(rejections, [true,true,true]); assert.equal(logins, 3); assert.equal(challenges.length, 3);
  assert.equal(connections.every(c => c.code !== null), true); assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic|cookie|password|https:/);
});
