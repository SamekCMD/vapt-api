// Actual disposable PostgreSQL. R2 and the logout HTTP response are external
// ports; no Cloudflare/Neon call, account token, session cookie or public route.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withLocalDatabase} from '../src/modules/tenancy/pg-test-support.ts';
import {buildPublicCatalog} from '../src/modules/catalog/repository.ts';
import {createProductionCatalogWriterFixtureDriver} from './tenant-preview-fixtures.mjs';
const feature=async()=>{const m=await import('./catalog-writer-retirement.mjs').catch(()=>({}));assert.equal(typeof m.retireProductionCatalogWriterFixture,'function','scoped writer retirement missing');return m.retireProductionCatalogWriterFixture;};
const names=['create','patch','private','mixed','delete','rebuild'];
async function scenario(work){
  const retire=await feature();
  await withLocalDatabase(async pool=>{
    const adapter={options:{host:'ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech',database:'vapt',user:'neondb_owner',ssl:{rejectUnauthorized:true},max:1},
      query:(sql,p)=>sql.includes('current_database()')?Promise.resolve({rows:[{database:'vapt',role:'neondb_owner'}]}):pool.query(sql,p),connect:()=>pool.connect(),async end(){}};
    const driver=await createProductionCatalogWriterFixtureDriver({ownerUrl:'postgresql://neondb_owner:synthetic-only@ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full',tag:'catalog-writer-'+randomUUID(),createPool:()=>adapter,hash:async()=> 'local-test-not-a-login'});
    try{
      const credentials=await driver.seed();credentials[0].password='';const manifest=driver.identifiers(),r=manifest.restaurants[0],u=manifest.users[0];
      await pool.query('update public.restaurants set description=$2 where id=$1',[r.id,manifest.tag+' public']);
      // Exercise decimal versions above Number.MAX_SAFE_INTEGER.
      await pool.query("select setval('public.catalog_publication_version_seq',9007199254740992,true)");
      const operationIds=Object.fromEntries(names.map(n=>[n,randomUUID()])),receipts=[],states=[];
      for(const name of names){
        let version=null;
        if(name!=='private'){
          version=(await pool.query("select nextval('public.catalog_publication_version_seq')::text version")).rows[0].version;
          const state={version,catalog:await buildPublicCatalog(pool,r.id)};states.push(state);
          await pool.query(`insert into public.catalog_publication_operations(operation_id,actor_id,restaurant_id,fingerprint,version,snapshot,result,previous_slug)
            values($1,$2,$3,$4,$5,$6::jsonb,'{}'::jsonb,$7)`,[operationIds[name],u.id,r.id,'f'.repeat(64),version,JSON.stringify(state),r.slug]);
        }
        receipts.push({operationId:operationIds[name],restaurantId:r.id,phase:'ready',version,committed:true,retryable:false});
      }
      const last=states.at(-1).version,previous=states.at(-2).version;
      await pool.query('insert into public.catalog_publication_revisions(restaurant_id,version) values($1,$2)',[r.id,last]);
      const prefix=`catalog/v1/production/restaurants/${r.id}/`,slugKey=`catalog/v1/production/slugs/${r.slug}.json`,manifestKey=prefix+'manifest.json';
      const objects=new Map(),writes=[];let serial=0;
      const set=(key,body)=>objects.set(key,{body:typeof body==='string'?body:JSON.stringify(body),etag:'etag-'+(++serial)});
      set(slugKey,{restaurantId:r.id,version:last,canonicalSlug:r.slug,tombstone:false});
      set(manifestKey,{restaurantId:r.id,version:last,canonicalSlug:r.slug,previousVersion:previous});
      for(const state of states)set(prefix+`snapshots/${state.version}.json`,states.indexOf(state)<3?{retired:true,version:state.version}:state);
      // An unrelated object must not even enter the target key set.
      set('catalog/v1/production/restaurants/'+randomUUID()+'/manifest.json',{keep:true});
      const store={async get(key){return structuredClone(objects.get(key)??null);},async put(key,body,{ifMatch}){
        writes.push(key);if(objects.get(key)?.etag!==ifMatch)return null;set(key,body);return{etag:objects.get(key).etag};
      }};
      const options={pool:adapter,manifest,operationIds,probe:{ok:true,uncertain:false,stage:'verified',receipts},verifyLoggedOut:async()=>({status:401}),store};
      await work({pool,adapter,driver,manifest,r,u,states,objects,writes,set,store,options,retire,slugKey,manifestKey,prefix});
    }finally{await driver.close();}
  });
}

test('terminal single-owner retirement preserves unrelated data and valid manifest, fences payloads, then permits strict cleanup',async()=>scenario(async f=>{
  const foreign=randomUUID();await f.pool.query('insert into better_auth."user"(id,name,email,"emailVerified") values($1,\'Keep me\',$2,true)',[foreign,foreign+'@example.invalid']);
  const result=await f.retire(f.options);
  assert.equal(result.journalRows,0);assert.equal(result.revisionRows,0);assert.equal(result.readbackConfirmed,true);assert.equal(result.keys.length,7);
  assert.equal(result.objectWrites,3,'three older snapshots already have fences');assert.ok(result.retainedFenceBytes<4096);
  assert.equal(JSON.parse(f.objects.get(f.slugKey).body).tombstone,true);
  assert.deepEqual(JSON.parse(f.objects.get(f.manifestKey).body),{restaurantId:f.r.id,version:'9007199254740997',canonicalSlug:f.r.slug,previousVersion:'9007199254740996'});
  for(const state of f.states)assert.deepEqual(JSON.parse(f.objects.get(f.prefix+`snapshots/${state.version}.json`).body),{retired:true,version:state.version});
  assert.equal(f.objects.size,8);assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations')).rows[0].n,0);
  assert.deepEqual(await f.driver.cleanup(),{rows:0});assert.equal((await f.pool.query('select count(*)::int n from better_auth."user" where id=$1',[foreign])).rows[0].n,1);
}));

for(const kind of ['logout','session','member','unknown-operation','pending','foreign-manifest','foreign-snapshot'])test(`retirement refuses ${kind} before any artifact write or journal deletion`,async()=>scenario(async f=>{
  if(kind==='logout')f.options.verifyLoggedOut=async()=>({status:200});
  if(kind==='session')await f.pool.query('insert into better_auth.session(id,"userId",token,"expiresAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now())',[randomUUID(),f.u.id,randomUUID()]);
  if(kind==='member')await f.pool.query("update public.organization_members set role='admin' where user_id=$1",[f.u.id]);
  if(kind==='unknown-operation'){
    const extra=randomUUID(),state=structuredClone(f.states[0]);state.version='9007199254740998';
    await f.pool.query(`insert into public.catalog_publication_operations(operation_id,actor_id,restaurant_id,fingerprint,version,snapshot,result) values($1,$2,$3,$4,$5,$6::jsonb,'{}'::jsonb)`,[extra,f.u.id,f.r.id,'e'.repeat(64),state.version,JSON.stringify(state)]);
  }
  if(kind==='pending')f.options.probe.receipts[0].phase='committed';
  if(kind==='foreign-manifest')f.set(f.manifestKey,{restaurantId:randomUUID(),version:f.states.at(-1).version,canonicalSlug:f.r.slug,previousVersion:f.states.at(-2).version});
  if(kind==='foreign-snapshot'){const state=structuredClone(f.states.at(-1));state.catalog.restaurant.name='Unexpected';f.set(f.prefix+`snapshots/${state.version}.json`,state);}
  await assert.rejects(()=>f.retire(f.options));assert.equal(f.writes.length,0);
  assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where restaurant_id=$1',[f.r.id])).rows[0].n,kind==='unknown-operation'?6:5);
  assert.equal((await f.pool.query('select count(*)::int n from better_auth."user" where id=$1',[f.u.id])).rows[0].n,1);
}));

for(const kind of ['lost-put','CAS-conflict','wrong-readback'])test(`retirement stops on ${kind} without a second write or SQL cleanup`,async()=>scenario(async f=>{
  const put=f.store.put;let attempts=0;
  f.store.put=async(...args)=>{attempts++;if(kind==='CAS-conflict')return null;if(kind==='wrong-readback')return{etag:'not-actually-written'};await put(...args);throw Error('Synthetic lost response; not for output');};
  await assert.rejects(()=>f.retire(f.options),e=>e.safeCode==='catalog_writer_retirement_uncertain');
  assert.equal(attempts,1);assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where restaurant_id=$1',[f.r.id])).rows[0].n,5);
  await assert.rejects(f.driver.cleanup());
}));

test('lost retirement COMMIT is uncertain, never retried and never followed by identity cleanup',async()=>scenario(async f=>{
  let commits=0;f.options.pool={...f.adapter,async connect(){const client=await f.pool.connect();return{release:()=>client.release(),async query(sql,p){const result=await client.query(sql,p);if(sql==='COMMIT'){commits++;throw Error('Synthetic lost COMMIT');}return result;}};}};
  await assert.rejects(()=>f.retire(f.options),e=>e.safeCode==='catalog_writer_retirement_uncertain');
  assert.equal(commits,1);assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where restaurant_id=$1',[f.r.id])).rows[0].n,0);
  assert.equal((await f.pool.query('select count(*)::int n from better_auth."user" where id=$1',[f.u.id])).rows[0].n,1);
}));

for(const phase of ['before-delete','before-commit'])test(`cancelled retirement ${phase} rolls back the real SQL journal and preserves identities`,async()=>scenario(async f=>{
  const abort=new AbortController();f.options.signal=abort.signal;let armed=false,commits=0;
  f.options.pool={...f.adapter,async connect(){const client=await f.pool.connect();return{release:()=>client.release(),async query(sql,p){
    const result=await client.query(sql,p);if(sql==='COMMIT')commits++;
    if(phase==='before-commit'&&sql.startsWith('delete from public.catalog_publication_revisions')){armed=true;abort.abort();}return result;
  }};}};
  if(phase==='before-delete'){const get=f.store.get;f.store.get=async(key,options)=>{const value=await get(key,options);if(!armed&&key===f.manifestKey&&f.writes.length>0){armed=true;abort.abort();}return value;};}
  await assert.rejects(()=>f.retire(f.options),e=>e.safeCode==='catalog_writer_retirement_uncertain');assert.equal(armed,true);assert.equal(commits,0);
  assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where restaurant_id=$1',[f.r.id])).rows[0].n,5);
  assert.equal((await f.pool.query('select count(*)::int n from better_auth."user" where id=$1',[f.u.id])).rows[0].n,1);
}));
