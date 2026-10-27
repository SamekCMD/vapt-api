// Existing disposable loopback harness only. Never connects to Neon.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyPassword} from 'better-auth/crypto';
import {withLocalDatabase} from '../src/modules/tenancy/pg-test-support.ts';
import {createProductionCatalogWriterFixtureDriver} from './tenant-preview-fixtures.mjs';
async function fixture(pool){return createProductionCatalogWriterFixtureDriver({ownerUrl:'postgresql://neondb_owner:synthetic-only@ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full',tag:'catalog-writer-'+randomUUID(),
  // Substitute only the external production identity/TLS boundary. All SQL,
  // constraints, transactions and committed readbacks use real local Postgres.
  createPool:()=>({query:(sql,p)=>sql.includes('current_database()')?Promise.resolve({rows:[{database:'vapt',role:'neondb_owner'}]}):pool.query(sql,p),connect:()=>pool.connect(),async end(){}})});}
test('one-owner writer fixture seeds real constraints/password and cleans only owned data',async()=>{
  await withLocalDatabase(async pool=>{
    const foreign=randomUUID();await pool.query('insert into better_auth."user"(id,name,email,"emailVerified") values($1,\'Keep me\',$2,true)',[foreign,foreign+'@example.invalid']);
    const driver=await fixture(pool);try{
      const credentials=await driver.seed(),m=driver.identifiers();assert.equal(credentials.length,1);assert.equal(m.restaurants.length,1);assert.equal(m.organizations.length,1);
      const hash=(await pool.query('select password from better_auth.account where "userId"=$1',[m.users[0].id])).rows[0].password;
      assert.equal(await verifyPassword({hash,password:credentials[0].password}),true);
      const row=(await pool.query('select r.slug,s.plan_type,m.role from public.restaurants r join public.organization_subscriptions s using(organization_id) join public.organization_members m using(organization_id) where r.id=$1',[m.restaurants[0].id])).rows[0];
      assert.deepEqual(row,{slug:m.tag,plan_type:'business',role:'owner'});await assert.rejects(driver.seed());assert.deepEqual(await driver.cleanup(),{rows:0});
      assert.equal((await pool.query('select count(*)::int n from better_auth."user" where id=$1',[foreign])).rows[0].n,1);assert.equal((await pool.query('select count(*)::int n from public.restaurants')).rows[0].n,0);credentials[0].password='';
    }finally{await driver.close();}
  });
});
for(const kind of ['session','menu-item','revision'])test(`real cleanup refuses remaining ${kind} before deleting any owned identity`,async()=>{
  await withLocalDatabase(async pool=>{
    const driver=await fixture(pool);try{
      const credentials=await driver.seed(),m=driver.identifiers(),r=m.restaurants[0].id,u=m.users[0].id,id=randomUUID();credentials[0].password='';
      if(kind==='session')await pool.query('insert into better_auth.session(id,"userId",token,"expiresAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now())',[id,u,randomUUID()]);
      if(kind==='menu-item')await pool.query('insert into public.menu_items(id,restaurant_id,name,price,category) values($1,$2,$3,1.00,\'Test\')',[id,r,m.tag+' item']);
      if(kind==='revision')await pool.query('insert into public.catalog_publication_revisions(restaurant_id,version) values($1,1)',[r]);
      await assert.rejects(driver.cleanup());assert.equal((await pool.query('select count(*)::int n from better_auth."user" where id=$1',[u])).rows[0].n,1);assert.equal((await pool.query('select count(*)::int n from public.restaurants where id=$1',[r])).rows[0].n,1);
      // Only this known local test row is removed to exercise eventual cleanup;
      // the remote fixture never performs this retirement on the caller's behalf.
      if(kind==='session')await pool.query('delete from better_auth.session where id=$1 and "userId"=$2',[id,u]);
      if(kind==='menu-item')await pool.query('delete from public.menu_items where id=$1 and restaurant_id=$2',[id,r]);
      if(kind==='revision')await pool.query('delete from public.catalog_publication_revisions where restaurant_id=$1 and version=1',[r]);
      assert.deepEqual(await driver.cleanup(),{rows:0});
    }finally{await driver.close();}
  });
});
