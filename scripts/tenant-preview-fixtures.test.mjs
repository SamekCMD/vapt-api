import assert from 'node:assert/strict';
import test from 'node:test';
const ownerUrl='postgresql://neondb_owner:synthetic-secret@ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full';
const tag='tenant-smoke-11111111-1111-4111-8111-111111111111';
async function feature(){const m=await import('./tenant-preview-fixtures.mjs').catch(()=>null);assert.equal(typeof m?.createTenantFixtureDriver,'function','tenant fixture not implemented');return m.createTenantFixtureDriver;}
function database({collision=false,mismatch=false,residue=0,seedFailure=false,enforceSingleConnection=false}={}){
  const users=[],organizations=[],restaurants=[],members=[],queries=[];let ended=false,held=false;
  const query=async(sql,p=[])=>{
    queries.push({sql,p});
    if(sql.includes('current_database()'))return{rows:[{database:'vapt',role:'neondb_owner'}]};
    if(sql.includes('AS collision'))return{rows:[{collision:collision?1:0}]};
    if(sql.startsWith('INSERT INTO better_auth."user"'))users.push({id:p[0],name:p[1],email:p[2]});
    if(sql.startsWith('INSERT INTO better_auth.account')&&seedFailure)throw Error('synthetic-secret');
    if(sql.startsWith('INSERT INTO public.organizations'))organizations.push({id:p[0],name:p[1],created_by:p[2]});
    if(sql.startsWith('INSERT INTO public.organization_members'))members.push({organization_id:p[0],user_id:p[1],role:p[2],status:'active'});
    if(sql.startsWith('INSERT INTO public.restaurants'))restaurants.push({id:p[0],organization_id:p[1],owner_id:p[2],name:p[3],slug:p[4]});
    if(sql.includes('AS owned_snapshot'))return{rows:[{owned_snapshot:{users,organizations,restaurants:restaurants.map(v=>({...v,owner_id:mismatch?'foreign':v.owner_id})),members}}]};
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
