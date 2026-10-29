// Operator-only readback before an unused branding upload. No CLI/default
// transport, seed, SQL/R2 writes or retries. Provider TLS/source pins are also
// checked by the fixed controller; a supplied callback is not that evidence.
import {isDeepStrictEqual} from 'node:util';
const ensure=v=>{if(!v)throw Error('Image baseline guard failed');};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const version=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const ordered=rows=>rows.map(v=>JSON.stringify(Object.fromEntries(Object.entries(v).sort()))).sort();
export async function verifyProductionCatalogImageBaseline(options={}){
  let client;
  try{
    const {pool,store,operationId}=options,m=structuredClone(options.manifest),baseline=structuredClone(options.baseline);
    ensure(typeof m?.tag==='string'&&m.tag.startsWith('catalog-writer-')&&uuid(m.tag.slice(15))&&m.users?.length===1&&m.organizations?.length===1&&m.restaurants?.length===1&&m.members?.length===1);
    const [u]=m.users,[o]=m.organizations,[r]=m.restaurants;
    ensure([u.id,o.id,r.id,operationId].every(uuid)&&new Set([u.id,o.id,r.id]).size===3&&u.name===m.tag&&u.email===m.tag+'-0@example.invalid'
      &&o.name===m.tag&&o.created_by===u.id&&r.name===m.tag&&r.slug===m.tag&&r.owner_id===u.id&&r.organization_id===o.id
      &&isDeepStrictEqual(m.members,[{organization_id:o.id,user_id:u.id,role:'owner',status:'active'}]));
    const receipt=baseline?.receipts?.[0];
    ensure(baseline?.ok===true&&baseline.uncertain===false&&baseline.stage==='verified'&&baseline.receipts.length===1
      &&receipt.operationId===operationId&&receipt.restaurantId===r.id&&receipt.phase==='ready'&&receipt.committed===true&&receipt.retryable===false&&version(receipt.version));
    ensure(pool?.options?.host==='ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech'&&pool.options.database==='vapt'&&pool.options.user==='neondb_owner'
      &&pool.options.ssl?.rejectUnauthorized===true&&pool.options.max===1&&typeof store?.get==='function');
    const timeout=AbortSignal.timeout(90000),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
    async function query(sql,params){signal.throwIfAborted();const result=await client.query(sql,params);signal.throwIfAborted();return result;}
    signal.throwIfAborted();const identity=(await pool.query('select current_database() as database,current_user as role')).rows[0];ensure(identity?.database==='vapt'&&identity.role==='neondb_owner');
    signal.throwIfAborted();client=await pool.connect();await query('BEGIN READ ONLY');
    const found={users:(await query('select id,name,email from better_auth."user" where id=$1',[u.id])).rows,
      organizations:(await query('select id,name,created_by from public.organizations where id=$1',[o.id])).rows,
      restaurants:(await query('select id,organization_id,owner_id,name,slug from public.restaurants where id=$1 or organization_id=$2 or owner_id=$3',[r.id,o.id,u.id])).rows,
      members:(await query('select organization_id,user_id,role,status from public.organization_members where organization_id=$1 or user_id=$2',[o.id,u.id])).rows};
    for(const name of ['users','organizations','restaurants','members'])ensure(isDeepStrictEqual(ordered(found[name]),ordered(m[name])));
    const counts=(await query(`select
      (select count(*)::int from better_auth.session where "userId"=$1) sessions,
      (select count(*)::int from better_auth.session where "userId"=$1 and "expiresAt">now()) active_sessions,
      (select count(*)::int from public.menu_items where restaurant_id=$2) items,
      (select count(*)::int from public.orders where restaurant_id=$2) orders,
      (select count(*)::int from public.table_sessions where restaurant_id=$2) tables`,[u.id,r.id])).rows[0];
    ensure(isDeepStrictEqual(counts,{sessions:1,active_sessions:1,items:0,orders:0,tables:0}));
    const current=(await query('select description,logo_url,onboarding_status from public.restaurants where id=$1',[r.id])).rows[0];
    ensure(current?.description===null&&current.logo_url===null&&current.onboarding_status==='complete');
    const rows=(await query('select operation_id,actor_id,restaurant_id,fingerprint,version::text,snapshot,previous_slug from public.catalog_publication_operations where restaurant_id=$1 or actor_id=$2',[r.id,u.id])).rows;
    ensure(rows.length===1);const row=rows[0],state=row.snapshot;
    ensure(row.operation_id===operationId&&row.actor_id===u.id&&row.restaurant_id===r.id&&row.version===receipt.version&&/^[a-f0-9]{64}$/.test(row.fingerprint)
      &&(row.previous_slug===null||row.previous_slug===r.slug)&&state?.version===receipt.version&&state.catalog?.restaurant?.id===r.id
      &&state.catalog.restaurant.name===m.tag&&state.catalog.restaurant.slug===m.tag&&state.catalog.restaurant.description===null&&state.catalog.restaurant.logoUrl===null
      &&Array.isArray(state.catalog.items)&&state.catalog.items.length===0&&Buffer.byteLength(JSON.stringify(state))<=65536);
    ensure(isDeepStrictEqual((await query('select restaurant_id,version::text from public.catalog_publication_revisions where restaurant_id=$1',[r.id])).rows,[{restaurant_id:r.id,version:receipt.version}]));
    const prefix=`catalog/v1/production/restaurants/${r.id}/`,keys=[`catalog/v1/production/slugs/${r.slug}.json`,prefix+'manifest.json',prefix+`snapshots/${receipt.version}.json`];
    const values=[{restaurantId:r.id,version:receipt.version,canonicalSlug:r.slug,tombstone:false},{restaurantId:r.id,version:receipt.version,canonicalSlug:r.slug,previousVersion:null},state];
    for(const [index,key]of keys.entries()){
      const active=AbortSignal.any([signal,AbortSignal.timeout(15000)]);active.throwIfAborted();
      const object=await new Promise((resolve,reject)=>{
        const cancel=()=>{active.removeEventListener('abort',cancel);reject(Error('Baseline read stopped'));};
        active.addEventListener('abort',cancel,{once:true});if(active.aborted)return cancel();
        Promise.resolve().then(()=>{active.throwIfAborted();return store.get(key,{signal:active,maxBytes:index===2?65536:4096});}).then(value=>{active.removeEventListener('abort',cancel);resolve(value);},error=>{active.removeEventListener('abort',cancel);reject(error);});
      });
      ensure(object&&typeof object.body==='string'&&Buffer.byteLength(object.body)<=(index===2?65536:4096)&&isDeepStrictEqual(JSON.parse(object.body),values[index]));
    }
    signal.throwIfAborted();return{verified:true,restaurantId:r.id,operationId,version:receipt.version,keysChecked:3};
  }catch{throw Error('Catalog image baseline preflight stopped');}
  finally{if(client){
    let broken;
    try{await client.query('ROLLBACK');}catch{broken=Error('Catalog image baseline preflight stopped');}
    try{client.release(broken);}catch{broken=Error('Catalog image baseline preflight stopped');}
    if(broken)throw broken;
  }}
}
