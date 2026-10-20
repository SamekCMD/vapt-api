import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRestaurantRepository } from '../restaurants/repository.js';
import { createRestaurantService } from '../restaurants/service.js';
import { createMenuRepository } from '../menu/repository.js';
import { createMenuService } from '../menu/service.js';
import { createMenuItemBodySchema } from '../menu/schemas.js';
import { sqlFile, withTenantFixture } from './pg-test-support.js';
import type { TenantActor } from './contracts.js';

const input = createMenuItemBodySchema.parse({ name:'Prato A',price:'15.00',isChefSuggestion:true,
  description:null,category:'Geral',available:true,imageUrl:null,availableFrom:null,availableUntil:null,badge:null,prepTimeMinutes:null,
  variations:[{ name:'Tamanho',options:['Pequeno','Grande'],required:true }] });

test('updating restaurantA never changes restaurantB of the same owner', async () => {
  await withTenantFixture(async (f) => {
    const restaurants = createRestaurantService(createRestaurantRepository(f.pool));
    await restaurants.updateRestaurant({ ...f.ownerActor,restaurantId:f.restA }, { name:'A novo' });
    assert.equal((await restaurants.getRestaurant({ userId:f.owner,restaurantId:f.restB })).name, 'Restaurante B');
    const a = await restaurants.getRestaurant({ userId:f.owner,restaurantId:f.restA });
    assert.equal(a.name, 'A novo'); assert.equal(a.planType,'business'); assert.equal(a.planStatus,'active');
    assert.equal(Object.hasOwn(a,'stripe_customer_id'),false);
    assert.equal(Object.hasOwn(a,'billing_contact_user_id'),false);
    await f.pool.query(`update public.organization_subscriptions set plan_status='past_due' where organization_id=$1`, [f.orgA]);
    assert.equal((await restaurants.getRestaurant({ userId:f.owner,restaurantId:f.restB })).planStatus,'past_due');
  });
});

test('menu children, chef suggestions and variations stay within the explicit restaurant', async () => {
  await withTenantFixture(async (f) => {
    const menu = createMenuService(createMenuRepository(f.pool), { publicBaseUrl:null });
    await f.pool.query('update public.menu_items set is_chef_suggestion=true where id=$1', [f.itemB]);
    const scopeA = { ...f.ownerActor,restaurantId:f.restA };
    const itemA = await menu.createMenuItem(scopeA,input);
    assert.equal(itemA.restaurantId,f.restA); assert.equal(itemA.variations[0].name,'Tamanho');
    assert.deepEqual((await menu.listMenuItems({ userId:f.staff,restaurantId:f.restA })).map(i=>i.id), [itemA.id]);
    assert.deepEqual((await menu.listMenuItems({ userId:f.owner,restaurantId:f.restB })).map(i=>i.id), [f.itemB]);
    await assert.rejects(menu.updateMenuItem(scopeA,f.itemB,{ price:'99.00',variations:[] }), { statusCode:404 });
    await assert.rejects(menu.deleteMenuItem(scopeA,f.itemB), { statusCode:404 });
    assert.equal((await f.pool.query('select price::text,is_chef_suggestion from public.menu_items where id=$1', [f.itemB])).rows[0].price,'12.00');
    assert.equal((await f.pool.query('select is_chef_suggestion from public.menu_items where id=$1', [f.itemB])).rows[0].is_chef_suggestion,true);
    await menu.updateMenuItem(scopeA,itemA.id,{ name:'Prato A atualizado',variations:[{ name:'Extra',options:['Molho'],required:false }] });
    const updated = (await menu.listMenuItems(scopeA))[0];
    assert.equal(updated.name,'Prato A atualizado'); assert.equal(updated.variations.length,1);
    assert.equal(updated.variations[0].name,'Extra');
    await menu.deleteMenuItem(scopeA,itemA.id);
    assert.deepEqual(await menu.listMenuItems(scopeA),[]);
  });
});

test('manager can manage, staff cannot, and stale sessions cannot perform scoped writes', async () => {
  await withTenantFixture(async (f) => {
    const sessionId = randomUUID(), sessionExpiresAt = Date.now()+60_000;
    await f.pool.query(`insert into better_auth."session" (id,"userId",token,"expiresAt","updatedAt")
      values ($1,$2,$3,$4,now())`, [sessionId,f.manager,randomUUID(),new Date(sessionExpiresAt)]);
    const manager: TenantActor = { userId:f.manager,sessionId,sessionExpiresAt };
    const restaurants = createRestaurantService(createRestaurantRepository(f.pool));
    await restaurants.updateRestaurant({ ...manager,restaurantId:f.restA },{ name:'Manager editou A' });
    await assert.rejects(restaurants.updateRestaurant({ ...f.staffActor,restaurantId:f.restA },{ name:'Não permitido' }),{ statusCode:403 });
    const menu = createMenuService(createMenuRepository(f.pool), { publicBaseUrl:null });
    await assert.rejects(menu.createMenuItem({ ...f.staffActor,restaurantId:f.restA },input), { statusCode:403 });
    await f.pool.query('delete from better_auth."session" where id=$1', [sessionId]);
    await assert.rejects(restaurants.updateRestaurant({ ...manager,restaurantId:f.restA },{ name:'Sessão revogada' }),{ statusCode:401 });
    assert.equal((await restaurants.getRestaurant({ userId:f.owner,restaurantId:f.restA })).name,'Manager editou A');
  });
});

test('legacy adapters reject multiple accessible restaurants even when a preference is stored', async () => {
  await withTenantFixture(async (f) => {
    const restaurants = createRestaurantService(createRestaurantRepository(f.pool));
    await f.pool.query(`insert into public.account_preferences (user_id,organization_id,restaurant_id) values ($1,$2,$3)`, [f.owner,f.orgA,f.restB]);
    await assert.rejects(restaurants.resolveLegacyRestaurant(f.owner), { statusCode:409,code:'restaurant_selection_required' });
    const scope = await restaurants.resolveLegacyRestaurant(f.other);
    assert.deepEqual(scope,{ userId:f.other,restaurantId:f.restOther });
    // Two tabs keep their own captured scope; the account preference is not a write target.
    await Promise.all([
      restaurants.updateRestaurant({ ...f.ownerActor,restaurantId:f.restA },{ name:'A tab' }),
      restaurants.updateRestaurant({ ...f.ownerActor,restaurantId:f.restB },{ name:'B tab' }),
    ]);
    assert.equal((await restaurants.getRestaurant({ userId:f.owner,restaurantId:f.restA })).name,'A tab');
    assert.equal((await restaurants.getRestaurant({ userId:f.owner,restaurantId:f.restB })).name,'B tab');
    await f.pool.query(`update public.organization_members set status='disabled' where user_id=$1 and organization_id=$2`,[f.owner,f.orgA]);
    await assert.rejects(restaurants.getRestaurant({ userId:f.owner,restaurantId:f.restA }),{ statusCode:403 });
  });
});

test('restricted API role can save existing table settings but not organization, owner or plan authority', async () => {
  await withTenantFixture(async (f) => {
    for (const name of ['006_worker_preview_role_grants.sql','009_worker_preview_catalog_grants.sql','010_worker_preview_tenant_grants.sql']) {
      await f.pool.query(await sqlFile(name));
    }
    const client = await f.pool.connect();
    try {
      await client.query('begin'); await client.query('set local role vapt_api_preview');
      const restaurants = createRestaurantService(createRestaurantRepository(f.pool,{ transaction:client }));
      const saved = await restaurants.updateRestaurant({ ...f.ownerActor,restaurantId:f.restA },{ maxTables:20,totalTables:10 });
      assert.equal(saved.maxTables,20); assert.equal(saved.totalTables,10);
      await client.query('commit');
    } finally { await client.query('rollback'); client.release(); }
    assert.equal((await f.pool.query('select max_tables from public.restaurants where id=$1',[f.restB])).rows[0].max_tables,1);
  });
});

test('variation failure rolls back new item and the previous chef suggestion', async()=>{
  await withTenantFixture(async f=>{
    const oldId=randomUUID();
    await f.pool.query(`insert into public.menu_items (id,restaurant_id,name,price,is_chef_suggestion)
      values ($1,$2,'Chef anterior',10,true)`,[oldId,f.restA]);
    const menu=createMenuService(createMenuRepository(f.pool),{ publicBaseUrl:null });
    const invalid={ ...input,variations:[{ name:null as unknown as string,options:['Normal'],required:false }] };
    await assert.rejects(menu.createMenuItem({ ...f.ownerActor,restaurantId:f.restA },invalid),{ statusCode:500 });
    const items=(await f.pool.query('select id,is_chef_suggestion from public.menu_items where restaurant_id=$1',[f.restA])).rows;
    assert.deepEqual(items,[{ id:oldId,is_chef_suggestion:true }]);
  });
});
