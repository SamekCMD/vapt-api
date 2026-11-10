import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { registerAuthDecorator } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { registerKitchenRoutes } from '../kitchen/routes.js';
import { registerTableSessionRoutes } from '../table-sessions/routes.js';
import { registerOverviewRoutes } from '../overview/routes.js';
import { registerIngestRoutes } from '../ingest/routes.js';
import { createKitchenRepository } from '../kitchen/repository.js';
import { createKitchenService } from '../kitchen/service.js';
import { createTableSessionRepository } from '../table-sessions/repository.js';
import { createTableSessionService } from '../table-sessions/service.js';
import { createOverviewRepository } from '../overview/repository.js';
import { createOverviewService } from '../overview/service.js';
import { createPushSubscriptionRepository } from '../ingest/repository.js';
import * as storageRepository from '../storage/repository.js';
import { createMenuImageService } from '../storage/service.js';
import type { CommittedChange } from '../realtime/contracts.js';
import { withTenantFixture, type TenantFixture } from './pg-test-support.js';

async function operationA(f:TenantFixture) {
  const sessionA=randomUUID(),orderA=randomUUID();
  await f.pool.query(`insert into public.table_sessions (id,restaurant_id,table_number) values ($1,$2,'1')`,[sessionA,f.restA]);
  await f.pool.query(`insert into public.orders (id,restaurant_id,table_session_id,table_number,total_price)
    values ($1,$2,$3,'1',15)`,[orderA,f.restA,sessionA]);
  return { sessionA,orderA };
}

async function actorFor(f:TenantFixture,userId:string) {
  const sessionId=randomUUID(),sessionExpiresAt=Date.now()+60_000;
  await f.pool.query(`insert into better_auth."session" (id,"userId",token,"expiresAt","updatedAt")
    values ($1,$2,$3,$4,now())`,[sessionId,userId,randomUUID(),new Date(sessionExpiresAt)]);
  return { userId,sessionId,sessionExpiresAt };
}

test('staff operation on restaurantA cannot close a table session of restaurantB',async()=>{
  await withTenantFixture(async f=>{
    const {sessionA,orderA}=await operationA(f);
    const events:CommittedChange[]=[];
    const sessions=createTableSessionService(createTableSessionRepository(f.pool,{ publishCommittedChange:async change=>{
      // A different pool connection must see the commit before notification is emitted.
      assert.equal((await f.pool.query('select status from public.table_sessions where id=$1',[sessionA])).rows[0].status,'closed');
      events.push(change);
    } }));
    const scope={ ...f.staffActor,restaurantId:f.restA };
    await assert.rejects(sessions.closeSession(scope,f.sessionB),{ statusCode:404 });
    assert.equal((await f.pool.query('select status from public.table_sessions where id=$1',[f.sessionB])).rows[0].status,'open');
    const closed=await sessions.closeSession(scope,sessionA);
    assert.deepEqual(closed.deliveredOrderIds,[orderA]);
    assert.equal(events.length,1); assert.equal(events[0].restaurantId,f.restA);
    assert.deepEqual(events[0].orderIds,[orderA]);
    const again=await sessions.closeSession(scope,sessionA);
    assert.equal(again.closedAt,closed.closedAt); assert.equal(events.length,1);
    assert.equal((await f.pool.query('select status from public.orders where id=$1',[f.orderB])).rows[0].status,'pending');
  });
});

test('staff kitchen reads and transitions operate only the explicit restaurant and publish after commit',async()=>{
  await withTenantFixture(async f=>{
    const {orderA}=await operationA(f);
    const events:CommittedChange[]=[];
    const kitchen=createKitchenService(createKitchenRepository(f.pool,{ publishCommittedChange:async change=>{
      assert.equal((await f.pool.query('select status from public.orders where id=$1',[orderA])).rows[0].status,'preparing');
      events.push(change);
    } }));
    const scope={ ...f.staffActor,restaurantId:f.restA };
    const visible=await kitchen.listActiveOrders(scope);
    assert.deepEqual(visible.map(o=>o.id),[orderA]); assert.equal(visible.every(o=>o.restaurantId===f.restA),true);
    await assert.rejects(kitchen.updateOrderStatus(scope,f.orderB,'preparing'),{ statusCode:404 });
    await assert.rejects(kitchen.updateOrderStatus(scope,orderA,'ready'),{ statusCode:409,code:'invalid_order_transition' });
    assert.equal(events.length,0);
    assert.equal((await kitchen.updateOrderStatus(scope,orderA,'preparing')).status,'preparing');
    await kitchen.updateOrderStatus(scope,orderA,'preparing');
    assert.equal(events.length,1); assert.equal(events[0].restaurantId,f.restA);
    await assert.rejects(kitchen.listActiveOrders({ userId:f.staff,restaurantId:f.restOther }),{ statusCode:403 });
  });
});

test('session details and transfers never read or update a sibling restaurant',async()=>{
  await withTenantFixture(async f=>{
    const {sessionA,orderA}=await operationA(f);
    const sessions=createTableSessionService(createTableSessionRepository(f.pool));
    const scope={ ...f.staffActor,restaurantId:f.restA };
    assert.deepEqual((await sessions.listActiveSessions(scope)).map(s=>s.id),[sessionA]);
    await assert.rejects(sessions.getSession(scope,f.sessionB),{ statusCode:404 });
    await assert.rejects(sessions.transferSession(scope,f.sessionB,'9'),{ statusCode:404 });
    const transfer=await sessions.transferSession(scope,sessionA,'7');
    assert.deepEqual(transfer.updatedOrderIds,[orderA]);
    assert.equal((await sessions.getSession(scope,sessionA)).session.tableNumber,'7');
    assert.equal((await f.pool.query('select table_number from public.table_sessions where id=$1',[f.sessionB])).rows[0].table_number,'1');
    assert.equal((await f.pool.query('select table_number from public.orders where id=$1',[f.orderB])).rows[0].table_number,null);
  });
});

test('overview aggregates only the selected restaurant even when memberships cover both',async()=>{
  await withTenantFixture(async f=>{
    const {orderA}=await operationA(f);
    await f.pool.query(`insert into public.order_feedback (order_id,restaurant_id,rating) values ($1,$2,5)`,[f.orderB,f.restB]);
    const overview=createOverviewService(createOverviewRepository(f.pool));
    const result=await overview.getOverview({ userId:f.staff,restaurantId:f.restA },'month');
    assert.equal(result.restaurant.id,f.restA); assert.deepEqual(result.orders.map(o=>o.id),[orderA]);
    assert.deepEqual(result.feedback,[]);
    await assert.rejects(overview.getOverview({ userId:f.staff,restaurantId:f.restOther },'month'),{ statusCode:403 });
  });
});

test('push registration requires the explicit operational scope and cannot steal a foreign endpoint',async()=>{
  await withTenantFixture(async f=>{
    const push=createPushSubscriptionRepository(f.pool);
    const otherActor=await actorFor(f,f.other);
    const input={ endpoint:'https://push.example.invalid/synthetic',subscription:{ endpoint:'https://push.example.invalid/synthetic',keys:{ p256dh:'synthetic',auth:'synthetic' } },
      origin:'https://app.example.invalid',user_agent:'Vapt synthetic PG test' };
    const saved=await push.upsertSubscription({ ...f.staffActor,restaurantId:f.restA },input);
    assert.equal(saved.restaurantId,f.restA);
    await assert.rejects(push.upsertSubscription({ ...f.staffActor,restaurantId:f.restOther },input),{ statusCode:403 });
    await assert.rejects(push.upsertSubscription({ ...otherActor,restaurantId:f.restOther },input),{ statusCode:409 });
    assert.equal((await f.pool.query('select restaurant_id from public.push_subscriptions where endpoint=$1',[input.endpoint])).rows[0].restaurant_id,f.restA);
  });
});

test('image upload and delete require manage capability, live session and a child in the same restaurant',async()=>{
  await withTenantFixture(async f=>{
    const calls:{ action:string;objectKey:string }[]=[];
    const images=createMenuImageService({ withAuthorizedItem:storageRepository.createMenuImageAccess(f.pool),
      publicBaseUrl:new URL('https://assets.example.invalid/'),uploadUrlTtlSeconds:300,gateway:{
        async createUploadUrl(input) { calls.push({ action:'upload',objectKey:input.objectKey }); return 'https://signed.example.invalid/upload'; },
        async deleteObject(input) { calls.push({ action:'delete',objectKey:input.objectKey }); },
      } });
    const input={ restaurantId:f.restB,itemId:f.itemB,contentType:'image/webp' as const,contentLength:1024 };
    await assert.rejects(images.prepareUpload({ ...f.staffActor,...input }),{ statusCode:403 });
    await assert.rejects(images.prepareUpload({ ...f.ownerActor,...input,restaurantId:f.restA }),{ statusCode:404 });
    await assert.rejects(images.delete({ ...f.ownerActor,restaurantId:f.restOther,itemId:f.itemB }),{ statusCode:403 });
    assert.deepEqual(calls,[]);
    const upload=await images.prepareUpload({ ...f.ownerActor,...input });
    assert.equal(upload.objectKey,`${f.restB}/${f.itemB}`);
    await images.delete({ ...f.ownerActor,restaurantId:f.restB,itemId:f.itemB });
    assert.deepEqual(calls,[{ action:'upload',objectKey:`${f.restB}/${f.itemB}` },{ action:'delete',objectKey:`${f.restB}/${f.itemB}` }]);
    await f.pool.query('delete from better_auth."session" where id=$1',[f.ownerActor.sessionId]);
    await assert.rejects(images.prepareUpload({ ...f.ownerActor,...input }),{ statusCode:401 });
    assert.equal(calls.length,2);
  });
});

test('public table check keeps its order capability and never accepts a session from another order',async()=>{
  await withTenantFixture(async f=>{
    const {sessionA,orderA}=await operationA(f);
    const sessions=createTableSessionService(createTableSessionRepository(f.pool));
    await assert.rejects(sessions.requestPublicCheck(f.sessionB,{ orderId:orderA,tableSessionId:sessionA }),{ statusCode:404 });
    assert.deepEqual(await sessions.requestPublicCheck(sessionA,{ orderId:orderA,tableSessionId:sessionA }),{ sessionId:sessionA,status:'check_requested' });
    assert.equal((await f.pool.query('select status from public.table_sessions where id=$1',[f.sessionB])).rows[0].status,'open');
  });
});

test('staff explicit operational HTTP routes use the selected restaurant while legacy adapters reject ambiguity',async()=>{
  await withTenantFixture(async f=>{
    const {sessionA,orderA}=await operationA(f);
    const app=Fastify({logger:false});
    registerAuthDecorator(app,async()=>({...f.staffActor,email:null,role:'authenticated'}));
    registerErrorHandler(app);
    await registerKitchenRoutes(app,createKitchenRepository(f.pool));
    await registerTableSessionRoutes(app,createTableSessionRepository(f.pool));
    await registerOverviewRoutes(app,createOverviewRepository(f.pool));
    await registerIngestRoutes(app,{
      pushSubscriptions:createPushSubscriptionRepository(f.pool),
      feedbackRepository:{async upsertOrderFeedback(){throw new Error('public feedback not used');}},
      publicOrders:{async getPublicOrder(){throw new Error('public order not used');}},
    });
    const base=`/restaurants/${f.restA}`;
    try {
      for(const suffix of ['/kitchen/orders','/table-sessions',`/table-sessions/${sessionA}`,'/overview?period=month']) {
        const response=await app.inject({method:'GET',url:base+suffix});
        assert.equal(response.statusCode,200,response.body);
      }
      for(const suffix of ['/kitchen/orders','/table-sessions','/overview?period=month']) {
        const response=await app.inject({method:'GET',url:'/restaurants/me'+suffix});
        assert.equal(response.statusCode,409,suffix+': '+response.body);
        assert.equal(response.json().error.code,'restaurant_selection_required');
      }
      const crossed=await app.inject({method:'POST',url:`${base}/table-sessions/${f.sessionB}/close`});
      assert.equal(crossed.statusCode,404,crossed.body);
      const patch=await app.inject({method:'PATCH',url:`${base}/kitchen/orders/${orderA}/status`,payload:{status:'preparing'}});
      assert.equal(patch.statusCode,200,patch.body);
      const transfer=await app.inject({method:'POST',url:`${base}/table-sessions/${sessionA}/transfer`,payload:{tableNumber:'8'}});
      assert.equal(transfer.statusCode,200,transfer.body);
      const push=await app.inject({method:'POST',url:base+'/push-subscription',payload:{
        endpoint:'https://push.example.invalid/http-test',subscription:{endpoint:'https://push.example.invalid/http-test'},
        origin:'https://app.example.invalid',user_agent:'Vapt local PG test',
      }});
      assert.equal(push.statusCode,200,push.body);assert.equal(push.json().restaurantId,f.restA);
      const close=await app.inject({method:'POST',url:`${base}/table-sessions/${sessionA}/close`});
      assert.equal(close.statusCode,200,close.body);
      assert.equal((await f.pool.query('select status from public.table_sessions where id=$1',[f.sessionB])).rows[0].status,'open');
    } finally {await app.close();}
  });
});
