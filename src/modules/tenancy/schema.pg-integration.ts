import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applyTenantMigration, seedOrganization, seedRestaurant, seedUser, selectedTenantStage, sqlFile,
  withBaselineDatabase, withLocalDatabase, withTenantFixture } from './pg-test-support.js';

// Removing010 or changing its identity mapping must break this probe/backfill test.
test('tenant foundation is absent before010 and preserves existing identities after migration', async () => {
  await withLocalDatabase(async (pool) => {
    assert.equal((await pool.query("select to_regclass('public.organizations') is not null as ok")).rows[0].ok, true);
  });
});

// --through009 deliberately runs only the real missing-schema probe above (RED).
if (selectedTenantStage() !== '009') {
  test('backfill preserves restaurant, auth, billing and completed onboarding without invented activation', async () => {
    await withBaselineDatabase(async (pool) => {
      const user = await seedUser(pool), rest = randomUUID(), item = randomUUID();
      await pool.query(`insert into public.restaurants
        (id,owner_id,name,slug,plan_type,plan_status,stripe_customer_id,stripe_subscription_id,
         stripe_subscription_item_id,stripe_current_period_end,stripe_cancel_at_period_end,stripe_state_updated_at,
         stripe_checkout_session_id,stripe_checkout_plan_type,stripe_checkout_expires_at,
         trial_ends_at,onboarding_completed,onboarding_completed_at)
        values ($1,$2,'Legado','legado','business','active','cus_test_1','sub_test_1','si_test_1',
          '2027-01-01',true,'2026-10-18','cs_test_1','business','2026-10-21','2026-10-22',true,'2026-10-19')`, [rest, user]);
      await pool.query(`insert into public.menu_items (id,restaurant_id,name,price) values ($1,$2,'Prato',10)`, [item, rest]);
      const legacy = (await pool.query('select * from public.restaurants where id=$1', [rest])).rows[0];
      await applyTenantMigration(pool);
      const current = (await pool.query('select * from public.restaurants where id=$1', [rest])).rows[0];
      assert.equal(current.owner_id, user); assert.equal(current.id, rest);
      assert.equal(current.onboarding_status, 'complete'); assert.equal(current.onboarding_step, 2);
      assert.equal(current.onboarding_completed_at.toISOString(), '2026-10-19T00:00:00.000Z');
      assert.equal((await pool.query('select restaurant_id from public.menu_items where id=$1', [item])).rows[0].restaurant_id, rest);
      const member = (await pool.query('select user_id,role,status from public.organization_members where organization_id=$1', [current.organization_id])).rows;
      assert.deepEqual(member, [{ user_id: user, role: 'owner', status: 'active' }]);
      const subscription = (await pool.query('select * from public.organization_subscriptions where organization_id=$1', [current.organization_id])).rows[0];
      for (const field of ['plan_type', 'plan_status', 'stripe_customer_id', 'stripe_subscription_id',
        'stripe_subscription_item_id', 'stripe_cancel_at_period_end', 'stripe_checkout_session_id', 'stripe_checkout_plan_type']) {
        assert.equal(subscription[field], legacy[field]);
      }
      for (const field of ['stripe_current_period_end', 'stripe_state_updated_at', 'stripe_checkout_expires_at', 'trial_ends_at']) {
        assert.equal(subscription[field].toISOString(), legacy[field].toISOString());
      }
      assert.equal(subscription.trial_started_at.toISOString(), '2026-10-19T00:00:00.000Z');
      assert.equal(subscription.billing_contact_user_id, user);
      assert.equal((await pool.query('select count(*)::int as n from public.restaurant_activation_progress')).rows[0].n, 0);
      assert.equal((await pool.query('select count(*)::int as n from public.account_preferences')).rows[0].n, 0);
      await pool.query(await sqlFile('verify-tenant-foundation.sql'));
    });
  });

  for (const invalid of ['orphan', 'billing conflict', 'invalid plan', 'over limit']) {
    test(`migration rolls back all changes for ${invalid}`, async () => {
      await withBaselineDatabase(async (pool) => {
        const owner = invalid === 'orphan' ? randomUUID() : await seedUser(pool);
        const id = randomUUID();
        await pool.query(`insert into public.restaurants (id,owner_id,name,slug,plan_type,plan_status,stripe_customer_id)
          values ($1::uuid,$2,'Legado',$1::uuid::text,$3,'active','cus_original')`, [id, owner, invalid === 'invalid plan' ? 'unknown' : 'starter']);
        if (invalid === 'billing conflict' || invalid === 'over limit') {
          // An inconsistent legacy snapshot must fail closed, not pick an arbitrary subscription.
          await pool.query('drop index public.restaurants_owner_id_unique');
          await pool.query('drop index public.restaurants_stripe_customer_uidx');
          await pool.query(`insert into public.restaurants (owner_id,name,slug,plan_type,plan_status,stripe_customer_id)
            values ($1,'Outro','outro','starter','active',$2)`, [owner, invalid === 'billing conflict' ? 'cus_conflict' : 'cus_original']);
        }
        await assert.rejects(applyTenantMigration(pool), (e: unknown) =>
          e instanceof Error && /tenant foundation/.test(e.message));
        assert.equal((await pool.query("select to_regclass('public.organizations') is null as absent")).rows[0].absent, true);
        assert.equal((await pool.query(`select count(*)::int as n from information_schema.columns
          where table_schema='public' and table_name='restaurants' and column_name='organization_id'`)).rows[0].n, 0);
        assert.equal((await pool.query('select stripe_customer_id from public.restaurants where id=$1', [id])).rows[0].stripe_customer_id, 'cus_original');
      });
    });
  }

  for (const [plan, status, limit] of [
    ['starter', 'active', 1], ['pro', 'active', 1], ['business', 'active', 25], ['business', 'trialing', 1],
  ] as const) {
    test(`${plan}/${status} counts drafts and enforces the organization limit ${limit}`, async () => {
      await withLocalDatabase(async (pool) => {
        const owner = await seedUser(pool), org = await seedOrganization(pool, owner, plan, status);
        for (let i = 0; i < limit; i++) await seedRestaurant(pool, org, owner);
        await assert.rejects(seedRestaurant(pool, org, owner), { code: '23514', constraint: 'organization_restaurant_limit' });
        assert.equal((await pool.query('select count(*)::int as n from public.restaurants where organization_id=$1', [org])).rows[0].n, limit);
        assert.equal((await pool.query('select trial_started_at from public.organization_subscriptions where organization_id=$1', [org])).rows[0].trial_started_at, null);
      });
    });
  }

  test('a late backfill constraint failure rolls back DDL and preserves the legacy owner index', async () => {
    await withBaselineDatabase(async (pool) => {
      const owner = await seedUser(pool);
      //001 permits an empty name, but the canonical organization contract does not.
      await pool.query(`insert into public.restaurants (owner_id,name,slug) values ($1,'','legacy-empty')`, [owner]);
      await assert.rejects(applyTenantMigration(pool), { code: '23514', constraint: 'organizations_name_check' });
      assert.equal((await pool.query("select to_regclass('public.organizations') is null as absent")).rows[0].absent, true);
      assert.equal((await pool.query("select to_regclass('public.restaurants_owner_id_unique') is not null as kept")).rows[0].kept, true);
      assert.equal((await pool.query(`select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='restaurants' and column_name='organization_id'`)).rows[0].n, 0);
    });
  });

  test('two concurrent creates cannot both take the final Business slot', async () => {
    await withLocalDatabase(async (pool) => {
      const owner = await seedUser(pool), org = await seedOrganization(pool, owner);
      for (let i = 0; i < 24; i++) await seedRestaurant(pool, org, owner);
      const a = await pool.connect(), b = await pool.connect();
      try {
        const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
        await a.query('begin'); await b.query('begin');
        await a.query(`insert into public.restaurants (owner_id,organization_id,name,slug) values ($1,$2,'A','last-a')`, [owner, org]);
        const pending = b.query(`insert into public.restaurants (owner_id,organization_id,name,slug) values ($1,$2,'B','last-b')`, [owner, org]);
        // Attach the failure assertion before commit; no timing-dependent unhandled rejection.
        const rejected = assert.rejects(pending, { code: '23514', constraint: 'organization_restaurant_limit' });
        let blocked = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          blocked = (await pool.query(`select exists (select 1 from pg_catalog.pg_locks
            where pid=$1 and locktype='advisory' and not granted) as blocked`, [bPid])).rows[0].blocked;
          if (blocked) break;
          await new Promise((ok) => setTimeout(ok, 10));
        }
        assert.equal(blocked, true, 'second create must wait on the organization capacity lock');
        await a.query('commit'); await rejected; await b.query('rollback');
        assert.equal((await pool.query('select count(*)::int as n from public.restaurants where organization_id=$1', [org])).rows[0].n, 25);
      } finally { await a.query('rollback'); await b.query('rollback'); a.release(); b.release(); }
    });
  });

  test('downgrade preserves existing restaurants but blocks new ones; organizations have independent entitlements', async () => {
    await withTenantFixture(async (f) => {
      await f.pool.query(`update public.organization_subscriptions set plan_type='starter' where organization_id=$1`, [f.orgA]);
      assert.equal((await f.pool.query('select count(*)::int as n from public.restaurants where organization_id=$1', [f.orgA])).rows[0].n, 2);
      await assert.rejects(seedRestaurant(f.pool, f.orgA, f.owner), { code: '23514' });
      const another = await seedOrganization(f.pool, f.owner, 'pro');
      await seedRestaurant(f.pool, another, f.owner);
      await assert.rejects(seedRestaurant(f.pool, another, f.owner), { code: '23514' });
      await assert.rejects(f.pool.query('update public.restaurants set organization_id=$1 where id=$2', [f.orgB, f.restA]),
        { code: '23514', constraint: 'restaurant_organization_immutable' });
      await assert.rejects(f.pool.query(`insert into public.account_preferences (user_id,organization_id,restaurant_id)
        values ($1,$2,$3)`, [f.owner, f.orgA, f.restOther]), { code: '23503' });
    });
  });

  for (const role of ['preview', 'production'] as const) {
    test(`${role} grants deny membership escalation, tenant reparenting, plan changes and DDL`, async () => {
      await withTenantFixture(async (f) => {
        const { pool } = f;
        await pool.query(await sqlFile(role === 'preview' ? '006_worker_preview_role_grants.sql' : '007_worker_production_role_grants.sql'));
        await pool.query(await sqlFile(`009_worker_${role}_catalog_grants.sql`));
        await pool.query(await sqlFile(`010_worker_${role}_tenant_grants.sql`));
        const client = await pool.connect();
        async function denied(sql: string, values: unknown[] = []) {
          await assert.rejects(client.query(sql, values), { code: '42501' });
        }
        try {
          await client.query(`set role vapt_api_${role}`);
          assert.equal((await client.query('select role from public.organization_members where user_id=$1', [f.staff])).rows[0].role, 'staff');
          await denied(`update public.organization_members set role='owner' where user_id=$1`, [f.staff]);
          await denied(`insert into public.organization_members (organization_id,user_id,role) values ($1,$2,'owner')`, [f.orgB, f.staff]);
          await denied('delete from public.organization_members where user_id=$1', [f.staff]);
          await denied(`update public.organization_subscriptions set plan_type='business' where organization_id=$1`, [f.orgA]);
          await denied(`update public.restaurants set plan_type='business' where id=$1`, [f.restA]);
          await denied('update public.restaurants set organization_id=$1 where id=$2', [f.orgB, f.restA]);
          await denied('update public.restaurants set owner_id=$1 where id=$2', [f.staff, f.restA]);
          await denied(`insert into public.restaurants (owner_id,organization_id,name,slug) values ($1,$2,'X','bypass')`, [f.staff, f.orgB]);
          await denied(`insert into public.organizations (name,created_by) values ('Bypass',$1)`, [f.staff]);
          await denied('create table public.tenant_escalation (id int)');
          await denied('create role tenant_escalation');
          await denied('alter table public.organization_members disable trigger all');
          await client.query('update public.restaurants set name=$1 where id=$2', ['Operação permitida', f.restA]);
          assert.equal((await client.query('select name from public.restaurants where id=$1', [f.restB])).rows[0].name, 'Restaurante B');
        } finally { await client.query('reset role'); client.release(); }
      });
    });
  }
}
