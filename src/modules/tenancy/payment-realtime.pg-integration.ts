import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApiServices} from '../../composition/api-services.js';
import {createManualPaymentProvider} from '../payments/providers/manual.js';
import type {AppConfig} from '../../lib/config.js';
import {createSecretCipher} from '../../lib/crypto.js';
import Fastify from 'fastify';
import {registerAuthDecorator} from '../../plugins/auth.js';
import {registerErrorHandler} from '../../plugins/error-handler.js';
import {createManualPaymentRoutes} from '../payments/routes.js';
import {createMercadoPagoOAuthService,createMercadoPagoOAuthRepository} from '../payments/providers/mercado-pago/oauth.js';
import {createRealtimeAuthorization} from '../realtime/authorization.js';
import {createOrderService} from '../orders/service.js';
import {createOrderRepository} from '../orders/repository.js';
import {createOwnershipLookup} from '../../lib/permissions.js';
import {withTenantFixture} from './pg-test-support.js';
import {authorizeRestaurant,withRestaurantWrite,resolveLegacyRestaurant} from './authorization.js';
import type {Capability,RestaurantScope,RestaurantWriteScope} from './contracts.js';
import type {MercadoPagoOAuthRepository} from '../payments/providers/mercado-pago/oauth.js';

test('staff realtime admission is revoked on the next batched membership validation',async()=>{
  await withTenantFixture(async f=>{
    const runtime={async handler(){return new Response(null,{status:404});},async close(){},async getSession(){return {
      user:{id:f.staff,email:'synthetic@example.invalid',name:'Staff'},
      session:{id:f.staffActor.sessionId,userId:f.staff,expiresAt:new Date(f.staffActor.sessionExpiresAt)},
    };}};
    const auth=createRealtimeAuthorization({database:f.pool,authRuntime:runtime,
      orders:createOrderService(createOrderRepository(f.pool),'synthetic-secret')});
    const grant=await auth.admit({mode:'owner',restaurantId:f.restA,headers:new Headers({cookie:'synthetic-session'})});
    assert.equal(grant.mode,'owner');
    assert.deepEqual(await auth.revalidate([grant,grant],Date.now()),[true,true]);
    await f.pool.query("update public.organization_members set status='disabled' where organization_id=$1 and user_id=$2",[f.orgA,f.staff]);
    assert.deepEqual(await auth.revalidate([grant,grant],Date.now()),[false,false]);
  });
});

test('staff manual payment confirms only the selected restaurant and publishes after its commit',async()=>{
  await withTenantFixture(async f=>{
    let published=0;
    const services=createApiServices({nodeEnv:'test',security:{publicOrderTokenSecret:'synthetic-secret'}} as AppConfig,{
      database:f.pool,paymentProviders:[createManualPaymentProvider()],publishCommittedChange:async change=>{
        assert.equal(change.restaurantId,f.restB);published++;
        assert.equal((await f.pool.query('select status from public.payment_transactions where id=$1',[change.entityId])).rows[0].status,'paid');
      },
    });
    const input={...f.staffActor,restaurantId:f.restB,orderId:f.orderB,paymentMethod:'cash' as const,idempotencyKey:randomUUID(),authRole:'authenticated'};
    await assert.rejects(services.manualPayments.confirm({...input,restaurantId:f.restA}),{statusCode:404});
    const paid=await services.manualPayments.confirm(input);
    assert.equal(paid.manuallyConfirmedBy,f.staff);assert.equal(paid.restaurantId,f.restB);assert.equal(paid.status,'paid');
    assert.equal(published,1);
    await f.pool.query('delete from better_auth."session" where id=$1',[f.staffActor.sessionId]);
    await assert.rejects(services.manualPayments.confirm({...input,idempotencyKey:randomUUID()}),{statusCode:401});
  });
});

test('provider manager reads status but cannot connect; revoked initiating admin cannot persist callback credentials',async()=>{
  await withTenantFixture(async f=>{
    const managerActor={userId:f.manager,sessionId:randomUUID(),sessionExpiresAt:Date.now()+60_000};
    await f.pool.query('insert into better_auth."session" (id,"userId",token,"expiresAt","updatedAt") values($1,$2,$3,$4,now())',
      [managerActor.sessionId,f.manager,randomUUID(),new Date(managerActor.sessionExpiresAt)]);
    let exchanges=0;
    const dependencies={repository:createMercadoPagoOAuthRepository(f.pool),cipher:createSecretCipher(Buffer.alloc(32,1)),
      ownershipLookup:createOwnershipLookup(f.pool),
      authorizeRestaurant:(scope:RestaurantScope,capability:Capability)=>authorizeRestaurant(f.pool,scope,capability),
      withAuthorizedWrite:<T>(scope:RestaurantWriteScope,work:(repository:MercadoPagoOAuthRepository)=>Promise<T>)=>
        withRestaurantWrite(f.pool,scope,'billing.manage',client=>work(createMercadoPagoOAuthRepository(client))),
      client:{async exchangeAuthorizationCode(){exchanges++;return {accessToken:'synthetic-access',refreshToken:'synthetic-refresh',tokenType:'bearer',expiresIn:3600,scope:'read write',userId:'synthetic-seller',liveMode:false};},
        async refreshAccessToken(){throw new Error('refresh not used');}},
      config:{clientId:'synthetic-client',redirectUri:new URL('https://api.example.invalid/callback'),frontendUrl:new URL('https://app.example.invalid'),credentialKeyId:'synthetic',stateTtlMs:600_000},
    };
    const service=createMercadoPagoOAuthService(dependencies);
    const status=await service.getStatus({userId:f.manager,restaurantId:f.restA,environment:'sandbox'});
    assert.equal(status.status,'disconnected');
    await assert.rejects(service.beginConnection({...managerActor,restaurantId:f.restA,environment:'sandbox'}),{statusCode:403});
    const begin=await service.beginConnection({...f.adminActor,restaurantId:f.restA,environment:'sandbox'});
    const state=new URL(begin.authorizationUrl).searchParams.get('state')!;
    await f.pool.query("update public.organization_members set status='disabled' where organization_id=$1 and user_id=$2",[f.orgA,f.admin]);
    await assert.rejects(service.handleCallback({state,code:'synthetic-code'}),{statusCode:403});
    assert.equal(exchanges,0);
    assert.equal((await f.pool.query('select count(*)::int n from public.payment_provider_accounts where restaurant_id=$1',[f.restA])).rows[0].n,0);
  });
});

test('manual HTTP explicit scope rejects a crossed child and legacy adapter requires an unambiguous restaurant',async()=>{
  await withTenantFixture(async f=>{
    const config={nodeEnv:'test',security:{publicOrderTokenSecret:'synthetic-secret'}} as AppConfig;
    const services=createApiServices(config,{database:f.pool,paymentProviders:[createManualPaymentProvider()]});
    const app=Fastify({logger:false});registerAuthDecorator(app,async()=>({...f.staffActor,email:null,role:'authenticated'}));registerErrorHandler(app);
    await createManualPaymentRoutes(app,config,services.manualPayments,userId=>resolveLegacyRestaurant(f.pool,userId));
    try{
      const request={method:'POST' as const,headers:{'idempotency-key':randomUUID()},payload:{paymentMethod:'cash'}};
      const crossed=await app.inject({...request,url:`/restaurants/${f.restA}/orders/${f.orderB}/payments/manual-confirmation`});
      assert.equal(crossed.statusCode,404,crossed.body);
      const legacy=await app.inject({...request,url:`/orders/${f.orderB}/payments/manual-confirmation`});
      assert.equal(legacy.statusCode,409,legacy.body);assert.equal(legacy.json().error.code,'restaurant_selection_required');
      const allowed=await app.inject({...request,url:`/restaurants/${f.restB}/orders/${f.orderB}/payments/manual-confirmation`});
      assert.equal(allowed.statusCode,200,allowed.body);assert.equal(allowed.json().status,'paid');
    }finally{await app.close();}
  });
});
