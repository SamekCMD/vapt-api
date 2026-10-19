import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { authorizeOrganization, authorizeRestaurant, assertLiveSession } from './authorization.js';
import { lockOrganization, lockRestaurant, lockOperation, lockSlugs } from './locks.js';
import { withTenantFixture } from './pg-test-support.js';

async function waitForAdvisoryBlock(pool: Pool, pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = (await pool.query(`select exists(select 1 from pg_catalog.pg_locks
      where pid=$1 and locktype='advisory' and not granted) as blocked`, [pid])).rows[0];
    if (row.blocked) return;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  assert.fail('Expected the competing transaction to block on an advisory lock');
}

test('revoked membership cannot authorize a subsequent restaurant mutation', async () => {
  await withTenantFixture(async (f) => {
    const a = await f.pool.connect(), b = await f.pool.connect();
    try {
      const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
      await a.query('begin'); await b.query('begin');
      await lockOrganization(a, f.orgA, 'shared'); await lockRestaurant(a, f.restA);
      await authorizeRestaurant(a, { userId:f.admin, restaurantId:f.restA }, 'restaurant.manage');
      await assertLiveSession(a, f.adminActor);
      await a.query('update public.restaurants set name=$1 where id=$2', ['Aceito antes da revogação', f.restA]);
      const revokeLock = lockOrganization(b, f.orgA, 'exclusive');
      await waitForAdvisoryBlock(f.pool, bPid);
      await a.query('commit'); await revokeLock;
      await b.query(`update public.organization_members set status='disabled' where organization_id=$1 and user_id=$2`, [f.orgA,f.admin]);
      await b.query('commit');
      await a.query('begin'); await lockOrganization(a, f.orgA, 'shared'); await lockRestaurant(a, f.restA);
      await assert.rejects(authorizeRestaurant(a, { userId:f.admin, restaurantId:f.restA }, 'restaurant.manage'), { statusCode:403 });
      assert.equal((await a.query('select name from public.restaurants where id=$1', [f.restA])).rows[0].name, 'Aceito antes da revogação');
    } finally { await a.query('rollback'); await b.query('rollback'); a.release(); b.release(); }
  });
});

test('active roles authorize only their capabilities; inactive, cross-organization and historical owner access is denied', async () => {
  await withTenantFixture(async (f) => {
    for (const [userId, role] of [[f.owner,'owner'],[f.admin,'admin'],[f.manager,'manager'],[f.staff,'staff']]) {
      assert.deepEqual(await authorizeRestaurant(f.pool, { userId, restaurantId:f.restA }, 'restaurant.read'),
        { userId, restaurantId:f.restA, organizationId:f.orgA, role });
    }
    await authorizeRestaurant(f.pool, { userId:f.manager, restaurantId:f.restB }, 'restaurant.manage');
    await assert.rejects(authorizeRestaurant(f.pool, { userId:f.staff, restaurantId:f.restA }, 'restaurant.manage'), { statusCode:403 });
    await assert.rejects(authorizeOrganization(f.pool, { userId:f.manager, organizationId:f.orgA }, 'billing.manage'), { statusCode:403 });
    await assert.rejects(authorizeRestaurant(f.pool, { userId:f.owner, restaurantId:f.restOther }, 'restaurant.read'), { statusCode:403 });
    await f.pool.query(`insert into public.organization_members (organization_id,user_id,role) values ($1,$2,'manager')`, [f.orgB,f.owner]);
    assert.equal((await authorizeRestaurant(f.pool, { userId:f.owner, restaurantId:f.restOther }, 'restaurant.read')).organizationId, f.orgB);
    await assert.rejects(authorizeRestaurant(f.pool, { userId:f.staff, restaurantId:f.restOther }, 'restaurant.read'), { statusCode:403 });
    for (const status of ['invited','disabled']) {
      await f.pool.query('update public.organization_members set status=$1 where organization_id=$2 and user_id=$3', [status,f.orgA,f.owner]);
      await assert.rejects(authorizeRestaurant(f.pool, { userId:f.owner, restaurantId:f.restA }, 'restaurant.read'), { statusCode:403, message:'Forbidden' });
    }
    await f.pool.query('delete from public.organization_members where organization_id=$1 and user_id=$2', [f.orgA,f.owner]);
    await assert.rejects(authorizeRestaurant(f.pool, { userId:f.owner, restaurantId:f.restA }, 'restaurant.read'), { statusCode:403 });
  });
});

test('live session checks reject revoked, expired or mismatched sessions even with an active membership', async () => {
  await withTenantFixture(async (f) => {
    const client = await f.pool.connect();
    try {
      await client.query('begin');
      await assertLiveSession(client, f.ownerActor);
      await assert.rejects(assertLiveSession(client, { ...f.ownerActor, userId:f.admin }), { statusCode:401 });
      await client.query(`update better_auth."session" set "expiresAt"=now()-interval '1 second' where id=$1`, [f.ownerActor.sessionId]);
      await assert.rejects(assertLiveSession(client, f.ownerActor), { statusCode:401 });
      await client.query('delete from better_auth."session" where id=$1', [f.adminActor.sessionId]);
      await assert.rejects(assertLiveSession(client, f.adminActor), { statusCode:401 });
      await client.query('commit');
    } finally { await client.query('rollback'); client.release(); }
  });
});

test('two different members serialize the same restaurant but different restaurants share the organization lock', async () => {
  await withTenantFixture(async (f) => {
    const a = await f.pool.connect(), b = await f.pool.connect();
    try {
      const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
      await a.query('begin'); await b.query('begin');
      await b.query("set local lock_timeout='2s'");
      await lockOrganization(a, f.orgA, 'shared'); await lockRestaurant(a, f.restA);
      await authorizeRestaurant(a, { userId:f.owner, restaurantId:f.restA }, 'restaurant.manage');
      await lockOrganization(b, f.orgA, 'shared'); await lockRestaurant(b, f.restB);
      await authorizeRestaurant(b, { userId:f.admin, restaurantId:f.restB }, 'restaurant.manage');
      await b.query('commit'); await b.query('begin');
      await lockOrganization(b, f.orgA, 'shared');
      const sameRestaurant = lockRestaurant(b, f.restA);
      await waitForAdvisoryBlock(f.pool, bPid); await a.query('commit'); await sameRestaurant;
      await authorizeRestaurant(b, { userId:f.admin, restaurantId:f.restA }, 'restaurant.manage');
      await b.query('commit');
    } finally { await a.query('rollback'); await b.query('rollback'); a.release(); b.release(); }
  });
});

test('operation keys serialize independently of actors and slug lock sets are distinct and ordered', async () => {
  await withTenantFixture(async (f) => {
    const a = await f.pool.connect(), b = await f.pool.connect();
    try {
      const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
      await a.query('begin'); await b.query('begin');
      await lockOperation(a, f.itemB);
      const replay = lockOperation(b, f.itemB);
      await waitForAdvisoryBlock(f.pool, bPid); await a.query('commit'); await replay;
      await lockSlugs(b, ['z-slug','a-slug','z-slug']);
      const held = (await b.query(`select count(*)::int as n from pg_catalog.pg_locks
        where pid=pg_backend_pid() and locktype='advisory' and granted`)).rows[0].n;
      assert.equal(held, 3); // one operation + two distinct slugs
      await b.query('commit');
    } finally { await a.query('rollback'); await b.query('rollback'); a.release(); b.release(); }
  });
});
