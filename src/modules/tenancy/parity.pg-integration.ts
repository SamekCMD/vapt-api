import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {withTenantFixture} from './pg-test-support.js';
import {createAccountRepository} from '../account/repository.js';
import {createAccountService} from '../account/service.js';
import {createOnboardingRepository} from '../onboarding/repository.js';
import {createCatalogRepository} from '../catalog/repository.js';
import {applyCatalogCommand} from '../catalog-publication/transaction.js';
import {createMenuItemBodySchema} from '../menu/schemas.js';
import {createStripeWebhookRepository} from '../billing/stripe/webhook-repository.js';
import {createApiServices} from '../../composition/api-services.js';
import {createManualPaymentProvider} from '../payments/providers/manual.js';
import type {AppConfig} from '../../lib/config.js';

test('paired tenant product flow keeps SaaS effects unique and public DTOs private-field-free',async()=>{
  await withTenantFixture(async f=>{
    const onboarding=createOnboardingRepository(f.pool),account=createAccountService(createAccountRepository(f.pool));
    const services=createApiServices({nodeEnv:'test',security:{publicOrderTokenSecret:'synthetic-parity-token-secret'}} as AppConfig,
      {database:f.pool,paymentProviders:[createManualPaymentProvider()]});
    const drafts=[];
    for(let n=0;n<23;n++)drafts.push(await onboarding.createOrganizationDraft(f.adminActor,f.orgA,randomUUID(),{name:'Paridade '+n,slug:'paridade-'+n}));
    assert.equal((await f.pool.query('select count(*)::int n from public.restaurants where organization_id=$1',[f.orgA])).rows[0].n,25);
    await assert.rejects(onboarding.createOrganizationDraft(f.ownerActor,f.orgA,randomUUID(),{name:'Acima do limite',slug:'paridade-limite'}),{statusCode:409});
    const draft=drafts[0]!,publicCatalog=createCatalogRepository(f.pool);
    assert.equal(await publicCatalog.findPublishedBySlug(draft.slug),null);
    await onboarding.saveDraft(f.adminActor,draft.id,{localEnabled:true,deliveryEnabled:true,totalTables:3,onboardingStep:2});
    assert.equal((await createOnboardingRepository(f.pool).getDraft({userId:f.admin,restaurantId:draft.id})).onboardingStep,2);
    const actor=f.adminActor,operationId=randomUUID(),command={actor,operationId,restaurantId:draft.id,mutation:{type:'onboarding.finalize' as const,input:{restaurantId:draft.id}}};
    const [first,replay]=await Promise.all([applyCatalogCommand(f.pool,command),applyCatalogCommand(f.pool,command)]);assert.deepEqual(first,replay);
    assert.equal((await f.pool.query('select count(*)::int n from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows[0].n,1);
    assert.equal((await f.pool.query('select trial_started_at from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows[0].trial_started_at,null);
    const item=await applyCatalogCommand(f.pool,{actor,operationId:randomUUID(),restaurantId:draft.id,mutation:{type:'item.create',input:createMenuItemBodySchema.parse({
      name:'Prato integrado',price:'15.00',category:'Pratos',description:null,available:true,imageUrl:null,availableFrom:null,availableUntil:null,badge:null,isChefSuggestion:false,prepTimeMinutes:null,variations:[],
    })}});
    const itemId=(item.result as {id:string}).id;
    const input={restaurantSlug:draft.slug,channel:'local' as const,tableNumber:1,items:[{menuItemId:itemId,quantity:1}]},orderKey=randomUUID();
    const local=await services.orders.createPublicOrder(input,orderKey);
    assert.equal((await services.orders.createPublicOrder(input,orderKey)).orderId,local.orderId);
    const delivery=await services.orders.createPublicOrder({restaurantSlug:draft.slug,channel:'delivery',items:input.items,
      delivery:{name:'Cliente sintético',phone:'61999999999',street:'Rua Teste',number:'1',neighborhood:'Centro',paymentMode:'on_delivery'}},randomUUID());
    const scope={...f.staffActor,restaurantId:draft.id};
    const active=await services.kitchen.listActiveOrders(scope);assert.deepEqual(new Set(active.map(order=>order.id)),new Set([local.orderId,delivery.orderId]));
    assert.equal((await services.manualPayments.confirm({...scope,orderId:local.orderId,paymentMethod:'cash',idempotencyKey:randomUUID(),authRole:'authenticated'})).status,'paid');
    assert.equal((await services.kitchen.updateOrderStatus(scope,local.orderId,'preparing')).status,'preparing');
    assert.equal((await services.tableSessions.getSession(scope,local.tableSessionId!)).session.restaurantId,draft.id);
    await assert.rejects(services.manualPayments.confirm({...scope,restaurantId:f.restOther,orderId:local.orderId,paymentMethod:'cash',idempotencyKey:randomUUID(),authRole:'authenticated'}),{statusCode:403});
    await assert.rejects(applyCatalogCommand(f.pool,{...command,actor:f.staffActor,operationId:randomUUID()}),{statusCode:403});
    for(const [userId,role] of [[f.owner,'owner'],[f.admin,'admin'],[f.manager,'manager'],[f.staff,'staff']] as const){
      const bootstrap=await account.getBootstrap(userId,draft.id);assert.equal(bootstrap.organizations[0].role,role);
      if(role==='staff')assert.equal(bootstrap.organizations[0].capabilities.includes('billing.read'),false);
    }
    await assert.rejects(account.getBootstrap(f.other,draft.id),{statusCode:403});
    const renamed=await applyCatalogCommand(f.pool,{actor,restaurantId:draft.id,operationId:randomUUID(),mutation:{type:'restaurant.patch',input:{slug:'paridade-renomeada'}}});
    const publicRestaurant=renamed.state.catalog.restaurant;
    assert.deepEqual(Object.keys(publicRestaurant).filter(key=>/stripe|billing|organization|role|owner|cnpj/i.test(key)),[]);
    assert.equal(await publicCatalog.findPublishedBySlug(draft.slug),null);assert.ok(await publicCatalog.findPublishedBySlug('paridade-renomeada'));
    const webhook=createStripeWebhookRepository(f.pool),intent={organizationId:f.orgA,restaurantId:f.restA,providerEventId:'evt_parity_one',emailKind:'subscription_activated' as const,billingResourceId:'in_parity_one',payload:{planType:'business'}};
    await webhook.enqueueEmail(f.pool,intent);await webhook.enqueueEmail(f.pool,{...intent,restaurantId:f.restB,providerEventId:'evt_parity_two'});
    assert.equal((await f.pool.query('select count(*)::int n from public.billing_email_outbox')).rows[0].n,1);
    assert.equal((await f.pool.query('select count(*)::int as n from (select organization_id,billing_resource_id,email_kind from public.billing_email_outbox group by 1,2,3 having count(*)>1) duplicates')).rows[0].n,0);
  });
});
test('production and preview synthetic fixture SQL seed and clean canonical tenants on local PostgreSQL',async()=>{
  await withTenantFixture(async f=>{
    // Admission URL/identity are synthetic adapters here; only SQL runs on the
    // isolated local pool. Separate script tests exercise the pinned host guards.
    const pool={query:(sql:string,values?:unknown[])=>sql.includes('select current_database() as database, current_user as role')?
      Promise.resolve({rows:[{database:'vapt',role:'neondb_owner'}]}):f.pool.query(sql,values),connect:()=>f.pool.connect(),end:async()=>{}};
    const id=randomUUID(),tag='stage13-realtime-'+id;
    const manifest=[0,1].map(n=>({userId:randomUUID(),restaurantId:randomUUID(),itemId:randomUUID(),tag,slug:tag+'-'+n,email:tag+'-'+n+'@example.invalid'}));
    const {createProductionFixtureDriver}=await import(new URL('../../../scripts/realtime-production-fixtures.mjs',import.meta.url).href);
    const production=await createProductionFixtureDriver({ownerUrl:'postgresql://neondb_owner:synthetic@ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full',manifest,createPool:()=>pool,hash:async()=>'synthetic-password-hash'});
    await production.seed();
    assert.equal((await f.pool.query('select count(*)::int n from public.organization_members where organization_id=any($1::uuid[])',[manifest.map(v=>v.restaurantId)])).rows[0].n,2);
    assert.deepEqual(await production.cleanup(),{rows:0,tablesChecked:15});
    const {createFixtureDriver}=await import(new URL('../../../scripts/realtime-preview-fixtures.mjs',import.meta.url).href);
    const preview=await createFixtureDriver({ownerUrl:'postgresql://neondb_owner:synthetic@ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full',createPool:()=>pool,hash:async()=>'synthetic-password-hash'});
    const seeded=await preview.seed('stage12-'+randomUUID(),{userIds:[],restaurantIds:[]});
    assert.equal((await f.pool.query('select count(*)::int n from public.organization_subscriptions where organization_id=any($1::uuid[])',[seeded.map((v:{restaurantId:string})=>v.restaurantId)])).rows[0].n,2);
    assert.deepEqual(await preview.cleanup(),{rows:0});
    assert.equal((await f.pool.query('select count(*)::int n from public.organizations')).rows[0].n,2,'only baseline fixture organizations remain');
  });
});
