import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const target = () => ({ baseUrl: 'https://api.vapt.app.br', origin: 'https://vapt.app.br' });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function feature(name) {
  const module = await import('./verify-realtime-production.mjs').catch(() => null);
  assert.equal(typeof module?.[name], 'function', `${name} production operator not implemented`);
  return module[name];
}

test('production input rejects preview, URL authority and unexpected credentials before IO', async () => {
  const validate = await feature('validateProductionInput');
  assert.doesNotThrow(() => validate(target()));
  for (const changes of [{ baseUrl: 'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev' },
    { baseUrl: 'https://api.vapt.app.br/' }, { baseUrl: 'https://api.vapt.app.br?token=synthetic' },
    { baseUrl: 'http://api.vapt.app.br' }, { baseUrl: 'https://user:synthetic@api.vapt.app.br' },
    { origin: 'https://vapt.app.br/' }, { origin: 'https://other.example' }, { bearer: 'synthetic-secret' }]) {
    assert.throws(() => validate({ ...target(), ...changes }), error => !String(error).includes('synthetic'));
  }
});

test('HTTP operator sends exact production origin and refuses path/header authority injection', async () => {
  const create = await feature('createProductionClient'), requests = [];
  const api = create(target(), async (url, options) => { requests.push({ url, options }); return Response.json({ status: 'ok' }); });
  await api('/v1/realtime/tickets', { method: 'POST', body: { mode: 'owner', restaurantId: id(1) }, cookie: '__Secure-better-auth.session_token=synthetic' });
  assert.equal(requests[0].url, 'https://api.vapt.app.br/v1/realtime/tickets');
  assert.equal(requests[0].options.redirect, 'manual'); assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.headers.get('Origin'), 'https://vapt.app.br');
  assert.equal(requests[0].options.headers.get('Authorization'), null);
  assert.equal(requests[0].options.headers.get('Cf-Access-Token'), null);
  assert.equal(requests[0].options.headers.get('Cookie'), '__Secure-better-auth.session_token=synthetic');
  for (const [path, options] of [['//other.example', {}], ['/health?token=synthetic', {}], ['https://other.example', {}],
    ['/health', { headers: { Authorization: 'synthetic' } }], ['/health', { headers: { Origin: 'https://other.example' } }],
    ['/health', { cookie: 'synthetic\r\nInjected: true' }], ['/health', { method: 'DELETE' }]]) {
    await assert.rejects(api(path, options), error => !String(error).includes('synthetic'));
  }
  assert.equal(requests.length, 1);
});

test('login cookie extraction requires Secure HttpOnly Lax session instead of accepting insecure auth', async () => {
  const read = await feature('readProductionSessionCookie');
  const good = '__Secure-better-auth.session_token=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax';
  assert.equal(read(new Headers({ 'Set-Cookie': good })), '__Secure-better-auth.session_token=synthetic');
  for (const value of [good.replace('; Secure', ''), good.replace('; HttpOnly', ''), good.replace('SameSite=Lax', 'SameSite=None'),
    'better-auth.session_token=synthetic; Secure; HttpOnly; SameSite=Lax']) {
    assert.throws(() => read(new Headers({ 'Set-Cookie': value })), error => !String(error).includes('synthetic'));
  }
});

test('production socket uses only signed subprotocol and validates ready/envelope while auto-acking', async () => {
  const open = await feature('openProductionSocket');
  const expiresAt = Date.now() + 30000, ticket = `rt1.${'a'.repeat(43)}.${expiresAt}.${'b'.repeat(43)}`;
  class Socket extends EventEmitter {
    readyState = 1; sent = [];
    constructor(url, protocols, options) {
      super(); assert.equal(url, `wss://api.vapt.app.br/v1/realtime/restaurants/${id(1)}/socket`);
      assert.deepEqual(protocols, ['vapt.realtime.v1', 'vapt.ticket.' + ticket]);
      assert.deepEqual(options.headers, { Origin: 'https://vapt.app.br' });
      queueMicrotask(() => { this.emit('upgrade', { statusCode: 101, headers: { 'sec-websocket-protocol': 'vapt.realtime.v1' } });
        this.emit('message', Buffer.from(JSON.stringify({ version: 1, type: 'ready', leaseExpiresAt: Date.now() + 300000 }))); });
    }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.emit('close', 1000); }
    terminate() { this.close(); }
  }
  const connection = await open(target(), { restaurantId: id(1), ticket, expiresAt }, { Socket });
  connection.socket.emit('message', Buffer.from(JSON.stringify({ version: 1, eventId: id(2), entityId: id(3), sequence: 1, topic: 'orders', reason: 'created' })));
  assert.deepEqual(JSON.parse(connection.socket.sent[0]), { version: 1, type: 'ack', sequence: 1 });
  assert.equal(connection.frames.length, 1);
  connection.socket.emit('message', Buffer.from(JSON.stringify({ version: 1, eventId: id(2), entityId: id(3), sequence: 2, topic: 'orders', reason: 'created', secret: 'synthetic' })));
  assert.equal(connection.closedCode(), 1000); assert.equal(connection.frames.length, 1);
  await connection.close();
});

test('operator refuses unsigned, stale or mismatched expiry before constructing socket', async () => {
  const open = await feature('openProductionSocket'); let constructed = 0;
  class Socket { constructor() { constructed++; throw Error('Unexpected socket'); } }
  const expiresAt = Date.now() + 30000;
  for (const value of [{ ticket: 'a'.repeat(43), expiresAt },
    { ticket: `rt1.${'a'.repeat(43)}.${expiresAt + 1}.${'b'.repeat(43)}`, expiresAt },
    { ticket: `rt1.${'a'.repeat(43)}.${Date.now() - 1}.${'b'.repeat(43)}`, expiresAt: Date.now() - 1 }]) {
    await assert.rejects(open(target(), { restaurantId: id(1), ...value }, { Socket }));
  }
  assert.equal(constructed, 0);
});

test('negative admission probe counts only real 403 rejection, never successful upgrade or error', async () => {
  const reject = await feature('rejectProductionSocket');
  class Rejected extends EventEmitter {
    constructor(url, _protocols, options) { super(); assert.equal(new URL(url).origin, 'wss://api.vapt.app.br');
      assert.deepEqual(options.headers, { Origin: 'https://vapt.app.br' });
      queueMicrotask(() => this.emit('unexpected-response', null, { statusCode: 403, resume() {} })); }
    terminate() {}
  }
  assert.equal(await reject(target(), id(1), ['vapt.realtime.v1', 'vapt.ticket.' + 'a'.repeat(43)], { Socket: Rejected }), true);
  class Failed extends EventEmitter { constructor() { super(); queueMicrotask(() => this.emit('error', Error('synthetic-secret'))); } terminate() {} }
  assert.equal(await reject(target(), id(1), ['vapt.realtime.v1'], { Socket: Failed }), false);
  // A successful handshake emitted before a later fake rejection cannot pass the probe.
  class Success extends EventEmitter { constructor() { super(); queueMicrotask(() => this.emit('upgrade', { statusCode: 101 })); } terminate() {} }
  assert.equal(await reject(target(), id(1), ['vapt.realtime.v1'], { Socket: Success }), false);
});
test('socket failure reports only numeric handshake status without raw headers or body', async () => {
  const open=await feature('openProductionSocket'),expiresAt=Date.now()+30000;
  class Socket extends EventEmitter {
    readyState=1;
    constructor(){super();queueMicrotask(()=>this.emit('unexpected-response',null,{statusCode:403,headers:{'set-cookie':'synthetic-secret'},resume(){}}));}
    terminate(){this.readyState=3;this.emit('close',1006);}
    close(){this.terminate();}
  }
  await assert.rejects(open(target(),{restaurantId:id(1),expiresAt,ticket:`rt1.${'a'.repeat(43)}.${expiresAt}.${'b'.repeat(43)}`},{Socket}),
    error=>{assert.deepEqual(error.diagnostic,{kind:'http',status:403});assert.doesNotMatch(JSON.stringify(error),/synthetic|cookie/);return true;});
});
test('operator tolerates bounded server clock skew without accepting excessive ticket or lease lifetimes', async t => {
  const open=await feature('openProductionSocket'),now=1700000000000;
  t.mock.method(Date,'now',()=>now);
  class Socket extends EventEmitter {
    readyState=1;
    constructor(_url,_protocols){super();queueMicrotask(()=>{
      this.emit('upgrade',{statusCode:101,headers:{'sec-websocket-protocol':'vapt.realtime.v1'}});
      this.emit('message',Buffer.from(JSON.stringify({version:1,type:'ready',leaseExpiresAt:this.constructor.lease ?? now+305000})));});}
    close(){this.readyState=3;this.emit('close',1000);}terminate(){this.close();}
  }
  const expiresAt=now+35000;
  const connection=await open(target(),{restaurantId:id(1),expiresAt,ticket:`rt1.${'a'.repeat(43)}.${expiresAt}.${'b'.repeat(43)}`},{Socket});
  await connection.close();
  await assert.rejects(open(target(),{restaurantId:id(1),expiresAt:expiresAt+1,ticket:`rt1.${'a'.repeat(43)}.${expiresAt+1}.${'b'.repeat(43)}`},{Socket}));
  class ExcessiveLease extends Socket {
    static lease=now+305001;
  }
  await assert.rejects(open(target(),{restaurantId:id(1),expiresAt,ticket:`rt1.${'a'.repeat(43)}.${expiresAt}.${'b'.repeat(43)}`},{Socket:ExcessiveLease}));
});
