// Operator-only preview fixtures. Never imported by the Worker. SQL credentials
// are captured from the existing authenticated CLI, not printed or persisted.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { assertPreviewAclTarget } from './verify-preview-acl-regression.mjs';

const exec = promisify(execFile);
export async function createFixtureDriver({ownerUrl, createPool=options=>new Pool(options), hash=hashPassword}={}) {
  if (!ownerUrl) {
    if (!process.env.NEON_CLI_PATH) throw new Error('Existing Neon CLI required');
    const result = await exec(process.execPath,[process.env.NEON_CLI_PATH,
      'connection-string','br-rough-dew-b6ydeygb','--project-id','dawn-morning-27332079',
      '--role-name','neondb_owner','--database-name','vapt','--ssl','verify-full'],
    {timeout:30000,maxBuffer:65536,env:{...process.env,NO_UPDATE_NOTIFIER:'1'}});
    ownerUrl=result.stdout.trim(); result.stdout='';result.stderr='';
  }
  assertPreviewAclTarget({ownerUrl,verifierPath:'verify-worker-preview-role.sql'});
  const pool=createPool({connectionString:ownerUrl,max:1,connectionTimeoutMillis:10000,statement_timeout:10000});
  ownerUrl=null;
  try {
    const identity=(await pool.query('select current_database() as database, current_user as role')).rows[0];
    if (identity?.database!=='vapt' || identity.role!=='neondb_owner') throw new Error();
  } catch {await pool.end();throw new Error('Preview fixture identity failed');}
  const manifest=[];
  let seeded=false;
  return {
    // Public identifiers only, useful for inspecting these exact DO rooms.
    identifiers(){return manifest.map(({userId,restaurantId,itemId,slug})=>({userId,restaurantId,itemId,slug}));},
    async seed(tag,created) {
      if (seeded) throw new Error('Fixture already seeded');
      if (!/^stage12-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tag)) throw new Error('Invalid fixture tag');
      seeded=true;
      const owners=[0,1].map(index=>({userId:randomUUID(),restaurantId:randomUUID(),itemId:randomUUID(),
        slug:tag+'-'+index,email:tag+'-'+index+'@example.invalid',password:randomBytes(32).toString('base64url')}));
      manifest.push(...owners.map(({password,...owner})=>({...owner,tag})));
      created.userIds.push(...owners.map(v=>v.userId));created.restaurantIds.push(...owners.map(v=>v.restaurantId));
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        for (const owner of owners) {
          await client.query('INSERT INTO better_auth."user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)',[owner.userId,tag,owner.email]);
          await client.query('INSERT INTO better_auth.account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2::text,\'credential\',$2::uuid,$3,now(),now())',[randomUUID(),owner.userId,await hash(owner.password)]);
          await client.query(`INSERT INTO public.restaurants (id,owner_id,name,slug,plan_type,plan_status,onboarding_completed,total_tables,max_tables,max_pending_orders,payment_mode)
            VALUES ($1,$2,$3,$4,'pro','active',true,2,2,10,'open_tab')`,[owner.restaurantId,owner.userId,tag,owner.slug]);
          await client.query(`INSERT INTO public.menu_items (id,restaurant_id,name,price,category,available) VALUES ($1,$2,'Item Teste',12.00,'Teste',true)`,[owner.itemId,owner.restaurantId]);
        }
        await client.query('COMMIT');return owners;
      } catch {await client.query('ROLLBACK');throw new Error('Preview fixture seed failed');}
      finally {client.release();}
    },
    async cleanup() {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        for (const owner of manifest) {
          await client.query('DELETE FROM public.restaurants where id = $1 AND owner_id = $2 AND slug = $3',[owner.restaurantId,owner.userId,owner.slug]);
          await client.query('DELETE FROM better_auth."user" where id = $1 AND name = $2 AND email = $3',[owner.userId,owner.tag,owner.email]);
        }
        const result=await client.query(`select (
          (select count(*) from public.restaurants where id=ANY($1::uuid[])) +
          (select count(*) from public.orders where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from public.menu_items where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from public.table_sessions where restaurant_id=ANY($1::uuid[])) +
          (select count(*) from better_auth."user" where id=ANY($2::uuid[])) +
          (select count(*) from better_auth.session where "userId"=ANY($2::uuid[])) +
          (select count(*) from better_auth.account where "userId"=ANY($2::uuid[]))
        )::integer as rows`,[manifest.map(v=>v.restaurantId),manifest.map(v=>v.userId)]);
        await client.query('COMMIT');return {rows:result.rows[0].rows};
      } catch {await client.query('ROLLBACK');throw new Error('Preview fixture cleanup failed');}
      finally {client.release();}
    },
    async close(){await pool.end();},
  };
}
