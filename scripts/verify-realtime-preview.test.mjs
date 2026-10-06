import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { validateTarget, validateInput, createPreviewClient, openPreviewSocket, runRealtimePreview } from './verify-realtime-preview.mjs';
import { createFixtureDriver } from './realtime-preview-fixtures.mjs';

const baseUrl = 'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const origin = 'https://infra-foundation-vapt-web.autoistloko.workers.dev';
const valid = () => ({ baseUrl, origin, bearer: 'synthetic-bearer-32-characters-long', accessJwt: 'synthetic.access.jwt' });
test('fixture driver rejects production before constructing a pool', async () => {
  let opened=false;
  await assert.rejects(createFixtureDriver({ownerUrl:'postgresql://neondb_owner:synthetic-secret@ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full',
    createPool(){opened=true;}}),/Unexpected preview regression target/);
  assert.equal(opened,false);
});
test('fixture driver seeds exactly two verified accounts and deletes only its private manifest', async () => {
  const queries=[];
  const query=async(sql,params=[])=>{
    queries.push({sql,params});
    if (sql.startsWith('INSERT INTO better_auth.account')) {
      // accountId is text while userId is UUID in the versioned schema.
      assert.match(sql,/\$2::text/); assert.match(sql,/\$2::uuid/);
    }
    if (sql.includes('current_database')) return {rows:[{database:'vapt',role:'neondb_owner'}]};
    if (sql.includes('count(*)')) return {rows:[{rows:0}]};
    return {rows:[]};
  };
  const client={query,release(){}};
  const pool={query,async connect(){return client},async end(){}};
  const fixtures=await createFixtureDriver({ownerUrl:'postgresql://neondb_owner:synthetic-secret@ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full',createPool:()=>pool,hash:async()=> 'synthetic-hash'});
  const created={tag:'stage12-11111111-1111-4111-8111-111111111111',userIds:[],restaurantIds:[],orderIds:[]};
  const owners=await fixtures.seed(created.tag,created);
  assert.equal(owners.length,2);
  const inserts=queries.filter(v=>v.sql.startsWith('INSERT INTO better_auth."user"'));
  assert.equal(inserts.length,2); assert.equal(inserts.every(v=>v.sql.includes('true')),true);
  await assert.rejects(fixtures.seed(created.tag,created),/Fixture already seeded/);
  created.userIds.push('99999999-9999-4999-8999-999999999999');
  const result=await fixtures.cleanup(created);
  assert.deepEqual(result,{rows:0});
  const deletes=queries.filter(v=>v.sql.startsWith('DELETE'));
  assert.equal(deletes.length,4);
  assert.equal(deletes.every(v=>v.sql.includes('where id = $1') && v.params.length>=2),true);
  assert.equal(JSON.stringify(deletes).includes('99999999-9999-4999-8999-999999999999'),false);
  assert.equal(queries.at(-1).sql,'COMMIT');
  await fixtures.close();
});
test('target guard rejects production, arbitrary origins, credentials, paths and queries', () => {
  assert.equal(validateTarget(baseUrl, origin).origin, baseUrl);
  for (const url of ['https://api.vapt.app.br', 'https://other.workers.dev', baseUrl+'/', baseUrl+'/v1', baseUrl+'?token=synthetic', baseUrl+'#x', baseUrl.replace('https:', 'http:'), baseUrl.replace('https://', 'https://user:pass@')]) {
    assert.throws(() => validateTarget(url, origin), /Invalid realtime Preview target/);
  }
  assert.throws(() => validateTarget(baseUrl, origin+'/'), /Invalid realtime Preview target/);
});
test('input refuses missing/extra secrets and header injection before any IO', async () => {
  assert.doesNotThrow(() => validateInput(valid()));
  for (const changes of [{bearer:''}, {accessJwt:'not-jwt'}, {bearer:'synthetic\r\nCookie: injected'}, {ownerUrl:'synthetic-secret'}, {origin:'https://api.vapt.app.br'}]) {
    assert.throws(() => validateInput({...valid(), ...changes}), /Invalid realtime Preview/);
  }
  let io = 0;
  await assert.rejects(runRealtimePreview({...valid(),baseUrl:'https://api.vapt.app.br'}, {fetcher:()=>{io++},fixtures:{seed:()=>{io++}}}), /Invalid realtime Preview/);
  assert.equal(io, 0);
});
test('HTTP client preserves separate perimeter/cookie authority and refuses external paths', async () => {
  const requests = [];
  const api = createPreviewClient(valid(), async (url, options) => {
    requests.push({url,options});
    return Response.json({status:'ok'});
  });
  await api('/v1/realtime/tickets',{method:'POST',body:{mode:'owner',restaurantId:'11111111-1111-4111-8111-111111111111'},cookie:'synthetic-cookie'});
  assert.equal(requests[0].url, baseUrl+'/v1/realtime/tickets');
  assert.equal(requests[0].options.redirect,'manual');
  assert.equal(requests[0].options.headers.get('Authorization'),'Bearer synthetic-bearer-32-characters-long');
  assert.equal(requests[0].options.headers.get('Cf-Access-Token'),'synthetic.access.jwt');
  assert.equal(requests[0].options.headers.get('Cookie'),'synthetic-cookie');
  await assert.rejects(api('//evil.example/path'), /Invalid Preview request/);
  await assert.rejects(api('https://evil.example/path'), /Invalid Preview request/);
  await assert.rejects(api('/health',{headers:{Authorization:'bypass'}}), /Invalid Preview request/);
  assert.equal(requests.length,1);
});
test('WebSocket sends ticket only in subprotocol, validates ready and auto-acks envelopes', async () => {
  class Socket extends EventEmitter {
    readyState = 1; sent = [];
    constructor(url, protocols, options) {
      super();
      assert.equal(url,'wss://stage11-inert-vapt-api-parallel.autoistloko.workers.dev/v1/realtime/restaurants/11111111-1111-4111-8111-111111111111/socket');
      assert.equal(new URL(url).search,'');
      assert.deepEqual(protocols,['vapt.realtime.v1','vapt.ticket.'+'a'.repeat(43)]);
      assert.equal(options.headers.Authorization,'Bearer synthetic-bearer-32-characters-long');
      this.protocol = 'vapt.realtime.v1';
      queueMicrotask(()=>{this.emit('upgrade',{statusCode:101,headers:{'sec-websocket-protocol':'vapt.realtime.v1'}}); this.emit('message',Buffer.from(JSON.stringify({version:1,type:'ready',leaseExpiresAt:Date.now()+10000})));});
    }
    send(value) { this.sent.push(value); }
    close() { this.readyState=3; this.emit('close',1000); }
    terminate() { this.close(); }
  }
  const connection = await openPreviewSocket(valid(),{restaurantId:'11111111-1111-4111-8111-111111111111',ticket:'a'.repeat(43),expiresAt:Date.now()+30000},{Socket});
  connection.socket.emit('message',Buffer.from(JSON.stringify({version:1,eventId:'22222222-2222-4222-8222-222222222222',sequence:1,topic:'orders',entityId:'33333333-3333-4333-8333-333333333333',reason:'created'})));
  assert.equal(connection.frames.length,1);
  assert.deepEqual(JSON.parse(connection.socket.sent[0]),{version:1,type:'ack',sequence:1});
  await connection.close();
});
test('runner fails closed and sanitizes external errors while cleaning partial fixtures', async () => {
  let cleaned = false;
  const result = await runRealtimePreview(valid(), {
    fetcher: async (_url,options) => new Response(null,{status: options.headers?.get('Cf-Access-Token') ? 401 : 302}),
    fixtures: { seed: async (_tag,created) => { created.userIds.push('11111111-1111-4111-8111-111111111111'); throw new Error('synthetic-bearer synthetic-cookie synthetic.access.jwt'); },
      cleanup: async created => { assert.equal(created.userIds.length,1); cleaned=true; return {rows:0}; } },
  });
  assert.equal(result.ok,false); assert.equal(result.cleaned,true); assert.equal(cleaned,true);
  assert.equal(result.failure,'fixtures');
  assert.doesNotMatch(JSON.stringify(result),/synthetic|cookie|jwt|https:/i);
});
test('CLI malformed input prints only sanitized failure and consumes no secrets on import', async () => {
  const child = spawn(process.execPath,['scripts/verify-realtime-preview.mjs'],{stdio:['pipe','pipe','pipe']});
  let output=''; child.stdout.on('data',c=>output+=c); child.stderr.on('data',c=>output+=c);
  child.stdin.end(JSON.stringify({...valid(),baseUrl:'https://api.vapt.app.br?key=synthetic-bearer'}));
  const code=await new Promise(res=>child.on('exit',res));
  assert.equal(code,1); assert.doesNotMatch(output,/synthetic|api\.vapt|stack|Bearer/);
  assert.match(output,/failed/);
});

test('bounded two-tenant flow proves filtering, reconnect and old-session revocation without ownership changes', async () => {
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const owners = [0,1].map(n=>({userId:id(n+1),restaurantId:id(n+3),itemId:id(n+5),slug:'stage12-tenant-'+n,email:'synthetic-'+n+'@example.invalid',password:'synthetic-password',orders:[],sessionId:id(n+7),status:'open'}));
  const sessions = new Map(), tickets = new Map(), connections=[]; let logins=0,orderNumber=10;
  const publish=(owner,orderId,reason,topics)=>{
    for (const c of connections.filter(c=>c.owner===owner && c.code===null)) {
      if (c.cookie && !sessions.has(c.cookie)) { c.code=1008; continue; }
      if (c.orderId && c.orderId!==orderId) continue;
      for (const topic of c.orderId?['orders']:topics) c.frames.push({version:1,eventId:id(100+c.frames.length),sequence:c.frames.length+1,entityId:c.orderId??orderId,reason,topic});
    }
  };
  const fixtures={
    async seed(_tag,created) { created.userIds.push(...owners.map(o=>o.userId));created.restaurantIds.push(...owners.map(o=>o.restaurantId)); return owners.map(o=>({...o})); },
    async cleanup(created) { assert.equal(created.orderIds.length,4); return {rows:0}; },
  };
  const fetcher=async(url,options)=>{
    const path=new URL(url).pathname, headers=options.headers, body=options.body?JSON.parse(options.body):null;
    if (!headers.has('Cf-Access-Token')) return new Response(null,{status:302});
    if (!headers.has('Authorization')) return new Response(null,{status:401});
    const cookie=headers.get('Cookie'), owner=sessions.get(cookie);
    const json=(v,status=200,extra={})=>Response.json(v,{status,headers:extra});
    if (path==='/api/auth/sign-in/email') {
      const user=owners.find(o=>o.email===body.email); assert.ok(user);logins++;
      const value='better-auth.session_token=synthetic-cookie-'+logins;sessions.set(value,user);
      return json({user:{id:user.userId} },200,{'Set-Cookie':value+'; Path=/; HttpOnly'});
    }
    if (path==='/auth/me') return json({userId:owner.userId});
    if (path==='/api/auth/sign-out') {sessions.delete(cookie);return json({success:true});}
    if (path==='/v1/realtime/tickets') {
      let grant;
      if (body.mode==='owner') {
        if (!owner) return json({},401);
        if (owner.restaurantId!==body.restaurantId) return json({},403);
        grant={owner,cookie};
      } else {
        const tenant=owners.find(o=>o.orders.some(v=>v.orderId===body.orderId));
        const order=tenant?.orders.find(o=>o.orderId===body.orderId);
        if (!order || headers.get('X-Vapt-Order-Token')!==order.publicToken) return json({},404);
        grant={owner:tenant,orderId:order.orderId};
      }
      const token='t'.repeat(42)+String(tickets.size); tickets.set(token,grant);
      return json({restaurantId:grant.owner.restaurantId,ticket:token,expiresAt:Date.now()+30000});
    }
    if (path==='/public/orders') {
      const tenant=owners.find(o=>o.slug===body.restaurantSlug);
      const order={orderId:id(orderNumber++),publicToken:'synthetic-order-token-'+orderNumber,status:'pending'};tenant.orders.push(order);
      publish(tenant,order.orderId,'created',['orders','kitchen','table_sessions']); return json(order,201);
    }
    if (path.startsWith('/public/orders/')) {
      const order=owners.flatMap(o=>o.orders).find(o=>o.orderId===path.split('/').at(-1));return json(order);
    }
    if (path.endsWith('/status')) {
      assert.ok(owner);const order=owner.orders.find(o=>o.orderId===path.split('/').at(-2));assert.ok(order);order.status=body.status;
      publish(owner,order.orderId,'updated',['orders','kitchen','table_sessions']);return json({status:order.status});
    }
    if (path==='/restaurants/me/kitchen/orders') return json(owner.orders.map(o=>({id:o.orderId,status:o.status})));
    if (path==='/restaurants/me/table-sessions') return json([{id:owner.sessionId,orderCount:2,status:owner.status}]);
    if (path.endsWith('/request-check')) {
      const tenant=owners.find(o=>o.sessionId===path.split('/').at(-2)); tenant.status='check_requested';
      publish(tenant,body.publicOrderId,'check_requested',['orders','table_sessions']);return json({status:tenant.status});
    }
    throw new Error('Unhandled synthetic request');
  };
  const connect=async(_input,ticket)=>{
    const grant=tickets.get(ticket.ticket); assert.ok(grant);
    const c={...grant,frames:[],code:null,closedCode(){return this.code},async waitFor(fn){assert.equal(fn(),true);},async close(){if(this.code===null)this.code=1000;}};
    connections.push(c);return c;
  };
  const result=await runRealtimePreview(valid(),{fixtures,fetcher,connect,quietWait:async()=>{}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.cleaned,true);
  assert.deepEqual(result.counts,{tenants:2,orders:4,connections:5});
  assert.equal(logins,3);assert.equal(connections.every(c=>c.code!==null),true);
  assert.equal(Object.values(result.checks).every(v=>v===true),true);
  assert.doesNotMatch(JSON.stringify(result),/synthetic|cookie|jwt|https:/i);
});
