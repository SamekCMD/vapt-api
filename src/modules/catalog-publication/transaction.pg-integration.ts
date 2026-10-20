import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {applyCatalogCommand} from './transaction.js';
import type {CatalogCommand} from './contracts.js';
import {withTenantFixture,type TenantFixture} from '../tenancy/pg-test-support.js';
import {lockRestaurant} from '../tenancy/locks.js';
import {verifyImagePostgresConcurrency} from '../../worker/catalog/image-service.pg-test-support.js';

const command=(f:TenantFixture,input={name:'Catalog Test'}):CatalogCommand=>({
  operationId:randomUUID(),restaurantId:f.restA,actor:f.adminActor,mutation:{type:'restaurant.patch',input},
});
test('real PostgreSQL catalog retries have one journal, mutation and consistent public-only snapshot',async()=>{
  await withTenantFixture(async f=>{
    const input=command(f);
    const outcomes=await Promise.all([1,2,3].map(()=>applyCatalogCommand(f.pool,input)));
    assert.deepEqual(outcomes[1],outcomes[0]);assert.deepEqual(outcomes[2],outcomes[0]);
    assert.equal(outcomes[0].state.catalog.restaurant.name,'Catalog Test');
    assert.equal('cnpj' in outcomes[0].state.catalog.restaurant,false);
    assert.equal('ownerId' in outcomes[0].state.catalog.restaurant,false);
    assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where operation_id=$1',[input.operationId])).rows[0].n,1);
    await assert.rejects(applyCatalogCommand(f.pool,{...input,mutation:{type:'restaurant.patch',input:{name:'Conflict'}}}),{statusCode:409});
  });
});
test('real journal failure rolls back catalog domain and revision',async()=>{
  await withTenantFixture(async f=>{
    const input=command(f);
    await f.pool.query(`alter table public.catalog_publication_operations add constraint synthetic_journal_failure check(operation_id<>'${input.operationId}'::uuid) not valid`);
    await assert.rejects(applyCatalogCommand(f.pool,input));
    assert.equal((await f.pool.query('select name from public.restaurants where id=$1',[f.restA])).rows[0].name,'Restaurante A');
    assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_revisions where restaurant_id=$1',[f.restA])).rows[0].n,0);
    assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where operation_id=$1',[input.operationId])).rows[0].n,0);
  });
});
test('real concurrent item create and delete retries have one durable effect',async()=>{
  await withTenantFixture(async f=>{
    const create:CatalogCommand={...command(f),mutation:{type:'item.create',input:{
      name:'Segundo prato',price:'15.00',description:null,category:'Pratos',available:true,imageUrl:null,
      availableFrom:null,availableUntil:null,badge:null,isChefSuggestion:false,prepTimeMinutes:null,variations:[],
    }}};
    const created=await Promise.all([1,2,3].map(()=>applyCatalogCommand(f.pool,create)));
    assert.deepEqual(created[1],created[0]);assert.deepEqual(created[2],created[0]);
    assert.equal((await f.pool.query('select count(*)::int n from public.menu_items where restaurant_id=$1',[f.restA])).rows[0].n,1);
    const itemId=(created[0].result as {id:string}).id;
    const deletion:CatalogCommand={...command(f),mutation:{type:'item.delete',itemId}};
    const deleted=await Promise.all([1,2,3].map(()=>applyCatalogCommand(f.pool,deletion)));
    assert.deepEqual(deleted[1],deleted[0]);assert.deepEqual(deleted[2],deleted[0]);
    assert.equal((await f.pool.query('select count(*)::int n from public.menu_items where id=$1',[itemId])).rows[0].n,0);
  });
});
test('real UTF8 snapshot larger than8MiB rolls back domain revision and journal',async()=>{
  await withTenantFixture(async f=>{
    const first=await applyCatalogCommand(f.pool,command(f));
    await f.pool.query("update public.restaurants set description=repeat('é',4194304) where id=$1",[f.restA]);
    const input=command(f,{name:'Must not commit'});
    await assert.rejects(applyCatalogCommand(f.pool,input),{code:'catalog_snapshot_too_large'});
    assert.equal((await f.pool.query('select name from public.restaurants where id=$1',[f.restA])).rows[0].name,'Catalog Test');
    assert.equal((await f.pool.query('select version::text from public.catalog_publication_revisions where restaurant_id=$1',[f.restA])).rows[0].version,first.state.version);
    assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where operation_id=$1',[input.operationId])).rows[0].n,0);
  });
});
test('different members competing for slugs serialize without deadlock and reuse advances global revision',async()=>{
  await withTenantFixture(async f=>{
    const slug='claim-'+randomUUID();
    const claims:CatalogCommand[]=[
      {...command(f),actor:f.ownerActor,mutation:{type:'restaurant.patch',input:{slug}}},
      {...command(f),restaurantId:f.restB,mutation:{type:'restaurant.patch',input:{slug}}},
    ];
    const race=await Promise.allSettled(claims.map(value=>applyCatalogCommand(f.pool,value)));
    const winner=race.findIndex(value=>value.status==='fulfilled'),loser=1-winner;
    assert.ok(winner===0||winner===1);assert.equal(race[loser].status,'rejected');
    assert.equal((race[loser] as PromiseRejectedResult).reason.statusCode,409);
    const released=await applyCatalogCommand(f.pool,{...claims[winner],operationId:randomUUID(),mutation:{type:'restaurant.patch',input:{slug:'released-'+randomUUID()}}});
    const reused=await applyCatalogCommand(f.pool,{...claims[loser],operationId:randomUUID()});
    const won=(race[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof applyCatalogCommand>>>).value;
    assert.ok(BigInt(won.state.version)<BigInt(released.state.version));assert.ok(BigInt(released.state.version)<BigInt(reused.state.version));
    assert.equal(reused.state.catalog.restaurant.slug,slug);
  });
});
test('catalog apply checks actual SQL session expiry rather than accepted actor expiry',async()=>{
  await withTenantFixture(async f=>{
    await f.pool.query('update better_auth."session" set "expiresAt"=now()-interval \'1 second\' where id=$1',[f.adminActor.sessionId]);
    await assert.rejects(applyCatalogCommand(f.pool,command(f)),{statusCode:401});
    assert.equal((await f.pool.query('select name from public.restaurants where id=$1',[f.restA])).rows[0].name,'Restaurante A');
  });
});
test('session revocation while an apply waits for the shared restaurant protocol prevents mutation',async()=>{
  await withTenantFixture(async f=>{
    const blocker=await f.pool.connect();
    let pending:Promise<unknown>|undefined,denied:Promise<void>|undefined;
    try{
      await blocker.query('begin');await lockRestaurant(blocker,f.restA);
      pending=applyCatalogCommand(f.pool,command(f));denied=assert.rejects(pending,{statusCode:401});
      let waiting=false;
      for(let i=0;i<200;i++){
        if((await f.pool.query("select 1 from pg_locks where locktype='advisory' and not granted")).rows.length){waiting=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true);
      await f.pool.query('delete from better_auth."session" where id=$1',[f.adminActor.sessionId]);
      await blocker.query('commit');await denied;
      assert.equal((await f.pool.query('select name from public.restaurants where id=$1',[f.restA])).rows[0].name,'Restaurante A');
    }finally{await blocker.query('rollback');blocker.release();await denied;}
  });
});
test('real expired journal cleanup stays bounded and an expired operation can apply anew',async()=>{
  await withTenantFixture(async f=>{
    const first=await applyCatalogCommand(f.pool,command(f));
    await f.pool.query(`insert into public.catalog_publication_operations
      (operation_id,actor_id,restaurant_id,fingerprint,version,snapshot,result,committed_at,expires_at)
      select gen_random_uuid(),$1::uuid,$2::uuid,repeat('a',64),v,
      $3::jsonb||jsonb_build_object('version',v::text),'null'::jsonb,now()-interval '8 days',now()-interval '1 day'
      from(select nextval('public.catalog_publication_version_seq') v from generate_series(1,101)) fixtures`,
    [f.admin,f.restA,JSON.stringify(first.state)]);
    const input=command(f,{name:'Retention Test'}),saved=await applyCatalogCommand(f.pool,input);
    assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where expires_at<=clock_timestamp()')).rows[0].n,1);
    await f.pool.query("update public.catalog_publication_operations set committed_at=now()-interval '8 days',expires_at=now()-interval '1 day' where operation_id=$1",[input.operationId]);
    await f.pool.query("update public.restaurants set name='Intervening fixture' where id=$1",[f.restA]);
    const retried=await applyCatalogCommand(f.pool,input);
    assert.ok(BigInt(retried.state.version)>BigInt(saved.state.version));
    assert.equal(retried.state.catalog.restaurant.name,'Retention Test');
  });
});
test('real image retirement by another member shares apply locks and protects both retained snapshots',async t=>{
  await withTenantFixture(async f=>{
    const base:CatalogCommand={...command(f),restaurantId:f.restB,actor:f.ownerActor,mutation:{type:'rebuild'}};
    await verifyImagePostgresConcurrency(t,f.pool,base,f.adminActor);
  });
});
