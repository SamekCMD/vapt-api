// Production-only synthetic fixtures. Operator code, never Worker code.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const require = condition => { if (!condition) throw Error('Production fixture guard failed'); };
export async function createProductionFixtureDriver({ ownerUrl, manifest, createPool = options => new Pool(options), hash = hashPassword } = {}) {
  require(Array.isArray(manifest) && manifest.length === 2);
  const owned = manifest.map((owner, index) => {
    require(owner && Object.keys(owner).sort().join(',') === 'email,itemId,restaurantId,slug,tag,userId' &&
      [owner.userId, owner.restaurantId, owner.itemId].every(value => typeof value === 'string' && uuid.test(value)) &&
      /^stage13-realtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.tag) &&
      owner.slug === owner.tag + '-' + index && owner.email === owner.slug + '@example.invalid');
    return { ...owner };
  });
  require(owned[0].tag === owned[1].tag && new Set(owned.flatMap(v => [v.userId, v.restaurantId, v.itemId])).size === 6);
  if (!ownerUrl) {
    require(typeof process.env.NEON_CLI_PATH === 'string' && process.env.NEON_CLI_PATH.length > 0);
    try {
      const result = await exec(process.execPath, [process.env.NEON_CLI_PATH, 'connection-string', 'br-odd-term-b6j2n9ms',
        '--project-id', 'dawn-morning-27332079', '--role-name', 'neondb_owner', '--database-name', 'vapt', '--ssl', 'verify-full'],
      { timeout: 30000, maxBuffer: 65536, env: { ...process.env, NO_UPDATE_NOTIFIER: '1' } });
      ownerUrl = result.stdout.trim(); result.stdout = ''; result.stderr = '';
    } catch { throw Error('Existing Neon authentication required'); }
  }
  let target;
  try { target = new URL(ownerUrl); } catch { throw Error('Production fixture target failed'); }
  require(['postgres:', 'postgresql:'].includes(target.protocol) && target.hostname === 'ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech' &&
    target.pathname === '/vapt' && target.username === 'neondb_owner' && ['','5432'].includes(target.port) && target.searchParams.get('sslmode') === 'verify-full');
  target = undefined;
  const pool = createPool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 10000 }); ownerUrl = undefined;
  try {
    const identity = (await pool.query('select current_database() as database, current_user as role')).rows[0];
    require(identity?.database === 'vapt' && identity.role === 'neondb_owner');
  } catch { await pool.end(); throw Error('Production fixture identity failed'); }
  let attempted = false;
  const readIdentity = async (client, owner) => ({
    users: (await client.query('SELECT id,name,email FROM better_auth."user" WHERE id=$1 OR email=$2', [owner.userId, owner.email])).rows,
    restaurants: (await client.query('SELECT id,owner_id,name,slug FROM public.restaurants WHERE id=$1 OR slug=$2', [owner.restaurantId, owner.slug])).rows,
  });
  return {
    identifiers() { return owned.map(v => ({ ...v })); },
    async seed() {
      require(!attempted); attempted = true;
      const owners = owned.map(owner => ({ ...owner, password: randomBytes(32).toString('base64url') }));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const owner of owned) { const identity = await readIdentity(client, owner); require(identity.users.length === 0 && identity.restaurants.length === 0); }
        for (const owner of owners) {
          await client.query('INSERT INTO better_auth."user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)', [owner.userId, owner.tag, owner.email]);
          await client.query('INSERT INTO better_auth.account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES (gen_random_uuid(),$1::text,\'credential\',$1::uuid,$2,now(),now())', [owner.userId, await hash(owner.password)]);
          await client.query(`INSERT INTO public.restaurants (id,owner_id,name,slug,plan_type,plan_status,onboarding_completed,total_tables,max_tables,max_pending_orders,payment_mode)
            VALUES ($1,$2,$3,$4,'pro','active',true,2,2,10,'open_tab')`, [owner.restaurantId, owner.userId, owner.tag, owner.slug]);
          await client.query(`INSERT INTO public.menu_items (id,restaurant_id,name,price,category,available) VALUES ($1,$2,'Item Teste Realtime',12.00,'Teste',true)`, [owner.itemId, owner.restaurantId]);
        }
        await client.query('COMMIT'); return owners;
      } catch { await client.query('ROLLBACK'); throw Error('Production fixture seed failed'); }
      finally { client.release(); }
    },
    async cleanup() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const owner of owned) {
          const identity = await readIdentity(client, owner);
          require(identity.users.length <= 1 && identity.restaurants.length <= 1 &&
            identity.users.every(v => v.id === owner.userId && v.name === owner.tag && v.email === owner.email) &&
            identity.restaurants.every(v => v.id === owner.restaurantId && v.owner_id === owner.userId && v.name === owner.tag && v.slug === owner.slug));
        }
        const restaurantIds = owned.map(v => v.restaurantId), userIds = owned.map(v => v.userId);
        const orderIds = (await client.query('SELECT id FROM public.orders WHERE restaurant_id=ANY($1::uuid[])', [restaurantIds])).rows.map(v => v.id);
        const itemIds = (await client.query('SELECT id FROM public.menu_items WHERE restaurant_id=ANY($1::uuid[])', [restaurantIds])).rows.map(v => v.id);
        for (const owner of owned) {
          await client.query('DELETE FROM public.restaurants WHERE id=$1 AND owner_id=$2 AND name=$3 AND slug=$4', [owner.restaurantId, owner.userId, owner.tag, owner.slug]);
          await client.query('DELETE FROM better_auth."user" WHERE id=$1 AND name=$2 AND email=$3', [owner.userId, owner.tag, owner.email]);
        }
        const residue = (await client.query(`SELECT (
          (select count(*) from public.restaurants where id=ANY($1::uuid[])) +
          (select count(*) from public.orders where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from public.order_items where order_id=ANY($3::uuid[])) +
          (select count(*) from public.menu_items where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from public.menu_item_variations where menu_item_id=ANY($4::uuid[])) +
          (select count(*) from public.table_sessions where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from public.order_feedback where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from public.payment_transactions where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from public.payment_effect_outbox where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from better_auth."user" where id=ANY($2::uuid[])) +
          (select count(*) from better_auth.session where "userId"=ANY($2::uuid[])) +
          (select count(*) from better_auth.account where "userId"=ANY($2::uuid[]))
        )::integer AS rows`, [restaurantIds, userIds, orderIds, itemIds])).rows[0];
        require(residue.rows === 0); await client.query('COMMIT'); return { rows: 0, tablesChecked: 12 };
      } catch { await client.query('ROLLBACK'); throw Error('Production fixture cleanup failed'); }
      finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}
