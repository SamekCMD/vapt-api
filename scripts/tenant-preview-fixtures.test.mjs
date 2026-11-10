import assert from 'node:assert/strict';
import test from 'node:test';
const ownerUrl='postgresql://neondb_owner:synthetic-secret@ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full';
const tag='tenant-smoke-11111111-1111-4111-8111-111111111111';
async function feature(){const m=await import('./tenant-preview-fixtures.mjs').catch(()=>null);assert.equal(typeof m?.createTenantFixtureDriver,'function','tenant fixture not implemented');return m.createTenantFixtureDriver;}
function database({collision=false,mismatch=false,residue=0,seedFailure=false,enforceSingleConnection=false,commitUncertain=false,catalogEffects=0,existingManifest}={}){
  const {users=[],organizations=[],restaurants=[],members=[]}=structuredClone(existingManifest??{}),queries=[];let ended=false,held=false;
  const query=async(sql,p=[])=>{
    queries.push({sql,p});
    if(sql==='COMMIT'&&commitUncertain)throw Error('synthetic-secret');
    if(sql.includes('current_database()'))return{rows:[{database:'vapt',role:'neondb_owner'}]};
    if(sql.includes('AS collision'))return{rows:[{collision:collision?1:0}]};
    if(sql.startsWith('INSERT INTO better_auth."user"'))users.push({id:p[0],name:p[1],email:p[2]});
    if(sql.startsWith('INSERT INTO better_auth.account')&&seedFailure)throw Error('synthetic-secret');
    if(sql.startsWith('INSERT INTO public.organizations'))organizations.push({id:p[0],name:p[1],created_by:p[2]});
    if(sql.startsWith('INSERT INTO public.organization_members'))members.push({organization_id:p[0],user_id:p[1],role:p[2],status:'active'});
    if(sql.startsWith('INSERT INTO public.restaurants'))restaurants.push({id:p[0],organization_id:p[1],owner_id:p[2],name:p[3],slug:p[4]});
    if(sql.includes('AS owned_snapshot'))return{rows:[{owned_snapshot:{users,organizations,restaurants:restaurants.map(v=>({...v,owner_id:mismatch?'foreign':v.owner_id})),members}}]};
    if(sql.includes('AS catalog_fixture_effects'))return{rows:[{catalog_fixture_effects:catalogEffects}]};
    if(sql.includes('AS residue'))return{rows:[{residue}]};
    return{rows:[]};
  };
  const client={query,release(){held=false;}};return{queries,pool:{async query(sql,p){if(enforceSingleConnection&&held)throw Error('Pool max1 would block');return query(sql,p);},async connect(){held=true;return client;},async end(){ended=true;}},ended:()=>ended};
}
test('tenant fixtures refuse production, weak TLS, foreign role and invalid tag before SQL',async()=>{
  const create=await feature();let calls=0;
  for(const change of [{ownerUrl:ownerUrl.replace('ep-hidden-bird-b673zocn','ep-holy-wildflower-b6vtv1dd')},{ownerUrl:ownerUrl.replace('verify-full','disable')},{ownerUrl:ownerUrl.replace('neondb_owner','vapt_api_preview')},{tag:'ordinary-restaurant'},{ownerUrl:ownerUrl+'&options=unsafe'}])await assert.rejects(create({ownerUrl,tag,createPool(){calls++;},...change}),e=>!String(e).includes('synthetic-secret'));
  assert.equal(calls,0);
});
test('private fixture manifest seeds five users, two organizations and three units once; caller cannot broaden cleanup',async()=>{
  const create=await feature(),db=database(),driver=await create({ownerUrl,tag,createPool:()=>db.pool,hash:async()=> 'synthetic-hash'});
  const view=driver.identifiers();assert.equal(view.users.length,5);assert.equal(view.organizations.length,2);assert.equal(view.restaurants.length,3);
  view.users[0].id='foreign';const credentials=await driver.seed();assert.equal(credentials.length,5);assert.equal(credentials.every(v=>v.password.length===43),true);
  await assert.rejects(driver.seed());
  assert.equal(db.queries.filter(v=>v.sql.startsWith('INSERT INTO public.organization_members')).length,5);
  assert.deepEqual(await driver.cleanup(),{rows:0});
  const deletes=db.queries.filter(v=>v.sql.startsWith('DELETE'));
  assert.equal(deletes.length,10);assert.equal(deletes.every(v=>v.sql.includes('WHERE id=$1')&&v.p.length>=3),true);
  assert.doesNotMatch(JSON.stringify(deletes),/foreign|synthetic-hash|synthetic-secret/);
  assert.equal(db.queries.at(-2).sql,'COMMIT');assert.match(db.queries.at(-1).sql,/AS residue/);await driver.close();assert.equal(db.ended(),true);
});
test('fixture collision and failed seed roll back without allowing cleanup of existing identities',async()=>{
  const create=await feature();for(const options of [{collision:true},{seedFailure:true}]){
    const db=database(options),driver=await create({ownerUrl,tag,createPool:()=>db.pool,hash:async()=> 'synthetic-hash'});
    await assert.rejects(driver.seed(),e=>!String(e).includes('synthetic-secret'));assert.equal(db.queries.at(-1).sql,'ROLLBACK');
    await assert.rejects(driver.cleanup());assert.equal(db.queries.some(v=>v.sql.startsWith('DELETE')),false);await driver.close();
  }
});
test('cleanup refuses altered ownership before deletion and rejects nonzero independent readback',async()=>{
  const create=await feature();for(const options of [{mismatch:true},{residue:1}]){
    const db=database(options),driver=await create({ownerUrl,tag,createPool:()=>db.pool,hash:async()=> 'synthetic-hash'});await driver.seed();
    await assert.rejects(driver.cleanup());if(options.mismatch)assert.equal(db.queries.some(v=>v.sql.startsWith('DELETE')),false);await driver.close();
  }
});
test('cleanup releases its single pool connection before independent committed readback',async()=>{
  const create=await feature(),db=database({enforceSingleConnection:true}),driver=await create({ownerUrl,tag,createPool:()=>db.pool,hash:async()=> 'synthetic-hash'});
  await driver.seed();assert.deepEqual(await driver.cleanup(),{rows:0});await driver.close();
});
test('uncertain COMMIT carries a nonsecret code while refusing automatic fixture deletion',async()=>{
  const create=await feature(),db=database({commitUncertain:true}),driver=await create({ownerUrl,tag,createPool:()=>db.pool,hash:async()=> 'synthetic-hash'});
  await assert.rejects(driver.seed(),e=>e.safeCode==='tenant_seed_uncertain'&&!String(e).includes('synthetic-secret'));
  assert.equal(driver.identifiers().users.length,5);await assert.rejects(driver.cleanup());assert.equal(db.queries.some(v=>v.sql.startsWith('DELETE')),false);await driver.close();
});

test('production fixture factory uses only its own exact TLS endpoint and tag, leaving preview rejection intact',async()=>{
  const m=await import('./tenant-preview-fixtures.mjs');assert.equal(typeof m.createProductionTenantFixtureDriver,'function');
  const productionUrl=ownerUrl.replace('ep-hidden-bird-b673zocn','ep-holy-wildflower-b6vtv1dd');
  const productionTag=tag.replace('tenant-smoke-','tenant-production-smoke-');
  const db=database();let options;
  const driver=await m.createProductionTenantFixtureDriver({ownerUrl:productionUrl,tag:productionTag,createPool:v=>{options=v;return db.pool;},hash:async()=> 'synthetic-hash'});
  assert.equal(options.host,'ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech');assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.max,1);
  await driver.seed();assert.equal(driver.identifiers().restaurants.length,3);assert.deepEqual(await driver.cleanup(),{rows:0});await driver.close();
});
test('production fixtures refuse preview, weak TLS, foreign role and unmarked tag before constructing a pool',async()=>{
  const m=await import('./tenant-preview-fixtures.mjs');assert.equal(typeof m.createProductionTenantFixtureDriver,'function');
  const productionUrl=ownerUrl.replace('ep-hidden-bird-b673zocn','ep-holy-wildflower-b6vtv1dd'),productionTag=tag.replace('tenant-smoke-','tenant-production-smoke-');let calls=0;
  for(const changes of [{ownerUrl},{ownerUrl:productionUrl.replace('verify-full','disable')},{ownerUrl:productionUrl.replace('neondb_owner','vapt_api_production')},{tag},{ownerUrl:productionUrl+'&options=unsafe'}])await assert.rejects(m.createProductionTenantFixtureDriver({ownerUrl:productionUrl,tag:productionTag,createPool:()=>{calls++;},...changes}));
  assert.equal(calls,0);
});

async function catalogFeature(){const m=await import('./tenant-preview-fixtures.mjs');assert.equal(typeof m.createProductionCatalogWriterFixtureDriver,'function','single-owner writer fixture missing');return m.createProductionCatalogWriterFixtureDriver;}
const catalogUrl=ownerUrl.replace('ep-hidden-bird-b673zocn','ep-holy-wildflower-b6vtv1dd'),catalogTag='catalog-writer-11111111-1111-4111-8111-111111111111';
const restoredManifest={tag:catalogTag,
  users:[{id:'22222222-2222-4222-8222-222222222222',name:catalogTag,email:catalogTag+'-0@example.invalid'}],
  organizations:[{id:'33333333-3333-4333-8333-333333333333',name:catalogTag,created_by:'22222222-2222-4222-8222-222222222222'}],
  restaurants:[{id:'44444444-4444-4444-8444-444444444444',organization_id:'33333333-3333-4333-8333-333333333333',owner_id:'22222222-2222-4222-8222-222222222222',name:catalogTag,slug:catalogTag}],
  members:[{organization_id:'33333333-3333-4333-8333-333333333333',user_id:'22222222-2222-4222-8222-222222222222',role:'owner',status:'active'}]};
async function restoreFeature(){const m=await import('./tenant-preview-fixtures.mjs');assert.equal(typeof m.restoreProductionCatalogWriterFixtureDriver,'function','existing fixture recovery missing');return m.restoreProductionCatalogWriterFixtureDriver;}
test('restored writer fixture preserves the journal IDs and refuses any new seed before SQL',async()=>{
  const restore=await restoreFeature(),db=database({existingManifest:restoredManifest});
  const driver=await restore({ownerUrl:catalogUrl,tag:catalogTag,manifest:restoredManifest,createPool:()=>db.pool});
  try{assert.deepEqual(driver.identifiers(),restoredManifest);const copy=driver.identifiers();copy.users[0].id='foreign';assert.deepEqual(driver.identifiers(),restoredManifest);
    const before=db.queries.length;await assert.rejects(driver.seed());assert.equal(db.queries.length,before);assert.equal(db.queries.some(q=>q.sql.startsWith('INSERT')),false);
  }finally{await driver.close();}
});
test('restored writer cleanup uses the existing guarded path and deletes only the three journal identities',async()=>{
  const restore=await restoreFeature(),db=database({existingManifest:restoredManifest,enforceSingleConnection:true});
  const driver=await restore({ownerUrl:catalogUrl,tag:catalogTag,manifest:restoredManifest,createPool:()=>db.pool});
  try{assert.deepEqual(await driver.cleanup(),{rows:0});const deletes=db.queries.filter(q=>q.sql.startsWith('DELETE'));
    assert.deepEqual(deletes.map(q=>q.p[0]),['44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222']);
    assert.equal(deletes.every(q=>q.sql.includes('WHERE id=$1')&&q.p.includes(catalogTag)),true);assert.equal(db.queries.some(q=>q.sql.startsWith('INSERT')),false);
  }finally{await driver.close();}
});
test('restoration rejects broadened or unmarked manifests before opening any connection',async()=>{
  const restore=await restoreFeature();let pools=0;
  for(const mutate of [m=>{m.users[0].email='foreign@example.invalid';},m=>{m.members[0].role='admin';},m=>{m.restaurants.push({...m.restaurants[0]});},m=>{m.restaurants[0].owner_id=m.organizations[0].id;},m=>{m.extra=true;}]){
    const manifest=structuredClone(restoredManifest);mutate(manifest);await assert.rejects(()=>restore({ownerUrl:catalogUrl,tag:catalogTag,manifest,createPool:()=>{pools++;}}));
  }
  for(const patch of [{ownerUrl},{ownerUrl:catalogUrl.replace('verify-full','disable')},{tag:'ordinary-restaurant'}])await assert.rejects(()=>restore({ownerUrl:catalogUrl,tag:catalogTag,manifest:restoredManifest,createPool:()=>{pools++;},...patch}));
  assert.equal(pools,0);
});
for(const state of [{mismatch:true},{catalogEffects:1},{residue:1}])test(`restored fixture refuses deletion when ownership or remaining effects differ ${JSON.stringify(state)}`,async()=>{
  const restore=await restoreFeature(),db=database({existingManifest:restoredManifest,...state});
  const driver=await restore({ownerUrl:catalogUrl,tag:catalogTag,manifest:restoredManifest,createPool:()=>db.pool});
  try{await assert.rejects(driver.cleanup());assert.equal(db.queries.some(q=>q.sql.startsWith('DELETE')),false);assert.equal(db.queries.at(-1).sql,'ROLLBACK');}
  finally{await driver.close();}
});
test('writer fixture seeds exactly one verified owner, one Business organization and one explicitly marked restaurant',async()=>{
  const create=await catalogFeature(),db=database(),driver=await create({ownerUrl:catalogUrl,tag:catalogTag,createPool:()=>db.pool,hash:async()=> 'synthetic-hash'});
  const manifest=driver.identifiers();assert.equal(manifest.users.length,1);assert.equal(manifest.organizations.length,1);assert.equal(manifest.restaurants.length,1);assert.equal(manifest.members.length,1);assert.equal(manifest.restaurants[0].slug,catalogTag);assert.equal(manifest.members[0].role,'owner');
  assert.equal((await driver.seed()).length,1);await assert.rejects(driver.seed());assert.deepEqual(await driver.cleanup(),{rows:0});
  assert.equal(db.queries.filter(q=>q.sql.startsWith('INSERT INTO better_auth."user"')).length,1);assert.equal(db.queries.filter(q=>q.sql.startsWith('INSERT INTO public.restaurants')).length,1);assert.equal(db.queries.find(q=>q.sql.startsWith('INSERT INTO public.organization_subscriptions')).p[1],'business');
  assert.equal(db.queries.filter(q=>q.sql.startsWith('DELETE')).length,3);await driver.close();
});
test('writer fixture rejects wrong production target and tenant-smoke tags before constructing a pool',async()=>{
  const create=await catalogFeature();let count=0;for(const change of [{ownerUrl},{tag},{ownerUrl:catalogUrl.replace('verify-full','disable')}])await assert.rejects(create({ownerUrl:catalogUrl,tag:catalogTag,createPool:()=>{count++;},...change}));assert.equal(count,0);
});
test('writer fixture refuses cleanup while catalog work, sessions or domain children remain',async()=>{
  const create=await catalogFeature(),db=database({catalogEffects:1}),driver=await create({ownerUrl:catalogUrl,tag:catalogTag,createPool:()=>db.pool,hash:async()=> 'synthetic-hash'});await driver.seed();await assert.rejects(driver.cleanup());assert.equal(db.queries.filter(q=>q.sql.startsWith('DELETE')).length,0);assert.equal(db.queries.at(-1).sql,'ROLLBACK');await driver.close();
});

for(const phase of ['before-delete','before-commit'])test(`writer cleanup cancellation ${phase} rolls back rather than committing identity deletion`,async()=>{
  const create=await catalogFeature(),db=database(),abort=new AbortController();let cleaning=false,armed=false;
  const pool={...db.pool,async connect(){const client=await db.pool.connect();return{release:()=>client.release(),async query(sql,p){
    const value=await client.query(sql,p);
    if(cleaning&&!armed&&(phase==='before-delete'&&sql.includes('AS residue')||phase==='before-commit'&&sql.startsWith('DELETE FROM better_auth.'))){armed=true;abort.abort();}
    return value;
  }};}};
  const driver=await create({ownerUrl:catalogUrl,tag:catalogTag,createPool:()=>pool,hash:async()=> 'synthetic-hash'});await driver.seed();cleaning=true;const start=db.queries.length;
  try{await assert.rejects(driver.cleanup({signal:abort.signal}));const queries=db.queries.slice(start);assert.equal(queries.some(q=>q.sql==='COMMIT'),false);assert.equal(queries.at(-1).sql,'ROLLBACK');if(phase==='before-delete')assert.equal(queries.some(q=>q.sql.startsWith('DELETE')),false);}
  finally{await driver.close();}
});
