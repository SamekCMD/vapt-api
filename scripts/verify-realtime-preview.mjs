// Operator-only smoke. Input credentials are stdin-only, never CLI arguments,
// query parameters, output or persisted fixtures. No provider/email operations.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import WebSocket from 'ws';

const preview = 'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const previewOrigin = 'https://infra-foundation-vapt-web.autoistloko.workers.dev';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const require = condition => { if (!condition) throw new Error('Preview assertion failed'); };
export function validateTarget(baseUrl, origin) {
  if (baseUrl !== preview || origin !== previewOrigin) throw new Error('Invalid realtime Preview target');
  return new URL(baseUrl);
}
export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'accessJwt,baseUrl,bearer,origin') throw new Error('Invalid realtime Preview input');
  validateTarget(input.baseUrl, input.origin);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(input.bearer ?? '') ||
      typeof input.accessJwt !== 'string' || input.accessJwt.length > 16384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.accessJwt)) throw new Error('Invalid realtime Preview credentials');
}
export function createPreviewClient(input, fetcher = fetch) {
  validateInput(input);
  return async (path, {method='GET',body,cookie='',headers={},perimeter='both'} = {}, statuses=[200]) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#\\\r\n]/.test(path) ||
        Object.keys(headers).some(key => !['x-vapt-order-token','idempotency-key','x-captcha-response'].includes(key.toLowerCase())) ||
        !['both','access','none'].includes(perimeter)) throw new Error('Invalid Preview request');
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Origin',input.origin);
    if (perimeter !== 'none') requestHeaders.set('Cf-Access-Token',input.accessJwt);
    if (perimeter === 'both') requestHeaders.set('Authorization','Bearer '+input.bearer);
    if (cookie) requestHeaders.set('Cookie',cookie);
    if (body !== undefined) requestHeaders.set('Content-Type','application/json');
    const response = await fetcher(input.baseUrl+path,{method,headers:requestHeaders,redirect:'manual',credentials:'omit',
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    require(statuses.includes(response.status));
    let json = null;
    if (response.headers.get('content-type')?.includes('application/json')) json = await response.json();
    else await response.body?.cancel();
    return {response,json};
  };
}
export async function openPreviewSocket(input, ticket, {Socket=WebSocket}={}) {
  validateInput(input);
  const ingress=typeof ticket?.ticket==='string' ? ticket.ticket.match(/^rt1\.[A-Za-z0-9_-]{43}\.([1-9][0-9]{0,15})\.[A-Za-z0-9_-]{43}$/) : null;
  require(uuid.test(ticket?.restaurantId ?? '') && ingress && Number(ingress[1])===ticket.expiresAt &&
    Number.isSafeInteger(ticket.expiresAt) && ticket.expiresAt>Date.now() && ticket.expiresAt<=Date.now()+30000);
  const url = new URL(`/v1/realtime/restaurants/${ticket.restaurantId}/socket`,input.baseUrl); url.protocol='wss:';
  const socket = new Socket(url.toString(),['vapt.realtime.v1','vapt.ticket.'+ticket.ticket],{
    headers:{Origin:input.origin,'Cf-Access-Token':input.accessJwt,Authorization:'Bearer '+input.bearer},handshakeTimeout:10000,maxPayload:4096,closeTimeout:1000,
  });
  const frames=[];
  let ready=false, upgraded=false, fault=false, closedCode=null;
  socket.on('upgrade',response=>{upgraded=response.statusCode===101 && response.headers['sec-websocket-protocol']==='vapt.realtime.v1';});
  socket.on('error',()=>{fault=true;});
  socket.on('unexpected-response',(_req,response)=>{fault=true; response.resume(); socket.terminate();});
  socket.on('close',code=>{closedCode=code;});
  socket.on('message',data=>{
    try {
      require(data.byteLength<=4096);
      const frame=JSON.parse(data.toString());
      if (frame.type==='ready') {
        require(!ready && Object.keys(frame).sort().join(',')==='leaseExpiresAt,type,version' && frame.version===1 &&
          Number.isSafeInteger(frame.leaseExpiresAt) && frame.leaseExpiresAt>Date.now() && frame.leaseExpiresAt<=Date.now()+300000);
        ready=true;
      } else {
        require(ready && Object.keys(frame).sort().join(',')==='entityId,eventId,reason,sequence,topic,version' && frame.version===1 &&
          uuid.test(frame.eventId) && uuid.test(frame.entityId) && Number.isSafeInteger(frame.sequence) && frame.sequence>0 &&
          ['orders','kitchen','table_sessions','payments'].includes(frame.topic) &&
          ['created','updated','cancelled','payment_changed','check_requested','closed','transferred'].includes(frame.reason) && frames.length<128);
        frames.push(frame); socket.send(JSON.stringify({version:1,type:'ack',sequence:frame.sequence}));
      }
    } catch {fault=true; socket.terminate();}
  });
  const waitFor=async predicate=>{
    const deadline=Date.now()+10000;
    while (!predicate()) {require(!fault && Date.now()<deadline); await wait(25);}
    require(!fault);
  };
  const connection={socket,frames,waitFor,closedCode:()=>closedCode,async close(){
    if (socket.readyState===3) return;
    socket.close(1000);
    const deadline=Date.now()+2000;
    while (closedCode===null && Date.now()<deadline) await wait(25);
    if (closedCode===null) socket.terminate();
  }};
  try {await waitFor(()=>ready && upgraded); return connection;}
  catch {await connection.close(); throw new Error('Preview WebSocket admission failed');}
}

// Fixture port owns only approved preview synthetic DB IDs. The CLI loads an
// explicit local operator driver; it is never bundled/deployed with the Worker.
export async function runRealtimePreview(input,{fetcher=fetch,connect=openPreviewSocket,fixtures,quietWait=wait}={}) {
  validateInput(input);
  require(typeof fixtures?.seed==='function' && typeof fixtures.cleanup==='function');
  const api=createPreviewClient(input,fetcher);
  const created={tag:'stage12-'+randomUUID(),userIds:[],restaurantIds:[],orderIds:[]};
  const sockets=[];
  const summary={ok:false,cleaned:false,checks:{perimeter:false,admission:false,tenantIsolation:false,publicIsolation:false,kitchen:false,cashier:false,reconnect:false,revocation:false},counts:{tenants:0,orders:0,connections:0},failure:null};
  let phase='perimeter',owners=[];
  async function ticket(body,cookie='',token=null,statuses=[200]) {
    return (await api('/v1/realtime/tickets',{method:'POST',body,cookie,headers:token?{'X-Vapt-Order-Token':token}:{}},statuses)).json;
  }
  async function open(body,cookie='',token=null) {
    const admission=await ticket(body,cookie,token);
    const connection=await connect(input,admission);
    sockets.push(connection); summary.counts.connections++;
    return connection;
  }
  async function login(owner) {
    const result=await api('/api/auth/sign-in/email',{method:'POST',body:{email:owner.email,password:owner.password},headers:{'X-Captcha-Response':'XXXX.DUMMY.TOKEN.XXXX'}});
    require(result.json?.user?.id===owner.userId);
    const cookie=result.response.headers.getSetCookie().map(v=>v.split(';')[0]).filter(v=>/^(?:__Secure-)?better-auth\./.test(v)).join('; ');
    require(cookie.includes('session_token='));
    return cookie;
  }
  try {
    await api('/health',{perimeter:'none'},[302,403]);
    await api('/health',{perimeter:'access'},[401]);
    summary.checks.perimeter=true;
    phase='fixtures'; owners=await fixtures.seed(created.tag,created);
    require(Array.isArray(owners) && owners.length===2 && owners.every(v=>uuid.test(v.userId)&&uuid.test(v.restaurantId)&&uuid.test(v.itemId)) &&
      owners[0].restaurantId!==owners[1].restaurantId && owners[0].userId!==owners[1].userId);
    summary.counts.tenants=2;
    phase='auth';
    for (const owner of owners) {
      owner.cookie=await login(owner);
      require((await api('/auth/me',{cookie:owner.cookie})).json?.userId===owner.userId);
    }
    phase='admission';
    await ticket({mode:'owner',restaurantId:owners[0].restaurantId},'',null,[401]);
    await ticket({mode:'owner',restaurantId:owners[1].restaurantId},owners[0].cookie,null,[403]);
    for (const owner of owners) owner.connection=await open({mode:'owner',restaurantId:owner.restaurantId},owner.cookie);
    summary.checks.admission=true;
    phase='orders';
    for (const owner of owners) {
      owner.orders=[];
      for (let index=0;index<2;index++) {
        const result=await api('/public/orders',{method:'POST',body:{restaurantSlug:owner.slug,channel:'local',tableNumber:1,items:[{menuItemId:owner.itemId,quantity:1}]},headers:{'Idempotency-Key':created.tag+'-'+owner.restaurantId+'-'+index}},[201]);
        require(uuid.test(result.json?.orderId) && typeof result.json.publicToken==='string');
        owner.orders.push(result.json); created.orderIds.push(result.json.orderId); summary.counts.orders++;
        await owner.connection.waitFor(()=>owner.connection.frames.some(f=>f.entityId===result.json.orderId&&f.topic==='orders'));
      }
    }
    require(summary.counts.orders===4);
    for (const owner of owners) require(!owner.connection.frames.some(f=>owners.find(v=>v!==owner).orders.some(o=>o.orderId===f.entityId)));
    summary.checks.tenantIsolation=true;
    phase='public';
    for (const owner of owners) {
      const order=owner.orders[0];
      await ticket({mode:'order',orderId:order.orderId},'','x'.repeat(43),[404]);
      owner.publicConnection=await open({mode:'order',orderId:order.orderId},'',order.publicToken);
    }
    phase='kitchen';
    for (const owner of owners) {
      const order=owner.orders[0];
      const result=await api(`/restaurants/me/kitchen/orders/${order.orderId}/status`,{method:'PATCH',body:{status:'preparing'},cookie:owner.cookie});
      require(result.json?.status==='preparing');
      await owner.connection.waitFor(()=>owner.connection.frames.some(f=>f.entityId===order.orderId&&f.topic==='kitchen'&&f.reason==='updated'));
      await owner.publicConnection.waitFor(()=>owner.publicConnection.frames.length>0);
      require((await api('/public/orders/'+order.orderId,{headers:{'X-Vapt-Order-Token':order.publicToken}})).json?.status==='preparing');
      const snapshot=(await api('/restaurants/me/kitchen/orders',{cookie:owner.cookie})).json;
      require(snapshot.some(v=>v.id===order.orderId&&v.status==='preparing') && snapshot.length===2);
    }
    summary.checks.kitchen=true;
    phase='public-isolation';
    const before=owners.map(v=>v.publicConnection.frames.length);
    for (const owner of owners) await api(`/restaurants/me/kitchen/orders/${owner.orders[1].orderId}/status`,{method:'PATCH',body:{status:'preparing'},cookie:owner.cookie});
    await quietWait(750);
    owners.forEach((owner,index)=>{
      require(owner.publicConnection.frames.length===before[index]);
      require(owner.publicConnection.frames.every(f=>f.topic==='orders'&&f.entityId===owner.orders[0].orderId));
      require(owner.publicConnection.frames[0].sequence===1);
    });
    summary.checks.publicIsolation=true;
    phase='cashier';
    for (const owner of owners) {
      const sessions=(await api('/restaurants/me/table-sessions',{cookie:owner.cookie})).json;
      require(sessions.length===1 && sessions[0].orderCount===2); owner.sessionId=sessions[0].id;
      const start=owner.connection.frames.length;
      await api('/public/table-sessions/'+owner.sessionId+'/request-check',{method:'POST',body:{publicOrderId:owner.orders[0].orderId,publicOrderToken:owner.orders[0].publicToken}});
      await owner.connection.waitFor(()=>owner.connection.frames.slice(start).some(f=>f.topic==='table_sessions'&&f.reason==='check_requested'));
      require((await api('/restaurants/me/table-sessions',{cookie:owner.cookie})).json[0].status==='check_requested');
    }
    summary.checks.cashier=true;
    phase='reconnect';
    await owners[0].connection.close();
    owners[0].connection=await open({mode:'owner',restaurantId:owners[0].restaurantId},owners[0].cookie);
    require((await api('/restaurants/me/kitchen/orders',{cookie:owners[0].cookie})).json.length===2);
    summary.checks.reconnect=true;
    phase='revocation';
    await api('/api/auth/sign-out',{method:'POST',body:{},cookie:owners[0].cookie});
    await ticket({mode:'owner',restaurantId:owners[0].restaurantId},owners[0].cookie,null,[401]);
    const framesBefore=owners[0].connection.frames.length;
    // Same owner, genuinely new session. A committed write from that session
    // must revoke the old socket, not inherit its authority or deliver a frame.
    owners[0].cookie=await login(owners[0]);
    await api(`/restaurants/me/kitchen/orders/${owners[0].orders[0].orderId}/status`,{method:'PATCH',body:{status:'ready'},cookie:owners[0].cookie});
    await owners[0].connection.waitFor(()=>owners[0].connection.closedCode()!==null);
    require(owners[0].connection.closedCode()===1008 && owners[0].connection.frames.length===framesBefore);
    summary.checks.revocation=true;
    summary.ok=true;
  } catch {summary.failure=phase;}
  finally {
    for (const connection of sockets) {try {await connection.close();} catch {summary.ok=false;}}
    try {summary.cleaned=(await fixtures.cleanup(created))?.rows===0;} catch {summary.cleaned=false;}
    if (!summary.cleaned) {summary.ok=false; summary.failure='cleanup';}
    for (const owner of owners) {owner.cookie='';owner.password='';}
  }
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  let raw='',input;
  try {
    for await (const chunk of process.stdin) raw+=chunk;
    input=JSON.parse(raw);raw='';validateInput(input);
    // Path is not a credential; driver has explicit preview-only SQL lifecycle.
    if (!process.env.VAPT_REALTIME_FIXTURE_DRIVER) throw new Error();
    const {createFixtureDriver}=await import(pathToFileURL(resolve(process.env.VAPT_REALTIME_FIXTURE_DRIVER)).href);
    const fixtures=await createFixtureDriver();
    try {const result=await runRealtimePreview(input,{fixtures}); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode=1;}
    finally {await fixtures.close?.();}
  } catch {console.log(JSON.stringify({ok:false,diagnostic:'Preview smoke failed'}));process.exitCode=1;}
  finally {raw='';if (input) {input.bearer='';input.accessJwt='';}}
}
