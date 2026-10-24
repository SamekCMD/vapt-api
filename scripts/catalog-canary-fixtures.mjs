// Operator-only synthetic fixtures. No CLI, environment fallback, DDL or provider auth.
import {isDeepStrictEqual} from 'node:util';
const ensure=value=>{if(!value)throw Error('Catalog canary fixture guard failed');};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function scope(manifest){
  ensure(/^tenant-smoke-[0-9a-f-]{36}$/.test(manifest?.tag)&&uuid(manifest.tag.slice(13))
    &&manifest.users?.length===5&&manifest.restaurants?.length===3&&manifest.organizations?.length===2);
  const target=manifest.restaurants[0],actor=manifest.users[0];
  ensure(uuid(target?.id)&&uuid(actor?.id)&&target.owner_id===actor.id&&target.name===manifest.tag&&target.slug===manifest.tag+'-0'
    &&manifest.organizations.some(org=>org.id===target.organization_id&&org.created_by===actor.id));
  ensure(manifest.restaurants.every(r=>uuid(r.id)&&r.name===manifest.tag)&&manifest.users.every(u=>uuid(u.id)&&u.name===manifest.tag));
  return{target,actor,restaurantIds:manifest.restaurants.map(r=>r.id),userIds:manifest.users.map(u=>u.id)};
}
function checkedPrepared(p){
  ensure(uuid(p?.restaurantId)&&uuid(p.actorId)&&uuid(p.operationId)&&typeof p.version==='string'&&/^[1-9][0-9]{0,18}$/.test(p.version)
    &&BigInt(p.version)<=9223372036854775807n&&/^tenant-smoke-[0-9a-f-]{36}$/.test(p.tag)&&uuid(p.tag.slice(13))
    &&p.slug===p.tag+'-0'&&p.bytes===8388608&&Number.isSafeInteger(p.descriptionBytes)&&p.descriptionBytes>0&&p.descriptionBytes<8388608);
}
function ready(p,r,admissionClosed){
  checkedPrepared(p);ensure(admissionClosed===true&&r?.operationId===p.operationId&&r.restaurantId===p.restaurantId&&r.version===p.version
    &&r.phase==='ready'&&r.committed===true&&r.retryable===false);
}
function keys(p){const prefix=`catalog/v1/preview/restaurants/${p.restaurantId}/`;return[
  `catalog/v1/preview/slugs/${p.slug}.json`,prefix+'manifest.json',prefix+`snapshots/${p.version}.json`];}
async function identity(pool){
  ensure(pool?.options?.host==='ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech'&&pool.options.database==='vapt'
    &&pool.options.user==='neondb_owner'&&pool.options.ssl?.rejectUnauthorized===true&&pool.options.max===1);
  const row=(await pool.query('select current_database() as database,current_user as role')).rows[0];
  ensure(row?.database==='vapt'&&row.role==='neondb_owner');
}
async function owned(client,manifest,s){
  const found=(await client.query('select id,name,slug,owner_id,organization_id,description from public.restaurants where id=ANY($1::uuid[]) for update',[s.restaurantIds])).rows;
  ensure(found.length===3);
  for(const row of found){const expected=manifest.restaurants.find(r=>r.id===row.id);ensure(expected&&['id','name','slug','owner_id','organization_id'].every(k=>row[k]===expected[k]));}
  return found.find(r=>r.id===s.target.id);
}
export async function prepareCatalogCanaryBoundary({pool,manifest,operationId,buildCatalog}){
  const s=scope(manifest);ensure(uuid(operationId)&&typeof buildCatalog==='function');await identity(pool);
  const client=await pool.connect();let committing=false;
  try{
    await client.query('BEGIN');const target=await owned(client,manifest,s);ensure(target.description===null);
    const existing=(await client.query(`select (
      (select count(*) from public.catalog_publication_operations where restaurant_id=ANY($1::uuid[]) or actor_id=ANY($2::uuid[]))+
      (select count(*) from public.catalog_publication_revisions where restaurant_id=ANY($1::uuid[])))::int n`,[s.restaurantIds,s.userIds])).rows[0];ensure(existing?.n===0);
    const seq=(await client.query('select last_value::text,is_called from public.catalog_publication_version_seq')).rows[0];
    const version=(BigInt(seq.last_value)+(seq.is_called?1n:0n)).toString();
    await client.query('update public.restaurants set description=$2 where id=$1',[target.id,'']);
    const catalog=await buildCatalog(client,target.id);ensure(catalog.restaurant.id===target.id&&catalog.restaurant.name===manifest.tag&&catalog.items.length===0);
    const descriptionBytes=8388608-Buffer.byteLength(JSON.stringify({version,catalog}));ensure(descriptionBytes>0&&descriptionBytes<8388608);
    await client.query('update public.restaurants set description=$2 where id=$1',[target.id,'a'.repeat(descriptionBytes)]);
    ensure(Buffer.byteLength(JSON.stringify({version,catalog:await buildCatalog(client,target.id)}))===8388608);
    const prepared={restaurantId:target.id,actorId:s.actor.id,operationId,version,tag:manifest.tag,slug:target.slug,bytes:8388608,descriptionBytes};checkedPrepared(prepared);
    committing=true;await client.query('COMMIT');return prepared;
  }catch{await client.query('ROLLBACK').catch(()=>{});throw Object.assign(Error('Catalog boundary preparation stopped'),{safeCode:committing?'catalog_fixture_prepare_uncertain':'catalog_fixture_prepare_failed'});}
  finally{client.release();}
}
async function journal(client,s,p,lock=false){
  const rows=(await client.query(`select operation_id,actor_id,restaurant_id,fingerprint,version::text,
    snapshot->>'version' as snapshot_version,snapshot#>>'{catalog,restaurant,id}' as snapshot_restaurant,
    snapshot#>>'{catalog,restaurant,name}' as snapshot_name,snapshot#>>'{catalog,restaurant,slug}' as snapshot_slug,
    octet_length(snapshot#>>'{catalog,restaurant,description}') as description_bytes,
    jsonb_array_length(snapshot#>'{catalog,items}') as items_count
    from public.catalog_publication_operations where restaurant_id=ANY($1::uuid[]) or actor_id=ANY($2::uuid[])${lock?' for update':''}`,[s.restaurantIds,s.userIds])).rows;
  ensure(rows.length===1);const row=rows[0];
  ensure(row.operation_id===p.operationId&&row.actor_id===p.actorId&&row.restaurant_id===p.restaurantId&&row.version===p.version
    &&row.snapshot_version===p.version&&row.snapshot_restaurant===p.restaurantId&&row.snapshot_name===p.tag&&row.snapshot_slug===p.slug
    &&row.description_bytes===p.descriptionBytes&&row.items_count===0&&/^[a-f0-9]{64}$/.test(row.fingerprint));
  const revisions=(await client.query('select restaurant_id,version::text from public.catalog_publication_revisions where restaurant_id=ANY($1::uuid[])',[s.restaurantIds])).rows;
  ensure(revisions.length===1&&revisions[0].restaurant_id===p.restaurantId&&revisions[0].version===p.version);return row;
}
export async function inspectCatalogCanaryJournal({pool,manifest,prepared}){
  const s=scope(manifest);checkedPrepared(prepared);ensure(prepared.restaurantId===s.target.id&&prepared.actorId===s.actor.id&&prepared.tag===manifest.tag);
  await identity(pool);await journal(pool,s,prepared);return{committed:true,operationId:prepared.operationId,version:prepared.version};
}
export async function retireCatalogCanaryArtifacts({prepared:p,receipt,admissionClosed,store}){
  ready(p,receipt,admissionClosed);const paths=keys(p);
  const read=async(index,max)=>{const text=await store.get(paths[index]);ensure(typeof text==='string'&&Buffer.byteLength(text)<=max);return JSON.parse(text);};
  const mapping=await read(0,4096),manifest=await read(1,4096),snapshot=await read(2,8388608);
  ensure(isDeepStrictEqual(mapping,{restaurantId:p.restaurantId,version:p.version,canonicalSlug:p.slug,tombstone:false}));
  ensure(isDeepStrictEqual(manifest,{restaurantId:p.restaurantId,version:p.version,canonicalSlug:p.slug,previousVersion:null}));
  ensure(snapshot.version===p.version&&snapshot.catalog?.restaurant?.id===p.restaurantId&&snapshot.catalog.restaurant.name===p.tag
    &&snapshot.catalog.restaurant.slug===p.slug&&snapshot.catalog.items?.length===0&&typeof snapshot.catalog.restaurant.description==='string'
    &&Buffer.byteLength(snapshot.catalog.restaurant.description)===p.descriptionBytes&&Buffer.byteLength(JSON.stringify(snapshot))===8388608);
  // All accepted work is terminal and admission is closed. Retain create-once
  // fences, rather than DELETE allowing an old timed-out PUT to recreate data.
  const fences=[{...mapping,tombstone:true},{retired:true,restaurantId:p.restaurantId,version:p.version},{retired:true,version:p.version}].map(v=>JSON.stringify(v));
  for(let i=0;i<paths.length;i++){
    await store.put(paths[i],fences[i]); // No retry on uncertain writes.
    ensure(await store.get(paths[i])===fences[i]);
  }
  for(let i=0;i<paths.length;i++)ensure(await store.get(paths[i])===fences[i]);
  return{restaurantId:p.restaurantId,version:p.version,keys:paths,readbackConfirmed:true,retainedFenceBytes:fences.reduce((n,v)=>n+Buffer.byteLength(v),0)};
}
export async function cleanupCatalogCanaryJournal({pool,manifest,prepared:p,receipt,admissionClosed,retired}){
  const s=scope(manifest);ready(p,receipt,admissionClosed);ensure(p.restaurantId===s.target.id&&p.actorId===s.actor.id&&p.tag===manifest.tag
    &&retired?.restaurantId===p.restaurantId&&retired.version===p.version&&retired.readbackConfirmed===true&&isDeepStrictEqual(retired.keys,keys(p))
    &&Number.isSafeInteger(retired.retainedFenceBytes)&&retired.retainedFenceBytes>0&&retired.retainedFenceBytes<1024);
  await identity(pool);const client=await pool.connect();let committing=false;
  try{
    await client.query('BEGIN');await owned(client,manifest,s);const row=await journal(client,s,p,true);
    const result=await client.query(`delete from public.catalog_publication_operations where operation_id=$1::uuid and actor_id=$2::uuid
      and restaurant_id=$3::uuid and version=$4::bigint and fingerprint=$5::text returning operation_id`,[p.operationId,p.actorId,p.restaurantId,p.version,row.fingerprint]);
    ensure(result.rowCount===1);committing=true;await client.query('COMMIT');
  }catch{await client.query('ROLLBACK').catch(()=>{});throw Object.assign(Error('Catalog journal cleanup stopped'),{safeCode:committing?'catalog_cleanup_uncertain':'catalog_cleanup_failed'});}
  finally{client.release();}
  const residual=(await pool.query('select count(*)::int n from public.catalog_publication_operations where restaurant_id=ANY($1::uuid[]) or actor_id=ANY($2::uuid[])',[s.restaurantIds,s.userIds])).rows[0];
  ensure(residual?.n===0);return{journalRows:0};
}
