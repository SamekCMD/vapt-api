import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {withTenantFixture,withLocalDatabase,seedUser,sqlFile} from '../tenancy/pg-test-support.js';
import type {Database} from '../../lib/database.js';
import {applyCatalogCommand} from '../catalog-publication/transaction.js';
import type {CatalogCommand} from '../catalog-publication/contracts.js';
import {createAccountRepository} from '../account/repository.js';
import {createAccountService} from '../account/service.js';
import {createOnboardingRepository} from './repository.js';
import {createCatalogRepository} from '../catalog/repository.js';

test('staff bootstrap supplies operation features without private billing fields in PostgreSQL',async()=>{
  await withTenantFixture(async f=>{
    const service=createAccountService(createAccountRepository(f.pool));
    const bootstrap=await service.getBootstrap(f.staff,f.restB);
    assert.equal(bootstrap.currentRestaurantId,f.restB);assert.equal(bootstrap.organizations[0].features.cashier,true);
    assert.deepEqual(Object.keys(bootstrap.organizations[0]).sort(),['capabilities','features','id','name','operationActive','role']);
    assert.equal(bootstrap.organizations[0].operationActive,true);
    await f.pool.query("update public.organization_subscriptions set plan_type='starter',plan_status='active' where organization_id=$1",[f.orgA]);
    const starter=(await service.getBootstrap(f.staff,f.restB)).organizations[0];
    assert.equal(starter.operationActive,true);assert.equal(Object.values(starter.features).some(Boolean),false);
    await f.pool.query("update public.organization_subscriptions set plan_status='expired' where organization_id=$1",[f.orgA]);
    assert.equal((await service.getBootstrap(f.staff,f.restB)).organizations[0].operationActive,false);
    await assert.rejects(service.getBootstrap(f.staff,f.restOther),{statusCode:403});
    await assert.rejects(service.savePreference(f.staffActor,{organizationId:f.orgA,restaurantId:f.restOther}),{statusCode:403});
    await service.savePreference(f.staffActor,{organizationId:f.orgA,restaurantId:f.restA});
    assert.equal((await service.getBootstrap(f.staff)).currentRestaurantId,f.restA);
    await f.pool.query("update public.organization_members set status='disabled' where organization_id=$1 and user_id=$2",[f.orgA,f.staff]);
    assert.equal((await service.getBootstrap(f.staff)).currentRestaurantId,null);
    await assert.rejects(service.savePreference(f.staffActor,{organizationId:f.orgA,restaurantId:f.restA}),{statusCode:403});
  });
});
test('first onboarding draft resumes across clients and finalizes once with a single server-side three-day trial',async()=>{
  await withLocalDatabase(async pool=>{
    const userId=await seedUser(pool),sessionId=randomUUID(),sessionExpiresAt=Date.now()+3_600_000;
    await pool.query('insert into better_auth."session"(id,"userId","expiresAt",token,"updatedAt") values($1,$2,$3,$4,now())',
      [sessionId,userId,new Date(sessionExpiresAt),randomUUID()]);
    const actor={userId,sessionId,sessionExpiresAt},repository=createOnboardingRepository(pool),key=randomUUID();
    const input={name:'Restaurante Inicial',slug:'restaurante-inicial'};
    const [first,retry]=await Promise.all([repository.createInitialDraft(actor,key,input),repository.createInitialDraft(actor,key,input)]);
    assert.equal(first.id,retry.id);assert.equal(first.onboardingStep,0);
    assert.equal((await pool.query('select count(*)::int n from public.organizations')).rows[0].n,1);
    assert.equal((await pool.query('select trial_started_at from public.organization_subscriptions')).rows[0].trial_started_at,null);
    assert.equal(await createCatalogRepository(pool).findPublishedBySlug(input.slug),null);
    const secondClient=createOnboardingRepository(pool);
    await secondClient.saveDraft(actor,first.id,{localEnabled:true,deliveryEnabled:false,totalTables:4,onboardingStep:2});
    assert.equal((await repository.getDraft({userId,restaurantId:first.id})).totalTables,4);
    const finishKey=randomUUID(),completed=await repository.finalizeDraft(actor,first.id,finishKey);
    assert.equal(completed.onboardingCompleted,true);
    const trial=(await pool.query('select trial_started_at,trial_ends_at from public.organization_subscriptions')).rows[0];
    assert.equal(trial.trial_ends_at.getTime()-trial.trial_started_at.getTime(),3*24*60*60_000);
    assert.equal((await secondClient.finalizeDraft(actor,first.id,finishKey)).id,completed.id);
    assert.deepEqual((await pool.query('select trial_started_at,trial_ends_at from public.organization_subscriptions')).rows[0],trial);
    assert.equal((await pool.query('select count(*)::int n from public.menu_items')).rows[0].n,0);
    assert.deepEqual(await repository.getActivation({userId,restaurantId:first.id}),{cashier:false,menu:false,kitchen:false,settings:false,overview:false});
    assert.ok(await createCatalogRepository(pool).findPublishedBySlug(input.slug));
    await assert.rejects(repository.createInitialDraft(actor,randomUUID(),{...input,slug:'new-trial-bypass'}),{statusCode:409});
    await assert.rejects(repository.createInitialDraft(actor,key,{...input,name:'Different fingerprint'}),{statusCode:409});
  });
});
test('activation is per restaurant, staff can operate and cannot finalize a draft',async()=>{
  await withTenantFixture(async f=>{
    const repository=createOnboardingRepository(f.pool);
    await repository.completeActivation({...f.staffActor,restaurantId:f.restA},'kitchen');
    await repository.completeActivation({...f.staffActor,restaurantId:f.restA},'kitchen');
    assert.equal((await repository.getActivation({userId:f.staff,restaurantId:f.restA})).kitchen,true);
    assert.equal((await repository.getActivation({userId:f.staff,restaurantId:f.restB})).kitchen,false);
    await assert.rejects(repository.finalizeDraft(f.staffActor,f.restA,randomUUID()),{statusCode:403});
    await assert.rejects(repository.completeActivation({...f.staffActor,restaurantId:f.restOther},'kitchen'),{statusCode:403});
  });
});

test('Business draft creation and concurrent finalization never restart a trial or use historical ownership as authority',async()=>{
  await withTenantFixture(async f=>{
    const repository=createOnboardingRepository(f.pool),key=randomUUID();
    const input={name:'Novo B',slug:'novo-b'};
    const one=await repository.createOrganizationDraft(f.adminActor,f.orgA,key,input);
    assert.equal((await repository.createOrganizationDraft(f.adminActor,f.orgA,key,input)).id,one.id);
    await assert.rejects(repository.createOrganizationDraft(f.adminActor,f.orgA,key,{...input,slug:'fingerprint-other'}),{statusCode:409});
    const two=await repository.createOrganizationDraft(f.adminActor,f.orgA,randomUUID(),{name:'Novo C',slug:'novo-c'});
    await assert.rejects(repository.createOrganizationDraft(f.staffActor,f.orgA,randomUUID(),{name:'Denied',slug:'denied'}),{statusCode:403});
    for(const restaurant of [one,two])await repository.saveDraft(f.adminActor,restaurant.id,{onboardingStep:2});
    await Promise.all([repository.finalizeDraft(f.adminActor,one.id,randomUUID()),repository.finalizeDraft(f.adminActor,two.id,randomUUID())]);
    const subscription=(await f.pool.query('select trial_started_at,trial_ends_at,billing_contact_user_id from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows[0];
    assert.deepEqual(subscription,{trial_started_at:null,trial_ends_at:null,billing_contact_user_id:f.owner});
    assert.equal((await f.pool.query('select count(*)::int n from public.restaurants where organization_id=$1',[f.orgA])).rows[0].n,4);
    await f.pool.query("update public.organization_members set status='disabled' where organization_id=$1 and user_id=$2",[f.orgA,f.admin]);
    await assert.rejects(repository.createOrganizationDraft(f.adminActor,f.orgA,key,input),{statusCode:403});
  });
});

test('expired captured actor metadata cannot start a new draft even when the database session was extended',async()=>{
  await withTenantFixture(async f=>{
    const repository=createOnboardingRepository(f.pool),actor={...f.adminActor,sessionExpiresAt:Date.now()-1};
    await assert.rejects(repository.createInitialDraft(actor,randomUUID(),{name:'Expired',slug:'expired-initial'}),{statusCode:401});
    await assert.rejects(repository.createOrganizationDraft(actor,f.orgA,randomUUID(),{name:'Expired',slug:'expired-organization'}),{statusCode:401});
  });
});

test('canonical draft slug conflicts are safe409 and roll back a newly provisioned organization and owner membership',async()=>{
  await withTenantFixture(async f=>{
    const repository=createOnboardingRepository(f.pool),slug=(await f.pool.query('select slug from public.restaurants where id=$1',[f.restA])).rows[0].slug;
    const userId=await seedUser(f.pool),sessionId=randomUUID(),sessionExpiresAt=Date.now()+3_600_000;
    await f.pool.query('insert into better_auth."session"(id,"userId","expiresAt",token,"updatedAt") values($1,$2,$3,$4,now())',[sessionId,userId,new Date(sessionExpiresAt),randomUUID()]);
    const before=(await f.pool.query('select count(*)::int n from public.organizations')).rows[0].n;
    await assert.rejects(repository.createInitialDraft({userId,sessionId,sessionExpiresAt},randomUUID(),{name:'Collision',slug}),{statusCode:409});
    assert.equal((await f.pool.query('select count(*)::int n from public.organizations')).rows[0].n,before);
    assert.equal((await f.pool.query('select count(*)::int n from public.organization_members where user_id=$1',[userId])).rows[0].n,0);
    await assert.rejects(repository.createOrganizationDraft(f.adminActor,f.orgA,randomUUID(),{name:'Collision',slug}),{statusCode:409});
    assert.equal((await f.pool.query('select count(*)::int n from public.restaurants where organization_id=$1',[f.orgA])).rows[0].n,2);
  });
});

test('a late finalize failure rolls back trial and journal; retry completes without overwriting a newer preference',async()=>{
  await withLocalDatabase(async pool=>{
    const userId=await seedUser(pool),sessionId=randomUUID(),sessionExpiresAt=Date.now()+3_600_000;
    await pool.query('insert into better_auth."session"(id,"userId","expiresAt",token,"updatedAt") values($1,$2,$3,$4,now())',[sessionId,userId,new Date(sessionExpiresAt),randomUUID()]);
    const actor={userId,sessionId,sessionExpiresAt},repository=createOnboardingRepository(pool);
    const draft=await repository.createInitialDraft(actor,randomUUID(),{name:'Rollback',slug:'rollback-draft'});
    await repository.saveDraft(actor,draft.id,{onboardingStep:2});
    await pool.query(`alter table public.restaurants add constraint synthetic_finalize_failure check(id<>'${draft.id}'::uuid or onboarding_status<>'complete') not valid`);
    const key=randomUUID();await assert.rejects(repository.finalizeDraft(actor,draft.id,key));
    assert.equal((await pool.query('select trial_started_at from public.organization_subscriptions')).rows[0].trial_started_at,null);
    assert.equal((await pool.query("select count(*)::int n from public.onboarding_intents where kind='finalize'")).rows[0].n,0);
    assert.equal((await repository.getDraft({userId,restaurantId:draft.id})).onboardingStep,2);
    await pool.query('alter table public.restaurants drop constraint synthetic_finalize_failure');
    await repository.finalizeDraft(actor,draft.id,key);
    await pool.query('update public.account_preferences set organization_id=null,restaurant_id=null where user_id=$1',[userId]);
    await repository.finalizeDraft(actor,draft.id,key);
    assert.equal((await pool.query('select restaurant_id from public.account_preferences where user_id=$1',[userId])).rows[0].restaurant_id,null);
    await pool.query('delete from better_auth."session" where id=$1',[sessionId]);
    await assert.rejects(repository.finalizeDraft(actor,draft.id,key),{statusCode:401});
  });
});

test('public order creation cannot bypass a draft hidden from the public catalog',async()=>{
  await withTenantFixture(async f=>{
    const repository=createOnboardingRepository(f.pool);
    const draft=await repository.createOrganizationDraft(f.adminActor,f.orgA,randomUUID(),{name:'Hidden Draft',slug:'hidden-draft'});
    const item=randomUUID();await f.pool.query("insert into public.menu_items(id,restaurant_id,name,price) values($1,$2,'Prato',12)",[item,draft.id]);
    const create=()=>f.pool.query(`select * from public.create_public_order_v3($1,'local',1,$2::jsonb,null,$3,$4,$5)`,
      [draft.slug,JSON.stringify([{menuItemId:item,quantity:1}]),'synthetic-token-hash','synthetic-draft-order','synthetic-fingerprint']);
    await assert.rejects(create(),/restaurant_not_found/);
    assert.equal((await f.pool.query('select count(*)::int n from public.orders where restaurant_id=$1',[draft.id])).rows[0].n,0);
    await repository.saveDraft(f.adminActor,draft.id,{onboardingStep:2});
    await repository.finalizeDraft(f.adminActor,draft.id,randomUUID());
    assert.equal((await create()).rows[0].restaurant_id,draft.id);
  });
});

test('canonical onboarding finalization is atomic with its public catalog journal and projection',async()=>{
  await withTenantFixture(async f=>{
    const repository=createOnboardingRepository(f.pool),draft=await repository.createOrganizationDraft(f.adminActor,f.orgA,randomUUID(),{name:'Catalog Draft',slug:'catalog-draft'});
    await repository.saveDraft(f.adminActor,draft.id,{onboardingStep:2});
    const input={operationId:randomUUID(),restaurantId:draft.id,actor:f.adminActor,
      mutation:{type:'onboarding.finalize',input:{restaurantId:draft.id}}} as unknown as CatalogCommand;
    await f.pool.query(`alter table public.catalog_publication_operations add constraint synthetic_finalize_journal check(operation_id<>'${input.operationId}'::uuid) not valid`);
    await assert.rejects(applyCatalogCommand(f.pool,input));
    assert.equal((await f.pool.query('select onboarding_completed from public.restaurants where id=$1',[draft.id])).rows[0].onboarding_completed,false);
    await f.pool.query('alter table public.catalog_publication_operations drop constraint synthetic_finalize_journal');
    const [one,two]=await Promise.all([applyCatalogCommand(f.pool,input),applyCatalogCommand(f.pool,input)]);
    assert.deepEqual(one,two);assert.equal((one.result as {onboardingCompleted:boolean}).onboardingCompleted,true);
    assert.equal(one.state.catalog.restaurant.id,draft.id);assert.equal(one.state.catalog.items.length,0);
    assert.doesNotMatch(JSON.stringify(one.state),/billingContact|organizationId|stripeCustomer/);
    assert.equal((await f.pool.query("select count(*)::int n from public.onboarding_intents where operation_id=$1 and kind='finalize'",[input.operationId])).rows[0].n,1);
    const sequence=(await f.pool.query('select last_value::text value from public.catalog_publication_version_seq')).rows[0].value;
    const retry=await applyCatalogCommand(f.pool,{...input,operationId:randomUUID()});
    assert.equal(retry.receipt.version,one.receipt.version,'a new browser must not publish the already completed onboarding again');
    assert.deepEqual(retry.state,one.state);
    assert.equal((await f.pool.query('select last_value::text value from public.catalog_publication_version_seq')).rows[0].value,sequence);
    assert.equal((await f.pool.query("select count(*)::int n from public.onboarding_intents where restaurant_id=$1 and kind='finalize'",[draft.id])).rows[0].n,2,'each operation keeps its audit identity without another trial or revision');
  });
});
test('a restaurant completed before catalog activation still receives its first snapshot once',async()=>{
  await withTenantFixture(async f=>{
    const repository=createOnboardingRepository(f.pool),draft=await repository.createOrganizationDraft(f.adminActor,f.orgA,randomUUID(),{name:'Previously Complete',slug:'previously-complete'});
    await repository.saveDraft(f.adminActor,draft.id,{onboardingStep:2});await repository.finalizeDraft(f.adminActor,draft.id,randomUUID());
    const input={operationId:randomUUID(),restaurantId:draft.id,actor:f.adminActor,mutation:{type:'onboarding.finalize',input:{restaurantId:draft.id}}} as CatalogCommand;
    const first=await applyCatalogCommand(f.pool,input);assert.ok(first.receipt.version);assert.equal(first.state.catalog.restaurant.id,draft.id);
    assert.equal((await applyCatalogCommand(f.pool,{...input,operationId:randomUUID()})).receipt.version,first.receipt.version);
  });
});
test('integrity diagnostics do not turn the stable billing contact into a membership authorization requirement',async()=>{
  await withTenantFixture(async f=>{
    await f.pool.query("update public.organization_members set role='owner' where organization_id=$1 and user_id=$2",[f.orgA,f.admin]);
    await f.pool.query("update public.organization_members set role='staff' where organization_id=$1 and user_id=$2",[f.orgA,f.owner]);
    await f.pool.query(await sqlFile('verify-tenant-foundation.sql'));
    assert.equal((await f.pool.query('select billing_contact_user_id from public.organization_subscriptions where organization_id=$1',[f.orgA])).rows[0].billing_contact_user_id,f.owner);
  });
});
for(const environment of ['preview','production'] as const){
  test(`${environment} onboarding grants expose narrow routines but no completion trial or membership writes`,async()=>{
    await withLocalDatabase(async pool=>{
      const userId=await seedUser(pool),sessionId=randomUUID(),sessionExpiresAt=Date.now()+3_600_000;
      await pool.query('insert into better_auth."session"(id,"userId","expiresAt",token,"updatedAt") values($1,$2,$3,$4,now())',[sessionId,userId,new Date(sessionExpiresAt),randomUUID()]);
      await pool.query(await sqlFile(environment==='preview'?'006_worker_preview_role_grants.sql':'007_worker_production_role_grants.sql'));
      await pool.query(await sqlFile(`010_worker_${environment}_tenant_grants.sql`));
      await pool.query(await sqlFile(`011_worker_${environment}_billing_grants.sql`));
      await pool.query(await sqlFile(`012_worker_${environment}_onboarding_grants.sql`));
      const client=await pool.connect();
      try{
        await client.query(`set role vapt_api_${environment}`);
        const restricted={query:client.query.bind(client),connect:async()=>({query:client.query.bind(client),release(){}})} as unknown as Database;
        const repository=createOnboardingRepository(restricted),actor={userId,sessionId,sessionExpiresAt};
        const draft=await repository.createInitialDraft(actor,randomUUID(),{name:'Restricted Draft',slug:'restricted-draft'});
        await assert.rejects(client.query("update public.organization_members set role='owner'"),{code:'42501'});
        await assert.rejects(client.query("update public.organization_subscriptions set trial_ends_at=now()+interval '30 days'"),{code:'42501'});
        await assert.rejects(client.query("update public.restaurants set onboarding_status='complete',onboarding_completed=true"),{code:'42501'});
        await repository.saveDraft(actor,draft.id,{onboardingStep:2,totalTables:3});
        assert.equal((await repository.finalizeDraft(actor,draft.id,randomUUID())).onboardingCompleted,true);
        await assert.rejects(client.query('select public.assert_onboarding_session($1,$2)',[userId,sessionId]),{code:'42501'});
      }finally{await client.query('reset role');client.release();}
    });
  });
}
