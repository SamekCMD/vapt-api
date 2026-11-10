// Only imported by explicit *.pg-integration.ts tests; never loads app environment.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg, { type Pool } from 'pg';

function localConfig() {
  const raw = process.env.TENANT_TEST_DATABASE_URL;
  const root = process.env.TENANT_SCHEMA_ROOT;
  if (!raw || !root) throw new Error('Run test:tenant-pg; isolated local test configuration is required');
  const url = new URL(raw);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || !url.port ||
    url.username !== 'vapt_tenant_admin' || url.pathname !== '/postgres' ||
    !/^[a-f0-9]{64}$/.test(url.password) ||
    !/^-c vapt\.tenant_test_through=(009|010|011|012)$/.test(url.searchParams.get('options') ?? '')) {
    throw new Error('Refusing non-isolated PostgreSQL test configuration');
  }
  return { url, root, through: url.searchParams.get('options')!.slice(-3) };
}

export async function sqlFile(name: string) {
  if (!/^[a-z0-9_-]+\.sql$/.test(name)) throw new Error('Invalid migration name');
  return readFile(resolve(localConfig().root, 'infra/neon', name), 'utf8');
}
export const selectedTenantStage = () => localConfig().through;
const baseline = ['001_business_schema.sql', '002_business_routines.sql', '003_better_auth_schema.sql',
  '004_business_constraints.sql', '005_stripe_billing.sql', '006_billing_email_delivery.sql',
  '009_public_catalog_publication.sql'];
const afterBaseline = [
  ['010', '010_tenant_foundation.sql'], ['011', '011_organization_billing.sql'], ['012', '012_tenant_onboarding.sql'],
] as const;
export async function applyTenantMigration(pool: Pool, stage: '010' | '011' | '012' = '010') {
  const entry = afterBaseline.find(([n]) => n === stage)!;
  const client = await pool.connect();
  try { await client.query(await sqlFile(entry[1])); }
  catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

let serial: Promise<void> = Promise.resolve();
async function database(work: (pool: Pool) => Promise<void>, onlyBaseline: boolean) {
  const config = localConfig();
  const previous = serial;
  let done!: () => void;
  serial = new Promise<void>((ok) => { done = ok; });
  await previous;
  const admin = new pg.Client({ connectionString: config.url.href });
  let created = false;
  let pool: Pool | undefined;
  try {
    await admin.connect();
    await admin.query('create database vapt');
    created = true;
    const testUrl = new URL(config.url.href); testUrl.pathname = '/vapt';
    pool = new pg.Pool({ connectionString: testUrl.href, max: 10,
      connectionTimeoutMillis:5_000, statement_timeout:10_000, lock_timeout:5_000,
      idle_in_transaction_session_timeout:15_000 });
    for (const name of baseline) await pool.query(await sqlFile(name));
    if (!onlyBaseline) {
      for (const [stage] of afterBaseline) {
        if (stage <= config.through) await applyTenantMigration(pool, stage);
      }
    }
    await work(pool);
  } finally {
    await pool?.end();
    // Only the known database created by THIS callback in the isolated local cluster.
    if (created) await admin.query('drop database vapt');
    await admin.end(); done();
  }
}
export const withLocalDatabase = (work: (pool: Pool) => Promise<void>): Promise<void> => database(work, false);
export const withBaselineDatabase = (work: (pool: Pool) => Promise<void>): Promise<void> => database(work, true);

type FixtureActor = { userId: string; sessionId: string; sessionExpiresAt: number };
export type TenantFixture = {
  pool: Pool;
  owner: string; admin: string; manager: string; staff: string; other: string;
  orgA: string; orgB: string; restA: string; restB: string; restOther: string;
  itemB: string; orderB: string; sessionB: string;
  ownerActor: FixtureActor; adminActor: FixtureActor; staffActor: FixtureActor;
};
export async function seedUser(pool: Pool, id = randomUUID()) {
  await pool.query(`insert into better_auth."user" (id,name,email,"emailVerified") values ($1,'Teste',$2,true)`,
    [id, `${id}@example.invalid`]);
  return id;
}
export async function seedOrganization(pool: Pool, owner: string, plan = 'business', status = 'active') {
  const id = randomUUID();
  await pool.query('insert into public.organizations (id,name,created_by) values ($1,$2,$3)', [id, 'Organização teste', owner]);
  await pool.query(`insert into public.organization_members (organization_id,user_id,role,status)
    values ($1,$2,'owner','active')`, [id, owner]);
  await pool.query(`insert into public.organization_subscriptions
    (organization_id,billing_contact_user_id,plan_type,plan_status) values ($1,$2,$3,$4)`, [id, owner, plan, status]);
  return id;
}
export async function seedRestaurant(pool: Pool, org: string, owner: string, name = 'Restaurante teste') {
  const id = randomUUID();
  await pool.query(`insert into public.restaurants (id,organization_id,owner_id,name,slug) values ($1,$2,$3,$4,$5)`,
    [id, org, owner, name, `teste-${id}`]);
  return id;
}
export async function withTenantFixture(work: (f: TenantFixture) => Promise<void>): Promise<void> {
  await withLocalDatabase(async (pool) => {
    const owner = await seedUser(pool), admin = await seedUser(pool), manager = await seedUser(pool);
    const staff = await seedUser(pool), other = await seedUser(pool);
    const orgA = await seedOrganization(pool, owner), orgB = await seedOrganization(pool, other);
    for (const [id, role] of [[admin, 'admin'], [manager, 'manager'], [staff, 'staff']]) {
      await pool.query(`insert into public.organization_members (organization_id,user_id,role,status)
        values ($1,$2,$3,'active')`, [orgA, id, role]);
    }
    const restA = await seedRestaurant(pool, orgA, owner, 'Restaurante A');
    const restB = await seedRestaurant(pool, orgA, owner, 'Restaurante B');
    const restOther = await seedRestaurant(pool, orgB, other, 'Restaurante Outro');
    // Operational/catalog fixtures represent completed restaurants; seedRestaurant itself remains a draft for capacity/onboarding tests.
    await pool.query(`update public.restaurants set onboarding_status='complete',onboarding_completed=true,onboarding_step=2
      where id=any($1::uuid[])`,[[restA,restB,restOther]]);
    const itemB = randomUUID(), orderB = randomUUID(), sessionB = randomUUID();
    await pool.query(`insert into public.menu_items (id,restaurant_id,name,price) values ($1,$2,'Prato B',12)`, [itemB, restB]);
    await pool.query(`insert into public.table_sessions (id,restaurant_id,table_number) values ($1,$2,'1')`, [sessionB, restB]);
    await pool.query(`insert into public.orders (id,restaurant_id,table_session_id,total_price) values ($1,$2,$3,12)`, [orderB, restB, sessionB]);
    async function actor(userId: string): Promise<FixtureActor> {
      const sessionId = randomUUID(), sessionExpiresAt = Date.now() + 3_600_000;
      await pool.query(`insert into better_auth."session" (id,"userId","expiresAt",token,"updatedAt")
        values ($1,$2,$3,$4,now())`, [sessionId, userId, new Date(sessionExpiresAt), randomUUID()]);
      return { userId, sessionId, sessionExpiresAt };
    }
    await work({ pool, owner, admin, manager, staff, other, orgA, orgB, restA, restB, restOther, itemB, orderB, sessionB,
      ownerActor: await actor(owner), adminActor: await actor(admin), staffActor: await actor(staff) });
  });
}
