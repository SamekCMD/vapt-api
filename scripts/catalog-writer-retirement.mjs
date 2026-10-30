// Operator-only retirement for the successful bounded CRUD probe. No CLI,
// default transport, authentication, seed, flags, deployment or identity DELETE.
// The enclosing one-shot controller must own the only credentials, drain all
// probe requests, log out normally, discard credentials, and stop on uncertainty.
import {isDeepStrictEqual} from 'node:util';
const ensure=value=>{if(!value)throw Error('Catalog writer retirement guard failed');};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const ordered=rows=>rows.map(v=>JSON.stringify(Object.fromEntries(Object.entries(v).sort()))).sort();
const names=['create','patch','private','mixed','delete','rebuild'];

export async function retireProductionCatalogWriterFixture(options={}){
  return retireProductionCatalogFixture(options,false);
}
// Fixed separate profile: one ready empty rebuild and one unused branding
// upload, already retired. Never relax the legacy five-version CRUD contract.
export async function retireProductionCatalogImageFixture(options={}){
  return retireProductionCatalogFixture(options,true);
}
// Fixed branding-only cycle, never a caller-selected operation count. Product
// references need a separate versioned item deletion before fixture cleanup.
export async function retireProductionCatalogBrandingReferenceFixture(options={}){
  return retireProductionCatalogFixture(options,'reference');
}
async function retireProductionCatalogFixture(options,image){
  let client,objectWrites=0,committing=false;
  try{
    const reference=image==='reference';
    const {pool,store,verifyLoggedOut}=options,manifest=structuredClone(options.manifest),probe=structuredClone(options.probe),ids=structuredClone(options.operationIds);
    ensure(typeof manifest?.tag==='string'&&manifest.tag.startsWith('catalog-writer-')&&uuid(manifest.tag.slice(15))
      &&manifest.users?.length===1&&manifest.organizations?.length===1&&manifest.restaurants?.length===1&&manifest.members?.length===1);
    const [actor]=manifest.users,[org]=manifest.organizations,[target]=manifest.restaurants;
    ensure([actor.id,org.id,target.id].every(uuid)&&new Set([actor.id,org.id,target.id]).size===3
      &&actor.name===manifest.tag&&actor.email===manifest.tag+'-0@example.invalid'
      &&org.name===manifest.tag&&org.created_by===actor.id&&target.owner_id===actor.id&&target.organization_id===org.id
      &&target.name===manifest.tag&&target.slug===manifest.tag
      &&isDeepStrictEqual(manifest.members,[{organization_id:org.id,user_id:actor.id,role:'owner',status:'active'}]));
    const selectedNames=reference?['rebuild','attach','detach','advance']:image?['rebuild']:names;
    ensure(ids&&Object.keys(ids).sort().join(',')===[...selectedNames].sort().join(',')&&selectedNames.every(n=>uuid(ids[n]))&&new Set(Object.values(ids)).size===selectedNames.length
      &&probe?.ok===true&&probe.uncertain===false&&probe.stage==='verified'&&probe.receipts?.length===selectedNames.length);
    const imageProbe=image?structuredClone(options.imageProbe):null;
    if(image){
      const parts=imageProbe?.objectKey?.split('/');
      ensure(imageProbe?.ok===true&&imageProbe.uncertain===false&&imageProbe.stage==='verified'
        &&parts?.length===3&&parts[0]===target.id&&parts[1]==='branding'&&uuid(parts[2])&&typeof options.verifyImageAbsent==='function');
      if(reference)ensure(imageProbe.restaurantId===target.id&&imageProbe.itemId==='branding'&&imageProbe.baselineVersion===probe.receipts[0].version
        &&imageProbe.protectedDeletions===2&&imageProbe.imageAbsentConfirmed===true&&isDeepStrictEqual(imageProbe.receipts,probe.receipts.slice(1)));
      else ensure(imageProbe.imageBytes===42&&imageProbe.uploadVerified===true&&imageProbe.leaseRetired===true&&imageProbe.staleWritesBlocked===2
        &&uuid(imageProbe.leaseId)&&imageProbe.leaseId!==ids.rebuild);
    }
    const publicReceipts=[];
    for(const [index,name]of selectedNames.entries()){
      const r=probe.receipts[index];ensure(r.operationId===ids[name]&&r.restaurantId===target.id&&r.phase==='ready'&&r.committed===true&&r.retryable===false);
      if(name==='private')ensure(r.version===null);
      else{ensure(version(r.version)&&(publicReceipts.length===0||BigInt(r.version)>BigInt(publicReceipts.at(-1).version)));publicReceipts.push(r);}
    }
    ensure(pool?.options?.host==='ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech'&&pool.options.database==='vapt'
      &&pool.options.user==='neondb_owner'&&pool.options.ssl?.rejectUnauthorized===true&&pool.options.max===1
      &&typeof verifyLoggedOut==='function'&&typeof store?.get==='function'&&typeof store.put==='function');
    const deadline=AbortSignal.timeout(90000),active=options.signal?AbortSignal.any([options.signal,deadline]):deadline;let requests=0;
    async function external(work){
      ensure(requests++<32);const signal=AbortSignal.any([active,AbortSignal.timeout(15000)]);signal.throwIfAborted();
      // The concrete S3 transport observes this signal. Drain its promise before
      // releasing the SQL transaction, instead of abandoning an in-flight PUT.
      const value=await work(signal);signal.throwIfAborted();return value;
    }
    ensure((await external(signal=>verifyLoggedOut(signal)))?.status===401);
    const identity=(await pool.query('select current_database() as database,current_user as role')).rows[0];ensure(identity?.database==='vapt'&&identity.role==='neondb_owner');
    active.throwIfAborted();client=await pool.connect();active.throwIfAborted();await client.query('BEGIN');
    // Match the existing ownership cleanup order. Locks also block FK-dependent
    // session/item insertion while the target-specific retirement is in flight.
    await client.query('select id from public.organizations where id=$1 for update',[org.id]);
    await client.query('select id from public.restaurants where id=$1 for update',[target.id]);
    await client.query('select id from better_auth."user" where id=$1 for update',[actor.id]);
    const found={
      users:(await client.query('select id,name,email from better_auth."user" where id=$1',[actor.id])).rows,
      organizations:(await client.query('select id,name,created_by from public.organizations where id=$1',[org.id])).rows,
      restaurants:(await client.query('select id,organization_id,owner_id,name,slug from public.restaurants where id=$1 or organization_id=$2 or owner_id=$3',[target.id,org.id,actor.id])).rows,
      members:(await client.query('select organization_id,user_id,role,status from public.organization_members where organization_id=$1 or user_id=$2 for update',[org.id,actor.id])).rows,
    };
    for(const key of ['users','organizations','restaurants','members'])ensure(isDeepStrictEqual(ordered(found[key]),ordered(manifest[key])));
    const effects=(await client.query(`select (
      (select count(*) from better_auth.session where "userId"=$1)+
      (select count(*) from public.menu_items where restaurant_id=$2)+
      (select count(*) from public.orders where restaurant_id=$2)+
      (select count(*) from public.table_sessions where restaurant_id=$2)+
      (select count(*) from public.account_preferences where user_id=$1 or restaurant_id=$2 or organization_id=$3)+
      (select count(*) from public.restaurant_activation_progress where restaurant_id=$2 or completed_by=$1)+
      (select count(*) from public.onboarding_intents where actor_id=$1 or restaurant_id=$2 or organization_id=$3)+
      (select count(*) from public.billing_email_outbox where organization_id=$3)+
      (select count(*) from public.billing_provider_events where organization_id=$3)+
      (select count(*) from public.organization_billing_resources where organization_id=$3)+
      (select count(*) from public.organization_billing_legacy_resources where organization_id=$3)+
      (select count(*) from public.payment_effect_outbox where restaurant_id=$2)+
      (select count(*) from public.payment_provider_accounts where restaurant_id=$2)+
      (select count(*) from public.payment_transactions where restaurant_id=$2)
    )::int n`,[actor.id,target.id,org.id])).rows[0];ensure(effects?.n===0);
    const current=(await client.query('select description,logo_url,onboarding_status from public.restaurants where id=$1',[target.id])).rows[0];
    ensure(current?.description===(image?null:manifest.tag+' public')&&current.logo_url===null&&current.onboarding_status==='complete');
    const rows=(await client.query(`select operation_id,actor_id,restaurant_id,fingerprint,version::text,snapshot,previous_slug
      from public.catalog_publication_operations where restaurant_id=$1 or actor_id=$2 for update`,[target.id,actor.id])).rows;
    ensure(rows.length===(reference?4:image?1:5));const states=[];
    for(const [index,receipt]of publicReceipts.entries()){
      const row=rows.find(r=>r.operation_id===receipt.operationId);
      ensure(row&&row.actor_id===actor.id&&row.restaurant_id===target.id&&row.version===receipt.version&&/^[a-f0-9]{64}$/.test(row.fingerprint)
        &&(row.previous_slug===null||row.previous_slug===target.slug)&&row.snapshot?.version===receipt.version
        &&row.snapshot.catalog?.restaurant?.id===target.id&&row.snapshot.catalog.restaurant.name===manifest.tag
        &&row.snapshot.catalog.restaurant.slug===target.slug&&row.snapshot.catalog.restaurant.logoUrl===(reference&&index===1?'https://pub-a1c726374f434a7d8c2e2324d61a4de7.r2.dev/'+imageProbe.objectKey:null)
        &&Array.isArray(row.snapshot.catalog.items)&&row.snapshot.catalog.items.every(i=>i.restaurantId===target.id&&i.imageUrl===null)
        &&Buffer.byteLength(JSON.stringify(row.snapshot))<=65536);states.push(row.snapshot);
      if(reference)ensure(row.snapshot.catalog.items.length===0&&row.snapshot.catalog.restaurant.description===null);
    }
    ensure(states.at(-1).catalog.items.length===0&&(image?states[0].catalog.restaurant.description===null:states.at(-2).catalog.items.length===0));
    const last=publicReceipts.at(-1).version,previous=image&&!reference?null:publicReceipts.at(-2).version;
    const revisions=(await client.query('select restaurant_id,version::text from public.catalog_publication_revisions where restaurant_id=$1 for update',[target.id])).rows;
    ensure(isDeepStrictEqual(revisions,[{restaurant_id:target.id,version:last}]));
    const prefix=`catalog/v1/production/restaurants/${target.id}/`,slugKey=`catalog/v1/production/slugs/${target.slug}.json`,manifestKey=prefix+'manifest.json';
    async function read(key,max){
      const object=await external(signal=>store.get(key,{signal,maxBytes:max}));
      ensure(object&&typeof object.body==='string'&&Buffer.byteLength(object.body)<=max&&typeof object.etag==='string'
        &&object.etag.length>0&&object.etag.length<=1024&&!/[\r\n]/.test(object.etag));return object;
    }
    const mapping=await read(slugKey,4096),registration=await read(manifestKey,4096);
    const expectedMapping={restaurantId:target.id,version:last,canonicalSlug:target.slug,tombstone:false};
    ensure(isDeepStrictEqual(JSON.parse(mapping.body),expectedMapping)
      &&isDeepStrictEqual(JSON.parse(registration.body),{restaurantId:target.id,version:last,canonicalSlug:target.slug,previousVersion:previous}));
    const artifacts=[{key:slugKey,object:mapping,fence:JSON.stringify({...expectedMapping,tombstone:true})}];
    for(const [index,state]of states.entries()){
      const key=prefix+`snapshots/${state.version}.json`,object=await read(key,65536),value=JSON.parse(object.body),fence=JSON.stringify({retired:true,version:state.version});
      ensure(isDeepStrictEqual(value,state)||((reference?index<2:!image&&index<3)&&isDeepStrictEqual(value,{retired:true,version:state.version})));
      artifacts.push({key,object,fence});
    }
    // A retired lease plus a rejected stale PUT is not evidence of physical
    // object absence: both can succeed while uploaded bytes still exist.
    // The controller must supply one authenticated exact-object readback;
    // never infer absence from a public CDN, 401/403, or a generic failure.
    if(image)ensure(isDeepStrictEqual(await external(signal=>options.verifyImageAbsent({objectKey:imageProbe.objectKey,signal})),
      {absent:true,bucket:'vapt-assets-production',objectKey:imageProbe.objectKey}));
    // Validate the entire owned set BEFORE the first write. Preserve the valid
    // manifest as a small fence: late DO pruning can still read it and finish,
    // rather than turning harmless cleanup into repeated failing alarms.
    for(const a of artifacts){
      if(a.object.body!==a.fence){
        objectWrites++;const result=await external(signal=>store.put(a.key,a.fence,{ifMatch:a.object.etag,signal}));
        ensure(result&&typeof result.etag==='string'&&result.etag.length>0);
      }
      ensure((await read(a.key,4096)).body===a.fence);
    }
    for(const a of artifacts)ensure((await read(a.key,4096)).body===a.fence);
    const registrationAfter=await read(manifestKey,4096);ensure(registrationAfter.etag===registration.etag&&registrationAfter.body===registration.body);
    for(const row of rows){
      active.throwIfAborted();
      const deleted=await client.query(`delete from public.catalog_publication_operations where operation_id=$1 and actor_id=$2
        and restaurant_id=$3 and version=$4::bigint and fingerprint=$5 returning operation_id`,[row.operation_id,actor.id,target.id,row.version,row.fingerprint]);ensure(deleted.rowCount===1);
    }
    active.throwIfAborted();ensure((await client.query('delete from public.catalog_publication_revisions where restaurant_id=$1 and version=$2::bigint returning restaurant_id',[target.id,last])).rowCount===1);
    const residueSql=`select ((select count(*) from public.catalog_publication_operations where restaurant_id=$1 or actor_id=$2)+
      (select count(*) from public.catalog_publication_revisions where restaurant_id=$1))::int n`;
    ensure((await client.query(residueSql,[target.id,actor.id])).rows[0]?.n===0);
    active.throwIfAborted();committing=true;await client.query('COMMIT');client.release();client=null;
    ensure((await pool.query(residueSql,[target.id,actor.id])).rows[0]?.n===0);
    return{restaurantId:target.id,journalRows:0,revisionRows:0,keys:[slugKey,manifestKey,...states.map(s=>prefix+`snapshots/${s.version}.json`)],
      readbackConfirmed:true,...(image?{imageAbsentConfirmed:true}:{}),objectWrites,retainedFenceBytes:Buffer.byteLength(registration.body)+artifacts.reduce((n,a)=>n+Buffer.byteLength(a.fence),0)};
  }catch{
    if(client)await client.query('ROLLBACK').catch(()=>{});
    throw Object.assign(Error('Catalog writer retirement stopped'),{safeCode:objectWrites>0||committing?'catalog_writer_retirement_uncertain':'catalog_writer_retirement_failed'});
  }finally{client?.release();}
}
