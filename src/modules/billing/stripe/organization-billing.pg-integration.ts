import assert from 'node:assert/strict';
import test from 'node:test';
import type {Database} from '../../../lib/database.js';
import type {OrganizationScope} from '../../tenancy/contracts.js';
import {withTenantFixture,withLocalDatabase,withBaselineDatabase,seedUser,applyTenantMigration,sqlFile} from '../../tenancy/pg-test-support.js';
import {randomUUID} from 'node:crypto';
import {createStripeBillingRepository,bindBillingResource,resolveBillingOrganization} from './repository.js';
import {createStripeBillingService} from './service.js';
import {createStripeWebhookRepository} from './webhook-repository.js';
import {createStripeWebhookService} from './webhook-service.js';
import {seedRestaurant} from '../../tenancy/pg-test-support.js';
import type {StripeGateway,StripeCustomer,StripeCheckoutSession,StripeSubscription} from './types.js';

test('restaurants in the same organization share one SaaS customer and subscription',async()=>{
  await withTenantFixture(async f=>{
    const repository=createStripeBillingRepository(f.pool) as unknown as {
      getScope(scope:OrganizationScope):Promise<{organizationId:string;billingContactUserId:string;stripeCustomerId:string|null;stripeSubscriptionId:string|null}>;
    };
    const scope=await repository.getScope({userId:f.admin,organizationId:f.orgA});
    assert.equal(scope.organizationId,f.orgA);assert.equal(scope.billingContactUserId,f.owner);
    assert.equal(scope.stripeCustomerId,null);assert.equal(scope.stripeSubscriptionId,null);
    assert.equal((await f.pool.query('select count(*)::int n from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows[0].n,1);
    assert.equal((await f.pool.query('select count(*)::int n from public.restaurants where organization_id=$1',[f.orgA])).rows[0].n,2);
  });
});

test('admin checkout across two restaurants creates one organization Customer and reuses one pending Checkout',async()=>{
  await withTenantFixture(async f=>{
    let customer:StripeCustomer|null=null,checkout:StripeCheckoutSession|null=null,customers=0,checkouts=0;
    const gateway:StripeGateway={
      async findCustomers(organizationId){assert.equal(organizationId,f.orgA);return customer?[customer]:[];},
      async getCustomer(id){assert.equal(id,customer?.id);return customer!;},
      async createCustomer(input,key){
        assert.equal(input.email,`${f.owner}@example.invalid`);assert.equal(input.metadata.vapt_organization_id,f.orgA);
        assert.equal(input.metadata.vapt_billing_contact_user_id,f.owner);assert.ok(key.includes(f.orgA));
        customers++;return customer={id:'cus_organization',livemode:false,metadata:input.metadata};
      },
      async getCheckout(id){assert.equal(id,checkout?.id);return checkout!;},
      async createCheckout(input,key){
        assert.equal(input.customerId,customer?.id);assert.equal(input.clientReferenceId,f.orgA);assert.ok(key.includes(f.orgA));
        checkouts++;return checkout={id:'cs_test_organization',livemode:false,metadata:input.metadata,customerId:input.customerId,
          subscriptionId:null,status:'open',clientReferenceId:input.clientReferenceId,url:'https://checkout.stripe.com/c/pay/synthetic',expiresAt:new Date(Date.now()+60_000).toISOString()};
      },
      async createPortal(){throw new Error('portal not used');},async getSubscription(){throw new Error('subscription not used');},
    };
    const repository=createStripeBillingRepository(f.pool);
    const config={frontendUrl:new URL('https://app.example.invalid'),stripe:{secretKey:'synthetic',webhookSecret:'synthetic',webhookToleranceSeconds:300,
      environment:'test' as const,portalConfigurationId:'synthetic',prices:{starter:'price_starter',pro:'price_pro',business:'price_business'}}};
    const service=createStripeBillingService(gateway,repository,config);
    const input={...f.adminActor,organizationId:f.orgA,restaurantId:f.restA,email:'actor-must-not-be-contact@example.invalid',planType:'pro' as const,idempotencyKey:randomUUID()};
    const secondInput={...input,restaurantId:f.restB,idempotencyKey:randomUUID()};
    const [first,second]=await Promise.all([service.createCheckout(input),service.createCheckout(secondInput)]);
    assert.deepEqual(second,first);assert.equal(customers,1);assert.equal(checkouts,1);
    const scope=await repository.getScope({userId:f.admin,organizationId:f.orgA});
    assert.equal(scope.stripeCustomerId,'cus_organization');assert.equal(scope.billingContactUserId,f.owner);
    await assert.rejects(service.createCheckout({...input,...f.staffActor}),{statusCode:403});
  });
});

const webhookConfig={secretKey:'synthetic',webhookSecret:'synthetic',environment:'test' as const,webhookToleranceSeconds:300,
  portalConfigurationId:'synthetic',prices:{starter:'price_starter',pro:'price_pro',business:'price_business'}};
function subscriptionEvent(eventId:string,metadata:Record<string,string>,customer='cus_events',subscription='sub_events'){
  return {id:eventId,type:'invoice.paid',livemode:false,created:1,data:{object:{id:'in_same',object:'invoice',customer,
    billing_reason:'subscription_cycle',parent:{subscription_details:{subscription,metadata}}}}};
}
function webhookFixture(pool:Parameters<typeof createStripeWebhookRepository>[0],organizationId:string,contact:string){
  const metadata={vapt_organization_id:organizationId,vapt_billing_contact_user_id:contact};
  const subscription:StripeSubscription={id:'sub_events',customerId:'cus_events',livemode:false,metadata,status:'active',
    trialEndsAt:null,cancelAtPeriodEnd:false,canceledAt:null,
    items:[{id:'si_events',priceId:'price_business',recurring:true,currentPeriodEnd:'2030-01-01T00:00:00Z'}]};
  const gateway={async getSubscription(id:string){assert.equal(id,'sub_events');return subscription;}} as unknown as StripeGateway;
  return {metadata,subscription,service:createStripeWebhookService(webhookConfig,createStripeWebhookRepository(pool),gateway)};
}
test('organization webhook reconciles 25 restaurants once and keeps replay and out-of-order events idempotent',async()=>{
  await withTenantFixture(async f=>{
    for(let i=2;i<25;i++)await seedRestaurant(f.pool,f.orgA,f.owner);
    const w=webhookFixture(f.pool,f.orgA,f.owner);
    const first=subscriptionEvent('evt_first',w.metadata);
    first.created=200;
    assert.equal((await w.service.handleEvent(first)).ignored,false);
    assert.equal((await w.service.handleEvent(first)).duplicate,true);
    // A different delayed invoice event still reads the provider's current state.
    w.subscription.status='past_due';
    await w.service.handleEvent(subscriptionEvent('evt_older',w.metadata));
    assert.deepEqual((await f.pool.query('select plan_type,plan_status,stripe_customer_id,stripe_subscription_id from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows,
      [{plan_type:'business',plan_status:'past_due',stripe_customer_id:'cus_events',stripe_subscription_id:'sub_events'}]);
    assert.equal((await f.pool.query('select count(*)::int n from public.restaurants where organization_id=$1',[f.orgA])).rows[0].n,25);
    assert.equal((await f.pool.query('select count(*)::int n from public.billing_email_outbox where organization_id=$1',[f.orgA])).rows[0].n,1);
    assert.deepEqual((await f.pool.query('select distinct organization_id from public.billing_provider_events')).rows,[{organization_id:f.orgA}]);
  });
});
test('cross-organization Stripe resources cannot reconcile or enqueue and remain retryable',async()=>{
  await withTenantFixture(async f=>{
    await bindBillingResource(f.pool,f.orgB,'cus_events','customer');
    const w=webhookFixture(f.pool,f.orgA,f.owner);
    await assert.rejects(w.service.handleEvent(subscriptionEvent('evt_cross',w.metadata)),{code:'billing_processing_failed'});
    assert.equal((await f.pool.query('select count(*)::int n from public.billing_email_outbox')).rows[0].n,0);
    assert.equal((await f.pool.query("select processing_status from public.billing_provider_events where provider_event_id='evt_cross'")).rows[0].processing_status,'pending_retry');
    assert.equal((await f.pool.query('select stripe_customer_id from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows[0].stripe_customer_id,null);
  });
});

test('different restaurant origins and provider event retries still emit one organization resource intent',async()=>{
  await withTenantFixture(async f=>{
    const repository=createStripeWebhookRepository(f.pool);
    const input={organizationId:f.orgA,restaurantId:f.restA,providerEventId:'evt_intentfirst',emailKind:'subscription_activated' as const,
      billingResourceId:'in_shared_org',payload:{planType:'pro'}};
    await repository.enqueueEmail(f.pool,input);
    const original=(await f.pool.query('select id,payload,provider_event_id from public.billing_email_outbox')).rows[0];
    await repository.enqueueEmail(f.pool,{...input,restaurantId:f.restB,providerEventId:'evt_intentsecond'});
    await repository.enqueueEmail(f.pool,input);
    assert.deepEqual((await f.pool.query('select id,payload,provider_event_id from public.billing_email_outbox where organization_id=$1',[f.orgA])).rows,[original]);
  });
});
test('billing selector agreement, manager read-only, revoked creator and expired session are enforced',async()=>{
  await withTenantFixture(async f=>{
    const repo=createStripeBillingRepository(f.pool);
    assert.equal((await repo.getPublicStatus({userId:f.manager,organizationId:f.orgA})).canStartCheckout,false);
    await assert.rejects(resolveBillingOrganization(f.pool,{userId:f.admin,organizationId:f.orgB,restaurantId:f.restA},'billing.read'),{code:'billing_scope_conflict'});
    await assert.rejects(repo.withBillingLock({...f.adminActor,userId:f.manager,organizationId:f.orgA},async()=>{}),{statusCode:403});
    await f.pool.query("update public.organization_members set status='disabled' where organization_id=$1 and user_id=$2",[f.orgA,f.owner]);
    await assert.rejects(repo.getPublicStatus({userId:f.owner,organizationId:f.orgA}),{statusCode:403});
    await f.pool.query('delete from better_auth."session" where id=$1',[f.adminActor.sessionId]);
    await assert.rejects(repo.withBillingLock({...f.adminActor,organizationId:f.orgA},async()=>{}),{statusCode:401});
  });
});
test('legacy webhook validates the immutable original pair instead of the current actor or creator',async()=>{
  await withBaselineDatabase(async pool=>{
    const owner=await seedUser(pool),restaurant=randomUUID();
    await pool.query(`insert into public.restaurants(id,owner_id,name,slug,plan_type,plan_status,stripe_customer_id,stripe_subscription_id)
      values($1,$2,'Old Stripe','old-stripe','business','active','cus_events','sub_events')`,[restaurant,owner]);
    await applyTenantMigration(pool,'010');await applyTenantMigration(pool,'011');
    const org=(await pool.query('select organization_id from public.restaurants where id=$1',[restaurant])).rows[0].organization_id;
    const legacy={vapt_restaurant_id:restaurant,vapt_owner_id:owner};
    const w=webhookFixture(pool,org,owner);Object.assign(w.subscription,{metadata:legacy});
    assert.equal((await w.service.handleEvent(subscriptionEvent('evt_legacyold',legacy))).ignored,false);
    await assert.rejects(w.service.handleEvent(subscriptionEvent('evt_legacywrong',{...legacy,vapt_owner_id:randomUUID()})),{code:'billing_processing_failed'});
    assert.equal((await pool.query('select count(*)::int n from public.billing_email_outbox where organization_id=$1',[org])).rows[0].n,1);
  });
});

test('organization billing migration supplies immutable legacy resource mapping and organization-scoped event/outbox identity',async()=>{
  await withLocalDatabase(async pool=>{
    assert.notEqual((await pool.query("select to_regclass('public.organization_billing_legacy_resources')::text name")).rows[0].name,null);
    for(const table of ['billing_provider_events','billing_email_outbox']){
      assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name=$1 and column_name='organization_id'",[table])).rows[0].n,1);
    }
  });
});

test('011 backfill preserves legacy Stripe origin and frozen outbox identity claims and recipient',async()=>{
  await withBaselineDatabase(async pool=>{
    const owner=await seedUser(pool),restaurantId=randomUUID(),outboxId=randomUUID();
    await pool.query(`insert into public.restaurants(id,owner_id,name,slug,plan_type,plan_status,stripe_customer_id,stripe_subscription_id)
      values($1,$2,'Legacy billing','legacy-billing','business','active','cus_legacy','sub_legacy')`,[restaurantId,owner]);
    await pool.query(`insert into public.billing_provider_events(provider,provider_event_id,event_type,restaurant_id,stripe_customer_id,stripe_subscription_id,payload,processing_status,attempt_count,processing_started_at)
      values('stripe','evt_legacy','invoice.paid',$1,'cus_legacy','sub_legacy','{}','processing',2,now())`,[restaurantId]);
    await pool.query(`insert into public.billing_email_outbox(id,restaurant_id,provider_event_id,email_kind,billing_resource_id,payload,
      delivery_status,attempt_count,processing_started_at,first_send_attempt_at,recipient_email,template_alias,template_variables)
      values($1,$2,'evt_legacy','subscription_renewed','in_legacy','{}','processing',3,now(),now(),'frozen@example.invalid','legacy-template','{"planName":"Business"}')`,[outboxId,restaurantId]);
    const before=(await pool.query('select * from public.billing_email_outbox where id=$1',[outboxId])).rows[0];
    await applyTenantMigration(pool,'010');await applyTenantMigration(pool,'011');
    const org=(await pool.query('select organization_id from public.restaurants where id=$1',[restaurantId])).rows[0].organization_id;
    const after=(await pool.query('select * from public.billing_email_outbox where id=$1',[outboxId])).rows[0];
    const {organization_id,...unchanged}=after;assert.equal(organization_id,org);assert.deepEqual(unchanged,before);
    const mapped=(await pool.query(`select resource_id,organization_id,restaurant_id,legacy_owner_id from public.organization_billing_legacy_resources order by resource_id`)).rows;
    assert.deepEqual(mapped,[{resource_id:'cus_legacy',organization_id:org,restaurant_id:restaurantId,legacy_owner_id:owner},
      {resource_id:'sub_legacy',organization_id:org,restaurant_id:restaurantId,legacy_owner_id:owner}]);
    const event=(await pool.query("select organization_id,attempt_count,processing_status from public.billing_provider_events where provider_event_id='evt_legacy'")).rows[0];
    assert.deepEqual(event,{organization_id:org,attempt_count:2,processing_status:'processing'});
    await assert.rejects(pool.query("update public.organization_billing_legacy_resources set legacy_owner_id=$1 where resource_id='cus_legacy'",[owner]),{code:'23514'});
    await assert.rejects(pool.query("delete from public.organization_billing_legacy_resources where resource_id='cus_legacy'"),{code:'23514'});
  });
});

test('011 rejects conflicting event resource associations atomically without discarding claims',async()=>{
  await withBaselineDatabase(async pool=>{
    const users=[await seedUser(pool),await seedUser(pool)],restaurants=[randomUUID(),randomUUID()];
    for(let i=0;i<2;i++) await pool.query(`insert into public.restaurants(id,owner_id,name,slug,plan_type,plan_status,stripe_customer_id)
      values($1,$2,'Conflict fixture',$3,'business','active',$4)`,[restaurants[i],users[i],'conflict-'+i,'cus_conflict'+i]);
    await pool.query(`insert into public.billing_provider_events(provider,provider_event_id,event_type,restaurant_id,stripe_customer_id,payload)
      values('stripe','evt_conflict','invoice.paid',$1,'cus_conflict1','{}')`,[restaurants[0]]);
    await applyTenantMigration(pool,'010');
    await assert.rejects(applyTenantMigration(pool,'011'),/conflict/i);
    assert.equal((await pool.query("select to_regclass('public.organization_billing_legacy_resources')::text name")).rows[0].name,null);
    assert.equal((await pool.query("select count(*)::int n from public.billing_provider_events where provider_event_id='evt_conflict'")).rows[0].n,1);
    assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='billing_email_outbox' and column_name='organization_id'")).rows[0].n,0);
  });
});

test('011 rejects a stored event whose compact payload contradicts its Customer column',async()=>{
  await withBaselineDatabase(async pool=>{
    const first=await seedUser(pool),second=await seedUser(pool),restaurant=randomUUID();
    for(const [owner,id,slug,customer] of [[first,restaurant,'payload-first','cus_payloadA'],[second,randomUUID(),'payload-second','cus_payloadB']]){
      await pool.query(`insert into public.restaurants(id,owner_id,name,slug,plan_type,plan_status,stripe_customer_id)
        values($1,$2,'Payload conflict',$3,'business','active',$4)`,[id,owner,slug,customer]);
    }
    await pool.query(`insert into public.billing_provider_events(provider,provider_event_id,event_type,restaurant_id,stripe_customer_id,payload)
      values('stripe','evt_payloadconflict','invoice.paid',$1,'cus_payloadA','{"customerId":"cus_payloadB"}')`,[restaurant]);
    await applyTenantMigration(pool,'010');
    await assert.rejects(applyTenantMigration(pool,'011'),/conflict/i);
    assert.equal((await pool.query("select count(*)::int n from public.billing_provider_events where provider_event_id='evt_payloadconflict'")).rows[0].n,1);
  });
});

const reconciliationSql=`select public.reconcile_organization_subscription($1::uuid,$2::text,$3::integer,
  $4::text,$5::text,$6::text,$7::text,$8::text,$9::timestamptz,$10::timestamptz,$11::boolean,
  $12::timestamptz,$13::timestamptz,$14::text,$15::text) applied`;
test('organization subscription writes require an active matching event claim and retain trial history',async()=>{
  await withTenantFixture(async f=>{
    await bindBillingResource(f.pool,f.orgA,'cus_claimed','customer');await bindBillingResource(f.pool,f.orgA,'sub_claimed','subscription');
    const args=[f.orgA,'evt_claimed',1,'cus_claimed','sub_claimed','si_claimed','business','active',null,
      '2030-01-01T00:00:00Z',false,null,new Date().toISOString(),null,null];
    await assert.rejects(f.pool.query(reconciliationSql,args),{code:'42501'});
    await f.pool.query(`insert into public.billing_provider_events(provider,provider_event_id,event_type,payload,organization_id,processing_status,attempt_count,processing_started_at)
      values('stripe','evt_claimed','invoice.paid','{}',$1,'processing',1,now())`,[f.orgA]);
    await f.pool.query(`update public.organization_subscriptions set trial_started_at=now()-interval '4 days',trial_ends_at=now()-interval '1 day' where organization_id=$1`,[f.orgA]);
    const trial=(await f.pool.query('select trial_started_at,trial_ends_at from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows[0];
    assert.equal((await f.pool.query(reconciliationSql,args)).rows[0].applied,true);
    assert.deepEqual((await f.pool.query('select trial_started_at,trial_ends_at from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows[0],trial);
    await assert.rejects(f.pool.query(reconciliationSql,[f.orgB,...args.slice(1)]),{code:'42501'});
    await f.pool.query("update public.billing_provider_events set processing_status='processed' where provider_event_id='evt_claimed'");
    await assert.rejects(f.pool.query(reconciliationSql,args),{code:'42501'});
  });
});

for(const environment of ['preview','production'] as const){
  test(`${environment} billing grants allow scoped checkout and claimed reconciliation but deny direct entitlement and registry changes`,async()=>{
    await withTenantFixture(async f=>{
      await f.pool.query(await sqlFile(environment==='preview'?'006_worker_preview_role_grants.sql':'007_worker_production_role_grants.sql'));
      await f.pool.query(await sqlFile(`010_worker_${environment}_tenant_grants.sql`));
      await f.pool.query(await sqlFile(`011_worker_${environment}_billing_grants.sql`));
      const client=await f.pool.connect();
      try{
        await client.query(`set role vapt_api_${environment}`);
        await assert.rejects(client.query("update public.organization_subscriptions set plan_type='business' where organization_id=$1",[f.orgA]),{code:'42501'});
        await assert.rejects(client.query('update public.organization_subscriptions set billing_contact_user_id=$1 where organization_id=$2',[f.admin,f.orgA]),{code:'42501'});
        await assert.rejects(client.query('delete from public.organization_billing_resources'),{code:'42501'});
        await assert.rejects(client.query("insert into public.organization_billing_legacy_resources(resource_id,resource_type,organization_id,restaurant_id,legacy_owner_id) values('cus_illegal','customer',$1,$2,$3)",[f.orgA,f.restA,f.owner]),{code:'42501'});
        const restricted={query:client.query.bind(client),connect:async()=>({query:client.query.bind(client),release(){}})} as unknown as Database;
        const repository=createStripeBillingRepository(restricted);
        assert.equal((await repository.getPublicStatus({userId:f.manager,organizationId:f.orgA})).canManageBilling,false);
        await repository.withBillingLock({...f.adminActor,organizationId:f.orgA},async lock=>{
          await lock.associateCustomer('cus_restricted');
          await lock.savePendingCheckout({id:'cs_test_restricted',planType:'business',expiresAt:'2030-01-01T00:00:00Z'});
        });
        await bindBillingResource(client,f.orgA,'sub_restricted','subscription');
        const args=[f.orgA,'evt_restricted',1,'cus_restricted','sub_restricted','si_restricted','business','active',null,'2030-01-01',false,null,new Date().toISOString(),null,null];
        await assert.rejects(client.query(reconciliationSql,args),{code:'42501'});
        await client.query(`insert into public.billing_provider_events(provider,provider_event_id,event_type,payload,organization_id,processing_status,attempt_count,processing_started_at)
          values('stripe','evt_restricted','invoice.paid','{}',$1,'processing',1,now())`,[f.orgA]);
        assert.equal((await client.query(reconciliationSql,args)).rows[0].applied,true);
        await assert.rejects(client.query('update public.billing_provider_events set organization_id=$1 where provider_event_id=$2',[f.orgB,'evt_restricted']),{code:'23514'});
      }finally{await client.query('reset role');client.release();}
      await f.pool.query(await sqlFile('verify-organization-billing.sql'));
    });
  });
}
