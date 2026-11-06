// Actual disposable PostgreSQL + actual Hono routes/services/applier. Auth HTTP,
// coordinator persistence and private R2 are controlled boundaries, not cloud proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer,createConnection} from 'node:net';
import {Pool} from 'pg';
import {verifyPassword} from 'better-auth/crypto';
import {withLocalDatabase,seedUser,seedOrganization,seedRestaurant} from '../src/modules/tenancy/pg-test-support.ts';
import {createWorkerApp} from '../src/worker/app.ts';
import {createOnboardingRepository} from '../src/modules/onboarding/repository.ts';
import {createAccountRepository} from '../src/modules/account/repository.ts';
import {createAccountService} from '../src/modules/account/service.ts';
import {createRestaurantRepository} from '../src/modules/restaurants/repository.ts';
import {applyCatalogCommand} from '../src/modules/catalog-publication/transaction.ts';
import {runProductionCatalogOnboardingProbe} from './catalog-onboarding-probe.mjs';
const ownerUrl='postgresql://neondb_owner:synthetic-only@ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full';
const manifest=()=>{const tag='catalog-writer-'+randomUUID();return{tag,user:{id:randomUUID(),name:tag,email:tag+'-0@example.invalid'},accountId:randomUUID(),operationIds:{draft:randomUUID(),finalize:randomUUID()}};};
async function feature(){const m=await import('./catalog-onboarding-fixtures.mjs').catch(()=>({}));assert.equal(typeof m.createProductionCatalogOnboardingFixtureDriver,'function','identity-only canonical fixture missing');return m.createProductionCatalogOnboardingFixtureDriver;}
test('factory refuses nonproduction/TLS/role/tag/ID scope before constructing a connection',async()=>{
  const create=await feature();let pools=0;
  for(const mutate of [
    o=>o.ownerUrl=o.ownerUrl.replace('holy-wildflower-b6vtv1dd','hidden-bird-b673zocn'),o=>o.ownerUrl=o.ownerUrl.replace('verify-full','disable'),
    o=>o.ownerUrl=o.ownerUrl.replace('neondb_owner','vapt_api_production'),o=>o.ownerUrl+='&options=unsafe',
    o=>o.manifest.user.email='real@example.invalid',o=>o.manifest.accountId=o.manifest.user.id,
    o=>o.manifest.operationIds.finalize=o.manifest.operationIds.draft,o=>o.manifest.extra=true]){
    const options={ownerUrl,manifest:manifest(),createPool:()=>{pools++;}};mutate(options);await assert.rejects(()=>create(options));
  }
  assert.equal(pools,0);
});
async function scenario(work){
  const create=await feature();await withLocalDatabase(async pool=>{
    const m=manifest(),queries=[],writes=[],objects=new Map(),calls=[],fault={};let etag=0;
    const set=(key,value)=>objects.set(key,{body:JSON.stringify(value),etag:'"'+(++etag).toString(16).padStart(32,'0')+'"'});
    const adapter={query:async(sql,params)=>{queries.push(sql);return sql.includes('current_database()')?{rows:[{database:'vapt',role:'neondb_owner'}]}:pool.query(sql,params);},
      connect:async()=>{const client=await pool.connect();return{query:async(sql,params)=>{queries.push(sql);if(sql.includes('current_database()'))return{rows:[{database:'vapt',role:'neondb_owner'}]};const result=await client.query(sql,params);if(sql==='COMMIT'&&fault.lostCommit){fault.lostCommit=false;throw Error('private commit wire diagnostic');}return result;},release:reason=>client.release(reason)};},async end(){}};
    const driver=await create({ownerUrl,manifest:m,createPool:()=>adapter});
    const store={async get(key){return objects.get(key)??null;},async put(key,body,{ifMatch,signal}){signal.throwIfAborted();assert.equal(objects.get(key)?.etag,ifMatch);writes.push(key);set(key,JSON.parse(body));return{etag:objects.get(key).etag};}};
    const sessionId=randomUUID(),cookie='__Secure-better-auth.session_token=synthetic-private-session-value';
    let sessionExpiresAt;
    async function login(){sessionExpiresAt=Date.now()+3600000;await pool.query('insert into better_auth.session(id,"userId",token,"expiresAt","updatedAt") values($1,$2,$3,$4,now())',[sessionId,m.user.id,randomUUID(),new Date(sessionExpiresAt)]);}
    const actor=()=>({userId:m.user.id,sessionId,sessionExpiresAt});
    const services={database:pool,onboarding:createOnboardingRepository(pool),account:createAccountService(createAccountRepository(pool)),restaurants:createRestaurantRepository(pool),
      authRuntime:{async getSession(){const row=(await pool.query('select id from better_auth.session where id=$1',[sessionId])).rows[0];return row?{user:{id:m.user.id,email:m.user.email,name:m.tag},session:{id:sessionId,userId:m.user.id,expiresAt:new Date(sessionExpiresAt)}}:null;}}};
    let committed;
    const env={ENVIRONMENT:'production',CORS_ORIGINS:'https://vapt.app.br',PUBLIC_CATALOG_WRITER_ENABLED:'true',
      AUTH_RATE_LIMIT:{async limit(){return{success:true};}},PUBLIC_CATALOG_COORDINATOR:{idFromName:name=>name,get:()=>({
        async submit(command){committed=await applyCatalogCommand(pool,command);const {state,receipt,result}=committed,r=state.catalog.restaurant;
          set(`catalog/v1/production/slugs/${r.slug}.json`,{restaurantId:r.id,version:state.version,canonicalSlug:r.slug,tombstone:false});
          const prefix=`catalog/v1/production/restaurants/${r.id}/`;set(prefix+'manifest.json',{restaurantId:r.id,version:state.version,canonicalSlug:r.slug,previousVersion:null});set(prefix+`snapshots/${state.version}.json`,state);
          return{ok:true,value:{receipt:{...receipt,phase:'ready',retryable:false},result}};},
        async status(){return{ok:true,value:{...committed.receipt,phase:'ready',retryable:false}};}
      })}};
    const app=createWorkerApp(async()=>services),execution={waitUntil(){},passThroughOnException(){}};
    async function onboard(){
      await login();return runProductionCatalogOnboardingProbe({baseUrl:'https://api.vapt.app.br',actorId:m.user.id,tag:m.tag,operationIds:m.operationIds,cookie,
        preflight:async()=>{},pace:async()=>{},waitPending:async()=>{},fetcher:async(url,init)=>{calls.push({url,method:init.method});return app.fetch(new Request(url,{...init,headers:{...init.headers,'CF-Connecting-IP':'203.0.113.10'}}),env,execution);}});
    }
    async function logout(){await pool.query('delete from better_auth.session where id=$1 and "userId"=$2',[sessionId,m.user.id]);}
    try{await work({pool,m,driver,queries,writes,objects,set,store,actor,login,onboard,logout,calls,fault,retire:(probe,extra={})=>driver.retireOnboarding({probe,store,verifyLoggedOut:async()=>({status:401}),...extra})});}
    finally{await driver.close();}
  });
}
test('seed creates only a verified identity/password and can clean an unused identity without touching another user',async()=>scenario(async f=>{
  const foreign=randomUUID();await f.pool.query('insert into better_auth."user"(id,name,email,"emailVerified") values($1,\'Keep\',$2,true)',[foreign,foreign+'@example.invalid']);
  const credential=await f.driver.seed();assert.equal(credential.email,f.m.user.email);assert.equal(credential.id,f.m.user.id);
  const hash=(await f.pool.query('select password from better_auth.account where id=$1',[f.m.accountId])).rows[0].password;
  assert.equal(await verifyPassword({hash,password:credential.password}),true);credential.password='';
  assert.deepEqual(f.driver.identifiers(),f.m);await assert.rejects(f.driver.seed());
  const counts=(await f.pool.query('select (select count(*)::int from public.organizations) organizations,(select count(*)::int from public.restaurants) restaurants,(select count(*)::int from better_auth.session) sessions')).rows[0];
  assert.deepEqual(counts,{organizations:0,restaurants:0,sessions:0});assert.deepEqual(await f.driver.cleanupIdentity(),{rows:0});
  assert.equal((await f.pool.query('select count(*)::int n from better_auth."user" where id=$1',[foreign])).rows[0].n,1);
}));
test('actual Hono onboarding/applier creates one trial and projection, then guarded retirement and identity cleanup remove only the owned fixture',async()=>scenario(async f=>{
  const foreignUser=await seedUser(f.pool),foreignOrg=await seedOrganization(f.pool,foreignUser),foreignRestaurant=await seedRestaurant(f.pool,foreignOrg,foreignUser);
  const foreignBefore=(await f.pool.query('select to_jsonb(r) value from public.restaurants r where id=$1',[foreignRestaurant])).rows[0].value;
  const decoy='catalog/v1/production/restaurants/'+foreignRestaurant+'/manifest.json';f.set(decoy,{keep:'unrelated object'});const decoyBefore=structuredClone(f.objects.get(decoy));
  (await f.driver.seed()).password='';const probe=await f.onboard();assert.equal(probe.ok,true,JSON.stringify(probe));assert.equal(probe.requests,12);
  const before=f.queries.length,proof=await f.driver.inspectOnboarding({probe});
  assert.equal(proof.verified,true);assert.equal(proof.trialVerified,true);assert.equal(proof.intentRows,2);assert.equal(proof.version,probe.receipts[0].version);
  assert(f.queries.slice(before).includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));assert(!f.queries.slice(before).some(sql=>/^(delete|update|insert)/i.test(sql)));
  const prefix=`catalog/v1/production/restaurants/${probe.restaurantId}/`,oldManifest=structuredClone(f.objects.get(prefix+'manifest.json'));
  await f.logout();const result=await f.retire(probe);assert.equal(result.readbackConfirmed,true);assert.equal(result.objectWrites,2);assert.equal(result.journalRows,0);assert.equal(result.intentRows,0);
  assert.deepEqual(f.objects.get(prefix+'manifest.json'),oldManifest);assert.deepEqual(JSON.parse(f.objects.get(prefix+`snapshots/${probe.receipts[0].version}.json`).body),{retired:true,version:probe.receipts[0].version});
  assert.equal(JSON.parse(f.objects.get(`catalog/v1/production/slugs/${f.m.tag}.json`).body).tombstone,true);
  assert.deepEqual(await f.driver.cleanupIdentity(),{rows:0});assert.equal((await f.pool.query('select count(*)::int n from public.restaurants where id=$1',[probe.restaurantId])).rows[0].n,0);
  assert.deepEqual((await f.pool.query('select to_jsonb(r) value from public.restaurants r where id=$1',[foreignRestaurant])).rows[0].value,foreignBefore);assert.deepEqual(f.objects.get(decoy),decoyBefore);
}));
for(const kind of ['live-session','extra-member','extra-intent','menu-item','wrong-trial','foreign-preference','wrong-snapshot','missing-object','billing','foreign-receipt',
  'push','payment-oauth','payment-event','payment-webhook','feedback','legacy-billing-event',
  'extra-subscription','private-cnpj','changed-sql','changed-revision','extra-operation','wrong-intent','bad-logout','cancelled'])test('retirement refuses '+kind+' before the first fence/delete',async()=>scenario(async f=>{
  (await f.driver.seed()).password='';const probe=await f.onboard();assert.equal(probe.ok,true);if(kind!=='live-session')await f.logout();
  const r=probe.restaurantId,o=probe.organizationId;
  if(kind==='extra-member'){const other=randomUUID();await f.pool.query('insert into better_auth."user"(id,name,email,"emailVerified") values($1,\'Keep\',$2,true)',[other,other+'@example.invalid']);await f.pool.query("insert into public.organization_members(organization_id,user_id,role,status) values($1,$2,'staff','active')",[o,other]);}
  if(kind==='extra-intent')await f.pool.query("insert into public.onboarding_intents(operation_id,actor_id,organization_id,restaurant_id,kind,fingerprint,result) values($1,$2,$3,$4,'finalize',$5,'{}')",[randomUUID(),f.m.user.id,o,r,'a'.repeat(64)]);
  if(kind==='menu-item')await f.pool.query("insert into public.menu_items(id,restaurant_id,name,price) values($1,$2,'Keep',1)",[randomUUID(),r]);
  if(kind==='wrong-trial')await f.pool.query("update public.organization_subscriptions set trial_ends_at=trial_started_at+interval '4 days' where organization_id=$1",[o]);
  if(kind==='foreign-preference')await f.pool.query('delete from public.account_preferences where user_id=$1',[f.m.user.id]);
  if(kind==='wrong-snapshot')f.set(`catalog/v1/production/restaurants/${r}/snapshots/${probe.receipts[0].version}.json`,{retired:true,version:probe.receipts[0].version});
  if(kind==='missing-object')f.objects.delete(`catalog/v1/production/slugs/${f.m.tag}.json`);
  if(kind==='billing'){await f.pool.query("insert into public.organization_billing_resources(resource_id,resource_type,organization_id) values('cus_keep','customer',$1)",[o]);await f.pool.query("update public.organization_subscriptions set stripe_customer_id='cus_keep' where organization_id=$1",[o]);}
  let preserve;
  if(kind==='push'){await f.pool.query("insert into public.push_subscriptions(restaurant_id,endpoint,subscription) values($1,'https://synthetic.invalid/push','{}')",[r]);preserve='push_subscriptions';}
  if(kind==='payment-oauth'){await f.pool.query("insert into public.payment_oauth_states(restaurant_id,provider,state_hash,code_verifier_encrypted,credential_key_id,redirect_uri,expires_at) values($1,'mercado_pago','synthetic-hash','synthetic-cipher','synthetic-key','https://synthetic.invalid',now()+interval '1 hour')",[r]);preserve='payment_oauth_states';}
  if(kind==='payment-event'){await f.pool.query("insert into public.payment_provider_events(provider,provider_event_id,event_type,restaurant_id) values('mercado_pago','synthetic-event','synthetic',$1)",[r]);preserve='payment_provider_events';}
  if(kind==='payment-webhook'){await f.pool.query("insert into public.payment_webhook_events(provider,external_event_id,event_type,restaurant_id) values('mercado_pago','synthetic-webhook','synthetic',$1)",[r]);preserve='payment_webhook_events';}
  if(kind==='legacy-billing-event'){await f.pool.query("insert into public.billing_provider_events(provider,provider_event_id,event_type,restaurant_id) values('stripe','synthetic-billing-event','synthetic',$1)",[r]);preserve='billing_provider_events';}
  if(kind==='feedback'){
    // Independent FKs permit feedback attached to this restaurant but an order
    // owned elsewhere. There need not be a scoped order for the old guard to see.
    const owner=await seedUser(f.pool),org=await seedOrganization(f.pool,owner),other=await seedRestaurant(f.pool,org,owner),order=randomUUID();
    await f.pool.query("update public.restaurants set onboarding_status='complete',onboarding_completed=true,onboarding_step=2 where id=$1",[other]);
    await f.pool.query('insert into public.orders(id,restaurant_id,total_price) values($1,$2,1)',[order,other]);
    await f.pool.query('insert into public.order_feedback(order_id,restaurant_id,rating) values($1,$2,5)',[order,r]);preserve='order_feedback';
  }
  const preservedBefore=preserve?(await f.pool.query(`select to_jsonb(t) row from public.${preserve} t where restaurant_id=$1`,[r])).rows:undefined;
  if(kind==='foreign-receipt')probe.receipts[0].restaurantId=randomUUID();
  if(kind==='private-cnpj')await f.pool.query("update public.restaurants set cnpj='synthetic-private' where id=$1",[r]);
  if(kind==='extra-subscription'){
    const foreign=randomUUID(),org=randomUUID();await f.pool.query('insert into better_auth."user"(id,name,email,"emailVerified") values($1,\'Keep\',$2,true)',[foreign,foreign+'@example.invalid']);
    await f.pool.query("insert into public.organizations(id,name,created_by) values($1,'Keep',$2)",[org,foreign]);
    await f.pool.query('insert into public.organization_subscriptions(organization_id,billing_contact_user_id) values($1,$2)',[org,f.m.user.id]);
  }
  if(kind==='changed-sql')await f.pool.query("update public.restaurants set phone='synthetic-edit' where id=$1",[r]);
  if(kind==='changed-revision')await f.pool.query('update public.catalog_publication_revisions set version=version+1 where restaurant_id=$1',[r]);
  if(kind==='extra-operation')await f.pool.query('insert into public.catalog_publication_operations(operation_id,actor_id,restaurant_id,fingerprint,version,snapshot,result) select $1,actor_id,restaurant_id,fingerprint,version,snapshot,result from public.catalog_publication_operations where restaurant_id=$2',[randomUUID(),r]);
  if(kind==='wrong-intent')await f.pool.query("update public.onboarding_intents set fingerprint=$2 where operation_id=$1",[f.m.operationIds.draft,'e'.repeat(64)]);
  const extra=kind==='bad-logout'?{verifyLoggedOut:async()=>({status:200})}:kind==='cancelled'?{signal:AbortSignal.abort()}:{};
  const start=f.queries.length;await assert.rejects(()=>f.retire(probe,extra));assert.equal(f.writes.length,0);assert(!f.queries.slice(start).some(sql=>/^delete/i.test(sql)));
  assert.equal((await f.pool.query('select count(*)::int n from public.restaurants where id=$1',[r])).rows[0].n,1);await assert.rejects(f.driver.cleanupIdentity());
  if(preserve)assert.deepEqual((await f.pool.query(`select to_jsonb(t) row from public.${preserve} t where restaurant_id=$1`,[r])).rows,preservedBefore,'unexpected effect must remain intact');
}));
test('uncertain seed commit cannot be repeated or blindly cleaned',async()=>scenario(async f=>{
  f.fault.lostCommit=true;await assert.rejects(f.driver.seed(),error=>error.safeCode==='onboarding_seed_uncertain'&&!error.message.includes('private commit'));
  assert.equal((await f.pool.query('select count(*)::int n from better_auth."user" where id=$1',[f.m.user.id])).rows[0].n,1);
  await assert.rejects(f.driver.seed());await assert.rejects(f.driver.cleanupIdentity());
}));
test('uncertain retirement commit preserves the remaining identity and forbids a retry',async()=>scenario(async f=>{
  (await f.driver.seed()).password='';const probe=await f.onboard();await f.logout();f.fault.lostCommit=true;
  await assert.rejects(()=>f.retire(probe),error=>error.safeCode==='onboarding_retirement_uncertain');assert.equal(f.writes.length,2);
  assert.equal((await f.pool.query('select count(*)::int n from public.restaurants where id=$1',[probe.restaurantId])).rows[0].n,0);
  await assert.rejects(()=>f.retire(probe));await assert.rejects(f.driver.cleanupIdentity());assert.equal(f.writes.length,2);
  assert.equal((await f.pool.query('select count(*)::int n from better_auth."user" where id=$1',[f.m.user.id])).rows[0].n,1);
}));
test('lost CAS result preserves SQL/probe IDs and refuses blind retry or identity cleanup',async()=>scenario(async f=>{
  (await f.driver.seed()).password='';const probe=await f.onboard();await f.logout();const put=f.store.put;let calls=0;
  f.store.put=async(...args)=>{calls++;await put(...args);throw Error('private S3 wire diagnostic');};
  await assert.rejects(()=>f.retire(probe),error=>error.safeCode==='onboarding_retirement_uncertain'&&!error.message.includes('private S3'));
  assert.equal(calls,1);assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where restaurant_id=$1',[probe.restaurantId])).rows[0].n,1);
  await assert.rejects(()=>f.retire(probe));assert.equal(calls,1);await assert.rejects(f.driver.cleanupIdentity());
}));
for(const kind of ['session','oauth','domain'])test('unused identity cleanup refuses unexpected '+kind,async()=>scenario(async f=>{
  (await f.driver.seed()).password='';
  if(kind==='session')await f.login();
  if(kind==='oauth')await f.pool.query('insert into better_auth.account(id,"accountId","providerId","userId","updatedAt") values($1,\'extra\',\'google\',$2,now())',[randomUUID(),f.m.user.id]);
  if(kind==='domain'){await f.login();await createOnboardingRepository(f.pool).createInitialDraft(f.actor(),f.m.operationIds.draft,{name:f.m.tag,slug:f.m.tag});await f.logout();}
  const start=f.queries.length;await assert.rejects(f.driver.cleanupIdentity());assert(!f.queries.slice(start).some(sql=>/^delete/i.test(sql)));assert.equal((await f.pool.query('select count(*)::int n from better_auth."user" where id=$1',[f.m.user.id])).rows[0].n,1);
}));

test('real pg TCP response blackhole at COMMIT terminates the client and preserves the committed seed as uncertain',async()=>{
  const create=await feature();await withLocalDatabase(async pool=>{
    const target=new URL(pool.options.connectionString),backendPort=Number(target.port),sockets=new Set(),queries=[];let blackholed=false,destroyed=false;
    const proxy=createServer(downstream=>{
      const upstream=createConnection({host:'127.0.0.1',port:backendPort});sockets.add(downstream);sockets.add(upstream);
      downstream.on('data',data=>{if(data.includes(Buffer.from('COMMIT\0')))blackholed=true;upstream.write(data);});
      upstream.on('data',data=>{if(!blackholed)downstream.write(data);});
      downstream.on('close',()=>{destroyed=true;sockets.delete(downstream);upstream.destroy();});
      upstream.on('close',()=>{sockets.delete(upstream);downstream.destroy();});
      downstream.on('error',()=>{});upstream.on('error',()=>downstream.destroy());
    });
    await new Promise(ok=>proxy.listen(0,'127.0.0.1',ok));target.port=String(proxy.address().port);
    let driver,raw,watchdog;
    try{
      const m=manifest();driver=await create({ownerUrl,manifest:m,createPool:config=>{
        raw=new Pool({...config,connectionString:target.href,ssl:false});
        return{connect:async()=>{const client=await raw.connect();return{query:async(sql,params)=>{queries.push(sql);if(sql.includes('current_database()'))return{rows:[{database:'vapt',role:'neondb_owner'}]};return client.query(sql,params);},release:reason=>client.release(reason)};},end:()=>raw.end()};
      }});
      const start=Date.now();watchdog=setTimeout(()=>{for(const socket of sockets)socket.destroy();},20000);
      await assert.rejects(driver.seed(),error=>error.safeCode==='onboarding_seed_uncertain');
      assert(Date.now()-start<20000,'client must not depend on a server response to terminate');
      await new Promise(ok=>setTimeout(ok,30));assert.equal(blackholed,true);assert.equal(destroyed,true);assert.equal(raw.totalCount,0);
      assert(!queries.includes('ROLLBACK'),'a destroyed connection cannot be used for rollback');
      assert.equal((await pool.query('select count(*)::int n from better_auth."user" where id=$1',[m.user.id])).rows[0].n,1,'lost COMMIT acknowledgement must not trigger blind cleanup');
      await assert.rejects(driver.seed());await assert.rejects(driver.cleanupIdentity());
    }finally{clearTimeout(watchdog);await driver?.close();for(const socket of sockets)socket.destroy();await new Promise(ok=>proxy.close(ok));}
  });
});
