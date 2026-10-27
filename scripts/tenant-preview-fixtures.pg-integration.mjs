// Invoked only inside the existing disposable loopback PostgreSQL harness.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {verifyPassword} from 'better-auth/crypto';
import {withLocalDatabase} from '../src/modules/tenancy/pg-test-support.ts';
import {createTenantFixtureDriver,createProductionTenantFixtureDriver} from './tenant-preview-fixtures.mjs';

for(const [environment,createDriver,host,prefix] of [
  ['preview',createTenantFixtureDriver,'ep-hidden-bird-b673zocn','tenant-smoke-'],
  ['production',createProductionTenantFixtureDriver,'ep-holy-wildflower-b6vtv1dd','tenant-production-smoke-'],
])test(`actual PostgreSQL ${environment} tenant smoke seed and committed cleanup preserve FKs and remove preferences plus auth sessions`,async()=>{
  await withLocalDatabase(async pool=>{
    // Substitute only the external owner/TLS identity boundary. All fixture SQL,
    // transactions, constraints and committed readback use genuine local PG.
    const driver=await createDriver({
      ownerUrl:`postgresql://neondb_owner:synthetic-only@${host}.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full`,
      tag:prefix+randomUUID(),
      createPool:()=>({query:async(sql,p)=>sql.includes('current_database()')?{rows:[{database:'vapt',role:'neondb_owner'}]}:pool.query(sql,p),connect:()=>pool.connect(),async end(){}}),
    });
    try{
      const credentials=await driver.seed(),manifest=driver.identifiers();
      assert.equal((await pool.query('select count(*)::int n from public.organizations')).rows[0].n,2);
      assert.equal((await pool.query('select count(*)::int n from public.restaurants')).rows[0].n,3);
      assert.equal((await pool.query('select count(*)::int n from public.organization_members')).rows[0].n,5);
      const user=credentials[0],unit=manifest.restaurants[0];
      const row=(await pool.query('select password from better_auth.account where "userId"=$1',[user.id])).rows[0];
      assert.equal(await verifyPassword({hash:row.password,password:user.password}),true);
      await pool.query('insert into public.account_preferences(user_id,organization_id,restaurant_id) values($1,$2,$3)',[user.id,user.organizationId,unit.id]);
      await pool.query('insert into better_auth.session(id,"userId",token,"expiresAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now())',[randomUUID(),user.id,randomUUID()]);
      assert.deepEqual(await driver.cleanup(),{rows:0});
      const counts=await pool.query(`select
        (select count(*) from public.organizations)+(select count(*) from public.restaurants)+
        (select count(*) from public.organization_members)+(select count(*) from public.organization_subscriptions)+
        (select count(*) from public.account_preferences)+(select count(*) from better_auth."user")+
        (select count(*) from better_auth.account)+(select count(*) from better_auth.session) as n`);
      assert.equal(Number(counts.rows[0].n),0);
      credentials.forEach(v=>{v.password='';});
    }finally{await driver.close();}
  });
});
