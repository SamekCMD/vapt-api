// Operator-only production smoke. Never imported by the deployed Worker.
import { setTimeout as wait } from 'node:timers/promises';
import WebSocket from 'ws';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const require = condition => { if (!condition) throw new Error('Production smoke assertion failed'); };
export function validateProductionInput(input) {
  require(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).sort().join(',') === 'baseUrl,origin' &&
    input.baseUrl === 'https://api.vapt.app.br' && input.origin === 'https://vapt.app.br');
}
export function createProductionClient(input, fetcher = fetch) {
  validateProductionInput(input);
  return async (path, { method = 'GET', body, cookie = '', headers = {} } = {}, statuses = [200]) => {
    require(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[?#\\\r\n]/.test(path) &&
      ['GET', 'POST', 'PATCH'].includes(method) && typeof cookie === 'string' && cookie.length <= 8192 && !/[\r\n\x00]/.test(cookie) &&
      Object.keys(headers).every(key => ['x-vapt-order-token', 'idempotency-key', 'x-captcha-response'].includes(key.toLowerCase())));
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Origin', input.origin);
    if (cookie) requestHeaders.set('Cookie', cookie);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    const response = await fetcher(input.baseUrl + path, { method, headers: requestHeaders, redirect: 'manual', credentials: 'omit',
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!statuses.includes(response.status)) { await response.body?.cancel(); require(false); }
    let json = null;
    if (response.headers.get('content-type')?.includes('application/json')) json = await response.json();
    else await response.body?.cancel();
    return { response, json };
  };
}
export function readProductionSessionCookie(headers) {
  const cookies = headers.getSetCookie();
  const sessions = cookies.filter(value => value.startsWith('__Secure-better-auth.session_token='));
  require(sessions.length === 1 && /^__Secure-better-auth\.session_token=[^;\s]+;/.test(sessions[0]) &&
    /;\s*Secure(?:;|$)/i.test(sessions[0]) && /;\s*HttpOnly(?:;|$)/i.test(sessions[0]) && /;\s*SameSite=Lax(?:;|$)/i.test(sessions[0]));
  return cookies.map(value => value.split(';')[0]).filter(value => /^(?:__Secure-)?better-auth\./.test(value)).join('; ');
}
function socketUrl(input, restaurantId) {
  validateProductionInput(input); require(uuid.test(restaurantId));
  return `wss://api.vapt.app.br/v1/realtime/restaurants/${restaurantId}/socket`;
}
const socketOptions = input => ({ headers: { Origin: input.origin }, handshakeTimeout: 10000, maxPayload: 4096, closeTimeout: 1000 });
export async function openProductionSocket(input, ticket, { Socket = WebSocket } = {}) {
  const url = socketUrl(input, ticket?.restaurantId);
  const now = Date.now();
  const match = typeof ticket?.ticket === 'string' ? ticket.ticket.match(/^rt1\.[A-Za-z0-9_-]{43}\.([1-9][0-9]{0,15})\.[A-Za-z0-9_-]{43}$/) : null;
  if (!(match && Number(match[1]) === ticket.expiresAt && Number.isSafeInteger(ticket.expiresAt) && ticket.expiresAt > now && ticket.expiresAt <= now + 30000)) {
    throw Object.assign(new Error('Production socket admission failed'), { diagnostic: { kind: 'ticket' } });
  }
  const socket = new Socket(url, ['vapt.realtime.v1', 'vapt.ticket.' + ticket.ticket], socketOptions(input));
  const frames = []; let ready = false, upgraded = false, fault = false, closedCode = null, diagnostic = { kind: 'timeout' };
  socket.on('upgrade', response => { upgraded = response.statusCode === 101 && response.headers['sec-websocket-protocol'] === 'vapt.realtime.v1';
    if (!upgraded) { fault = true; diagnostic = { kind: 'protocol' }; } });
  socket.on('error', () => { fault = true; if (diagnostic.kind === 'timeout') diagnostic = { kind: 'network' }; });
  socket.on('unexpected-response', (_request, response) => { fault = true;
    diagnostic = Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599 ? { kind: 'http', status: response.statusCode } : { kind: 'network' };
    response.resume(); socket.terminate(); });
  socket.on('close', code => { closedCode = code; });
  socket.on('message', data => {
    try {
      require(data.byteLength <= 4096); const frame = JSON.parse(data.toString());
      if (frame.type === 'ready') {
        require(!ready && Object.keys(frame).sort().join(',') === 'leaseExpiresAt,type,version' && frame.version === 1 &&
          Number.isSafeInteger(frame.leaseExpiresAt) && frame.leaseExpiresAt > Date.now() && frame.leaseExpiresAt <= Date.now() + 300000);
        ready = true;
      } else {
        require(ready && Object.keys(frame).sort().join(',') === 'entityId,eventId,reason,sequence,topic,version' && frame.version === 1 &&
          uuid.test(frame.eventId) && uuid.test(frame.entityId) && Number.isSafeInteger(frame.sequence) && frame.sequence > 0 &&
          ['orders', 'kitchen', 'table_sessions', 'payments'].includes(frame.topic) &&
          ['created', 'updated', 'cancelled', 'payment_changed', 'check_requested', 'closed', 'transferred'].includes(frame.reason) && frames.length < 128);
        frames.push(frame); socket.send(JSON.stringify({ version: 1, type: 'ack', sequence: frame.sequence }));
      }
    } catch { fault = true; diagnostic = { kind: 'frame' }; socket.terminate(); }
  });
  const waitFor = async predicate => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { require(!fault && closedCode === null && Date.now() < deadline); await wait(25); }
    require(!fault);
  };
  const connection = { socket, frames, waitFor, closedCode: () => closedCode, async close() {
    if (socket.readyState === 3) return;
    socket.close(1000); const deadline = Date.now() + 2000;
    while (closedCode === null && Date.now() < deadline) await wait(25);
    if (closedCode === null) socket.terminate();
  } };
  try { await waitFor(() => ready && upgraded); return connection; }
  catch { await connection.close(); throw Object.assign(new Error('Production socket admission failed'), { diagnostic }); }
}
export async function rejectProductionSocket(input, restaurantId, protocols, { Socket = WebSocket } = {}) {
  const url = socketUrl(input, restaurantId);
  require(Array.isArray(protocols) && protocols.length >= 1 && protocols.length <= 2 && protocols.join(', ').length <= 192 &&
    protocols.every(value => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value)));
  return new Promise(resolve => {
    let socket, settled = false;
    const done = value => { if (settled) return; settled = true; clearTimeout(timeout); socket?.terminate(); resolve(value); };
    const timeout = setTimeout(() => done(false), 12000);
    try {
      socket = new Socket(url, protocols, socketOptions(input));
      socket.on('unexpected-response', (_request, response) => { response.resume(); done(response.statusCode === 403); });
      socket.on('upgrade', () => done(false)); socket.on('error', () => done(false)); socket.on('close', () => done(false));
    } catch { done(false); }
  });
}

export async function runRealtimeProduction(input, { fetcher = fetch, connect = openProductionSocket,
  rejectSocket = rejectProductionSocket, fixtures, captchaProvider, quietWait = wait } = {}) {
  validateProductionInput(input);
  require(typeof fixtures?.seed === 'function' && typeof fixtures.cleanup === 'function' && typeof captchaProvider === 'function');
  const api = createProductionClient(input, fetcher), sockets = [];
  const summary = { ok: false, cleaned: false, checks: { auth: false, admission: false, proof: false, tenantIsolation: false,
    publicIsolation: false, kitchen: false, cashier: false, reconnect: false, revocation: false },
  counts: { tenants: 0, orders: 0, connections: 0 }, failure: null };
  let phase = 'challenge', owners = [], challenge = '';
  async function captcha(label) {
    const value = await captchaProvider(label);
    require(typeof value === 'string' && value.length >= 20 && value.length <= 2048 && !/[\s\x00-\x1f\x7f]/.test(value) && !/DUMMY/i.test(value));
    return value;
  }
  async function login(owner, value) {
    const result = await api('/api/auth/sign-in/email', { method: 'POST', body: { email: owner.email, password: owner.password },
      headers: { 'X-Captcha-Response': value } });
    require(result.json?.user?.id === owner.userId);
    const cookie = readProductionSessionCookie(result.response.headers);
    require((await api('/auth/me', { cookie })).json?.userId === owner.userId);
    return cookie;
  }
  async function ticket(body, cookie = '', token = null, statuses = [200]) {
    return (await api('/v1/realtime/tickets', { method: 'POST', body, cookie, headers: token ? { 'X-Vapt-Order-Token': token } : {} }, statuses)).json;
  }
  async function open(body, cookie = '', token = null) {
    const connection = await connect(input, await ticket(body, cookie, token));
    sockets.push(connection); summary.counts.connections++; return connection;
  }
  try {
    // Do not leave fixtures waiting for the first human challenge.
    challenge = await captcha('owner-1');
    phase = 'fixtures'; const seeded = await fixtures.seed();
    require(Array.isArray(seeded) && seeded.length === 2 && seeded.every(v => v && uuid.test(v.userId) && uuid.test(v.restaurantId) && uuid.test(v.itemId)) &&
      seeded[0].restaurantId !== seeded[1].restaurantId && seeded[0].userId !== seeded[1].userId);
    owners = seeded;
    summary.counts.tenants = 2;
    phase = 'auth'; owners[0].cookie = await login(owners[0], challenge); challenge = '';
    phase = 'challenge'; challenge = await captcha('owner-2');
    phase = 'auth'; owners[1].cookie = await login(owners[1], challenge); challenge = '';
    summary.checks.auth = true;
    phase = 'admission';
    await ticket({ mode: 'owner', restaurantId: owners[0].restaurantId }, '', null, [401]);
    await ticket({ mode: 'owner', restaurantId: owners[1].restaurantId }, owners[0].cookie, null, [403]);
    const admission = await ticket({ mode: 'owner', restaurantId: owners[0].restaurantId }, owners[0].cookie);
    phase = 'proof-forged';
    const forged = `rt1.${'x'.repeat(43)}.${admission.expiresAt}.${'y'.repeat(43)}`;
    require(await rejectSocket(input, owners[0].restaurantId, ['vapt.realtime.v1', 'vapt.ticket.' + forged]));
    phase = 'proof-transplant';
    require(await rejectSocket(input, owners[1].restaurantId, ['vapt.realtime.v1', 'vapt.ticket.' + admission.ticket]));
    phase = 'admission-socket';
    owners[0].connection = await connect(input, admission); sockets.push(owners[0].connection); summary.counts.connections++;
    phase = 'proof-replay';
    require(await rejectSocket(input, owners[0].restaurantId, ['vapt.realtime.v1', 'vapt.ticket.' + admission.ticket]));
    phase = 'admission-socket';
    owners[1].connection = await open({ mode: 'owner', restaurantId: owners[1].restaurantId }, owners[1].cookie);
    summary.checks.proof = true; summary.checks.admission = true;
    phase = 'orders';
    for (const owner of owners) {
      owner.orders = [];
      for (let index = 0; index < 2; index++) {
        const result = await api('/public/orders', { method: 'POST', body: { restaurantSlug: owner.slug, channel: 'local', tableNumber: 1,
          items: [{ menuItemId: owner.itemId, quantity: 1 }] }, headers: { 'Idempotency-Key': owner.tag + '-' + owner.restaurantId + '-' + index } }, [201]);
        require(uuid.test(result.json?.orderId) && typeof result.json.publicToken === 'string');
        owner.orders.push(result.json); summary.counts.orders++;
        await owner.connection.waitFor(() => owner.connection.frames.some(f => f.entityId === result.json.orderId && f.topic === 'orders'));
      }
    }
    require(summary.counts.orders === 4);
    for (const owner of owners) require(!owner.connection.frames.some(f => owners.find(v => v !== owner).orders.some(o => o.orderId === f.entityId)));
    summary.checks.tenantIsolation = true;
    phase = 'public';
    for (const owner of owners) {
      const order = owner.orders[0];
      await ticket({ mode: 'order', orderId: order.orderId }, '', 'x'.repeat(43), [404]);
      owner.publicConnection = await open({ mode: 'order', orderId: order.orderId }, '', order.publicToken);
    }
    phase = 'kitchen';
    for (const owner of owners) {
      const order = owner.orders[0];
      require((await api(`/restaurants/me/kitchen/orders/${order.orderId}/status`, { method: 'PATCH', body: { status: 'preparing' }, cookie: owner.cookie })).json?.status === 'preparing');
      await owner.connection.waitFor(() => owner.connection.frames.some(f => f.entityId === order.orderId && f.topic === 'kitchen' && f.reason === 'updated'));
      await owner.publicConnection.waitFor(() => owner.publicConnection.frames.length > 0);
      require((await api('/public/orders/' + order.orderId, { headers: { 'X-Vapt-Order-Token': order.publicToken } })).json?.status === 'preparing');
      const snapshot = (await api('/restaurants/me/kitchen/orders', { cookie: owner.cookie })).json;
      require(snapshot.some(v => v.id === order.orderId && v.status === 'preparing') && snapshot.length === 2);
    }
    summary.checks.kitchen = true;
    phase = 'public-isolation';
    const before = owners.map(v => v.publicConnection.frames.length);
    for (const owner of owners) await api(`/restaurants/me/kitchen/orders/${owner.orders[1].orderId}/status`, { method: 'PATCH', body: { status: 'preparing' }, cookie: owner.cookie });
    await quietWait(750);
    owners.forEach((owner, index) => {
      require(owner.publicConnection.frames.length === before[index] && owner.publicConnection.frames.length > 0);
      require(owner.publicConnection.frames.every(f => f.topic === 'orders' && f.entityId === owner.orders[0].orderId));
      require(owner.publicConnection.frames[0].sequence === 1);
    });
    summary.checks.publicIsolation = true;
    phase = 'cashier';
    for (const owner of owners) {
      const sessions = (await api('/restaurants/me/table-sessions', { cookie: owner.cookie })).json;
      require(sessions.length === 1 && sessions[0].orderCount === 2 && uuid.test(sessions[0].id));
      const start = owner.connection.frames.length;
      await api('/public/table-sessions/' + sessions[0].id + '/request-check', { method: 'POST',
        body: { publicOrderId: owner.orders[0].orderId, publicOrderToken: owner.orders[0].publicToken } });
      await owner.connection.waitFor(() => owner.connection.frames.slice(start).some(f => f.topic === 'table_sessions' && f.reason === 'check_requested'));
      require((await api('/restaurants/me/table-sessions', { cookie: owner.cookie })).json[0].status === 'check_requested');
    }
    summary.checks.cashier = true;
    phase = 'reconnect'; await owners[0].connection.close();
    owners[0].connection = await open({ mode: 'owner', restaurantId: owners[0].restaurantId }, owners[0].cookie);
    require((await api('/restaurants/me/kitchen/orders', { cookie: owners[0].cookie })).json.length === 2);
    summary.checks.reconnect = true;
    phase = 'challenge'; challenge = await captcha('relogin');
    phase = 'revocation';
    // Renew only after the human returns, so lease expiry cannot masquerade as revocation.
    await owners[0].connection.close();
    owners[0].connection = await open({ mode: 'owner', restaurantId: owners[0].restaurantId }, owners[0].cookie);
    const oldConnection = owners[0].connection, framesBefore = oldConnection.frames.length;
    await api('/api/auth/sign-out', { method: 'POST', body: {}, cookie: owners[0].cookie });
    await ticket({ mode: 'owner', restaurantId: owners[0].restaurantId }, owners[0].cookie, null, [401]);
    owners[0].cookie = await login(owners[0], challenge); challenge = '';
    await api(`/restaurants/me/kitchen/orders/${owners[0].orders[0].orderId}/status`, { method: 'PATCH', body: { status: 'ready' }, cookie: owners[0].cookie });
    await oldConnection.waitFor(() => oldConnection.closedCode() !== null);
    require(oldConnection.closedCode() === 1008 && oldConnection.frames.length === framesBefore);
    summary.checks.revocation = true; summary.ok = true;
  } catch (error) {
    summary.failure = phase;
    const detail = error?.diagnostic;
    if (phase === 'admission-socket' && ['http','network','timeout','protocol','frame','ticket'].includes(detail?.kind)) {
      summary.diagnostic = { kind: detail.kind };
      if (detail.kind === 'http' && Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599) summary.diagnostic.status = detail.status;
    }
  }
  finally {
    challenge = '';
    for (const connection of sockets) { try { await connection.close(); } catch { summary.ok = false; summary.failure = 'socket-cleanup'; } }
    try { const result = await fixtures.cleanup(); summary.cleaned = result?.rows === 0 && result.tablesChecked === 12; } catch { summary.cleaned = false; }
    if (!summary.cleaned) { summary.ok = false; summary.failure = 'cleanup'; }
    for (const owner of owners) { owner.cookie = ''; owner.password = ''; for (const order of owner.orders ?? []) order.publicToken = ''; }
  }
  return summary;
}
