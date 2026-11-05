// Operator-only, fixed production target. Nothing runs on import. No environment
// discovery, CLI, schema changes, login, provider credentials or automatic retry.
import {randomBytes,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Pool} from 'pg';
import {hashPassword} from 'better-auth/crypto';
const ensure=value=>{if(!value)throw Error('Catalog onboarding fixture guard failed');};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const version=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const fields=(value,keys)=>value&&Object.keys(value).sort().join(',')===keys;
const etag=value=>typeof value==='string'&&/^"[a-f0-9]{32}"$/.test(value);
export async function createProductionCatalogOnboardingFixtureDriver(options={}){
  const m=structuredClone(options.manifest);
  ensure(fields(m,'accountId,operationIds,tag,user')&&fields(m.user,'email,id,name')&&fields(m.operationIds,'draft,finalize')
    &&typeof m.tag==='string'&&m.tag.startsWith('catalog-writer-')&&uuid(m.tag.slice(15))&&m.user.name===m.tag&&m.user.email===m.tag+'-0@example.invalid'
    &&[m.user.id,m.accountId,m.operationIds.draft,m.operationIds.finalize].every(uuid)
    &&new Set([m.user.id,m.accountId,m.operationIds.draft,m.operationIds.finalize]).size===4);
  let url;try{url=new URL(options.ownerUrl);}catch{throw Error('Catalog onboarding target refused');}
  ensure(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech'
    &&url.pathname==='/vapt'&&url.username==='neondb_owner'&&url.password&&['','5432'].includes(url.port)&&!url.hash
    &&url.searchParams.get('sslmode')==='verify-full'&&[...url.searchParams].every(([key,value])=>key==='sslmode'&&value==='verify-full'||key==='channel_binding'&&value==='require'));
  const pool=(options.createPool??(config=>new Pool(config)))({host:url.hostname,port:5432,database:'vapt',user:'neondb_owner',password:decodeURIComponent(url.password),
    ssl:{rejectUnauthorized:true},max:1,connectionTimeoutMillis:10000,statement_timeout:8000,lock_timeout:2000});url=undefined;
  const u=m.user.id,ids=m.operationIds;let attempted=false,seeded=false,retirementAttempted=false,retired=false,cleanupAttempted=false,closed=false;
  async function identity(){const row=(await pool.query('select current_database() as database,current_user as role')).rows[0];ensure(row?.database==='vapt'&&row.role==='neondb_owner');}
  try{await identity();}catch{await pool.end();throw Error('Catalog onboarding identity refused');}
  function active(signal){ensure(!closed&&seeded&&!cleanupAttempted);signal?.throwIfAborted();}
  async function ownedIdentity(client){
    const users=(await client.query('select id,name,email,"emailVerified",image from better_auth."user" where id=$1',[u])).rows;
    ensure(isDeepStrictEqual(users,[{...m.user,emailVerified:true,image:null}]));
    const accounts=(await client.query('select id,"accountId","providerId","userId",(password is not null and length(password)>0) as has_password,\n      ("accessToken" is null and "refreshToken" is null and "idToken" is null and "scope" is null) as clean from better_auth.account where "userId"=$1',[u])).rows;
    ensure(isDeepStrictEqual(accounts,[{id:m.accountId,accountId:u,providerId:'credential',userId:u,has_password:true,clean:true}]));
    ensure((await client.query('select count(*)::int n from better_auth.verification where identifier=$1',[m.user.email])).rows[0]?.n===0);
  }
  const identityDomainSql=`select (
    (select count(*) from public.organizations where created_by=$1)+
    (select count(*) from public.organization_members where user_id=$1)+
    (select count(*) from public.organization_subscriptions where billing_contact_user_id=$1)+
    (select count(*) from public.restaurants where owner_id=$1)+
    (select count(*) from public.account_preferences where user_id=$1)+
    (select count(*) from public.onboarding_intents where actor_id=$1)+
    (select count(*) from public.catalog_publication_operations where actor_id=$1)+
    (select count(*) from public.restaurant_activation_progress where completed_by=$1)+
    (select count(*) from public.organization_billing_legacy_resources where legacy_owner_id=$1)+
    (select count(*) from better_auth.session where "userId"=$1)
  )::int n`;
  function checkedProbe(value){
    const p=structuredClone(value),receipt=p?.receipts?.[0];
    ensure(p?.ok===true&&p.uncertain===false&&p.stage==='verified'&&p.requests===12&&p.draftReplayConfirmed===true&&p.finalizeReplayConfirmed===true
      &&isDeepStrictEqual(p.operationIds,ids)&&uuid(p.restaurantId)&&uuid(p.organizationId)
      &&new Set([u,m.accountId,p.restaurantId,p.organizationId]).size===4&&p.receipts.length===1
      &&isDeepStrictEqual(receipt,{operationId:ids.finalize,restaurantId:p.restaurantId,phase:'ready',version:receipt.version,committed:true,retryable:false})&&version(receipt.version));
    return p;
  }
  async function state(client,p,locking,signal){
    const r=p.restaurantId,o=p.organizationId,v=p.receipts[0].version;
    async function query(sql,params){signal.throwIfAborted();const value=await client.query(sql,params);signal.throwIfAborted();return value;}
    if(locking){
      await query('select id from public.organizations where id=$1 for update',[o]);
      await query('select id from public.restaurants where id=$1 for update',[r]);
      await query('select id from better_auth."user" where id=$1 for update',[u]);
    }
    await ownedIdentity(client);signal.throwIfAborted();
    ensure(isDeepStrictEqual((await query('select id,name,created_by from public.organizations where id=$1 or created_by=$2',[o,u])).rows,[{id:o,name:m.tag,created_by:u}]));
    ensure(isDeepStrictEqual((await query('select id,organization_id,owner_id,name,slug from public.restaurants where id=$1 or organization_id=$2 or owner_id=$3',[r,o,u])).rows,
      [{id:r,organization_id:o,owner_id:u,name:m.tag,slug:m.tag}]));
    ensure(isDeepStrictEqual((await query('select organization_id,user_id,role,status from public.organization_members where organization_id=$1 or user_id=$2',[o,u])).rows,
      [{organization_id:o,user_id:u,role:'owner',status:'active'}]));
    // A foreign organization's billing contact also holds a reference to this
    // identity. Refuse it BEFORE fencing R2, not only at the post-delete check.
    ensure(isDeepStrictEqual((await query('select organization_id,billing_contact_user_id from public.organization_subscriptions where organization_id=$1 or billing_contact_user_id=$2',[o,u])).rows,
      [{organization_id:o,billing_contact_user_id:u}]));
    ensure(isDeepStrictEqual((await query('select user_id,organization_id,restaurant_id from public.account_preferences where user_id=$1 or restaurant_id=$2 or organization_id=$3',[u,r,o])).rows,
      [{user_id:u,organization_id:o,restaurant_id:r}]));
    const sessions=(await query('select count(*)::int total,count(*) filter(where "expiresAt">clock_timestamp())::int live from better_auth.session where "userId"=$1',[u])).rows[0];
    ensure(isDeepStrictEqual(sessions,locking?{total:0,live:0}:{total:1,live:1}));
    const intents=(await query(`select operation_id,actor_id,organization_id,restaurant_id,kind,result,
      fingerprint=encode(digest(convert_to(case when kind='initial_draft' then jsonb_build_array('initial_draft',$1::uuid,$4::text,$4::text,null)
        else jsonb_build_array('finalize',$1::uuid,$2::uuid) end::text,'UTF8'),'sha256'),'hex') as fingerprint_valid
      from public.onboarding_intents where actor_id=$1 or restaurant_id=$2 or organization_id=$3`,[u,r,o,m.tag])).rows;
    ensure(intents.length===2);
    for(const [operation_id,kind]of [[ids.draft,'initial_draft'],[ids.finalize,'finalize']]){
      ensure(isDeepStrictEqual(intents.find(row=>row.operation_id===operation_id),{operation_id,actor_id:u,organization_id:o,restaurant_id:r,kind,result:{restaurantId:r},fingerprint_valid:true}));
    }
    const trial=(await query(`select s.plan_type,s.plan_status,s.billing_contact_user_id,
      (s.trial_started_at is not null and s.trial_started_at=r.onboarding_completed_at and s.trial_ends_at=s.trial_started_at+interval '3 days') as valid,
      (s.stripe_customer_id is null and s.stripe_subscription_id is null and s.stripe_subscription_item_id is null and s.stripe_current_period_end is null
      and not s.stripe_cancel_at_period_end and s.stripe_state_updated_at is null and s.stripe_checkout_session_id is null and s.stripe_checkout_plan_type is null
      and s.stripe_checkout_expires_at is null and s.billing_last_error is null and s.subscription_canceled_at is null) as untouched
      from public.organization_subscriptions s join public.restaurants r on r.organization_id=s.organization_id where s.organization_id=$1`,[o])).rows;
    ensure(isDeepStrictEqual(trial,[{plan_type:'starter',plan_status:'trialing',billing_contact_user_id:u,valid:true,untouched:true}]));
    const effects=(await query(`select (
      (select count(*) from public.menu_items where restaurant_id=$1)+(select count(*) from public.orders where restaurant_id=$1)+
      (select count(*) from public.table_sessions where restaurant_id=$1)+(select count(*) from public.restaurant_activation_progress where restaurant_id=$1 or completed_by=$2)+
      (select count(*) from public.billing_email_outbox where organization_id=$3)+(select count(*) from public.billing_provider_events where organization_id=$3)+
      (select count(*) from public.organization_billing_resources where organization_id=$3)+(select count(*) from public.organization_billing_legacy_resources where organization_id=$3 or legacy_owner_id=$2)+
      (select count(*) from public.payment_effect_outbox where restaurant_id=$1)+(select count(*) from public.payment_provider_accounts where restaurant_id=$1)+
      (select count(*) from public.payment_transactions where restaurant_id=$1)
    )::int n`,[r,u,o])).rows[0];ensure(effects?.n===0);
    const current=(await query(`select id,name,slug,whatsapp,address,phone,hours,description,primary_color as "primaryColor",secondary_color as "secondaryColor",
      font_family as "fontFamily",logo_url as "logoUrl",total_tables as "totalTables",max_tables as "maxTables",payment_mode as "paymentMode",max_pending_orders as "maxPendingOrders",
      local_enabled as "localEnabled",delivery_enabled as "deliveryEnabled",updated_at as "updatedAt",onboarding_completed,onboarding_status,onboarding_step
      from public.restaurants where id=$1`,[r])).rows[0];
    ensure(current?.onboarding_completed===true&&current.onboarding_status==='complete'&&current.onboarding_step===2&&current.totalTables===4&&current.maxTables===4
      &&current.localEnabled===true&&current.deliveryEnabled===true&&current.logoUrl===null&&current.description===null);
    const {onboarding_completed,onboarding_status,onboarding_step,...dto}=current;dto.updatedAt=new Date(dto.updatedAt).toISOString();
    const snapshot={version:v,catalog:{restaurant:dto,items:[]}};
    const rows=(await query('select operation_id,actor_id,restaurant_id,fingerprint,version::text,snapshot,result,previous_slug from public.catalog_publication_operations where restaurant_id=$1 or actor_id=$2'+(locking?' for update':''),[r,u])).rows;
    const fingerprint=createHash('sha256').update(JSON.stringify({mutation:{input:{restaurantId:r},type:'onboarding.finalize'},operationId:ids.finalize,protocol:'vapt.catalog.command.v1',restaurantId:r,userId:u})).digest('hex');
    const row=rows[0];ensure(rows.length===1&&row.operation_id===ids.finalize&&row.actor_id===u&&row.restaurant_id===r&&row.fingerprint===fingerprint
      &&row.version===v&&(row.previous_slug===null||row.previous_slug===m.tag)&&isDeepStrictEqual(row.snapshot,snapshot)&&row.result?.id===r&&row.result.onboardingCompleted===true
      &&row.result.name===m.tag&&row.result.slug===m.tag&&row.result.totalTables===4);
    ensure(isDeepStrictEqual((await query('select restaurant_id,version::text from public.catalog_publication_revisions where restaurant_id=$1'+(locking?' for update':''),[r])).rows,[{restaurant_id:r,version:v}]));
    return{snapshot,fingerprint};
  }
  const domainResidueSql=`select (
    (select count(*) from public.restaurants where id=$1 or organization_id=$2 or owner_id=$3)+
    (select count(*) from public.organizations where id=$2 or created_by=$3)+
    (select count(*) from public.organization_members where organization_id=$2 or user_id=$3)+
    (select count(*) from public.organization_subscriptions where organization_id=$2 or billing_contact_user_id=$3)+
    (select count(*) from public.onboarding_intents where restaurant_id=$1 or organization_id=$2 or actor_id=$3)+
    (select count(*) from public.account_preferences where restaurant_id=$1 or organization_id=$2 or user_id=$3)+
    (select count(*) from public.catalog_publication_operations where restaurant_id=$1 or actor_id=$3)+
    (select count(*) from public.catalog_publication_revisions where restaurant_id=$1)
  )::int n`;
  return{
    identifiers(){ensure(!closed);return structuredClone(m);},
    async seed(){
      ensure(!closed&&!attempted);attempted=true;let password,hash,client,committing=false;
      try{
        password=randomBytes(32).toString('base64url');hash=await (options.hash??hashPassword)(password);client=await pool.connect();await client.query('BEGIN');
        const collision=(await client.query(`select ((select count(*) from better_auth."user" where id=$1 or email=$2)+
          (select count(*) from better_auth.account where id=$3)+(select count(*) from public.restaurants where slug=$4)+
          (select count(*) from public.organizations where name=$4))::int n`,[u,m.user.email,m.accountId,m.tag])).rows[0];ensure(collision?.n===0);
        await client.query('insert into better_auth."user"(id,name,email,"emailVerified") values($1,$2,$3,true)',[u,m.tag,m.user.email]);
        await client.query('insert into better_auth.account(id,"accountId","providerId","userId",password,"updatedAt") values($1,$2,\'credential\',$3,$4,now())',[m.accountId,u,u,hash]);
        committing=true;await client.query('COMMIT');seeded=true;return{...m.user,password};
      }catch{await client?.query('ROLLBACK').catch(()=>{});throw Object.assign(Error('Catalog onboarding seed stopped'),{safeCode:committing?'onboarding_seed_uncertain':'onboarding_seed_failed'});}
      finally{password=undefined;hash=undefined;client?.release();}
    },
    async inspectOnboarding({probe,signal:caller}={}){
      active(caller);const p=checkedProbe(probe),signal=caller?AbortSignal.any([caller,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000);let client;
      try{await identity();client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await state(client,p,false,signal);
        return{verified:true,trialVerified:true,intentRows:2,restaurantId:p.restaurantId,organizationId:p.organizationId,version:p.receipts[0].version};
      }catch{throw Error('Catalog onboarding readback stopped');}
      finally{if(client){let broken;try{await client.query('ROLLBACK');}catch{broken=Error('Onboarding rollback failed');}client.release(broken);if(broken)throw Error('Catalog onboarding readback stopped');}}
    },
    async retireOnboarding({probe,store,verifyLoggedOut,signal:caller}={}){
      active(caller);ensure(!retirementAttempted);retirementAttempted=true;let client,objectWrites=0,committing=false;
      try{
        const p=checkedProbe(probe);ensure(typeof verifyLoggedOut==='function'&&typeof store?.get==='function'&&typeof store.put==='function');
        const signal=caller?AbortSignal.any([caller,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000);let requests=0;
        async function external(work){ensure(requests++<16);const bound=AbortSignal.any([signal,AbortSignal.timeout(15000)]);bound.throwIfAborted();const result=await work(bound);bound.throwIfAborted();return result;}
        ensure((await external(bound=>verifyLoggedOut(bound)))?.status===401);await identity();client=await pool.connect();await client.query('BEGIN');
        const {snapshot,fingerprint}=await state(client,p,true,signal),r=p.restaurantId,o=p.organizationId,v=p.receipts[0].version;
        const prefix=`catalog/v1/production/restaurants/${r}/`,slugKey=`catalog/v1/production/slugs/${m.tag}.json`,manifestKey=prefix+'manifest.json',snapshotKey=prefix+`snapshots/${v}.json`;
        async function read(key,maxBytes=4096){const value=await external(bound=>store.get(key,{signal:bound,maxBytes}));ensure(value&&typeof value.body==='string'&&Buffer.byteLength(value.body)<=maxBytes&&etag(value.etag));return value;}
        const mapping=await read(slugKey),registration=await read(manifestKey),object=await read(snapshotKey,65536);
        const slug={restaurantId:r,version:v,canonicalSlug:m.tag,tombstone:false};
        ensure(isDeepStrictEqual(JSON.parse(mapping.body),slug)&&isDeepStrictEqual(JSON.parse(registration.body),{restaurantId:r,version:v,canonicalSlug:m.tag,previousVersion:null})&&isDeepStrictEqual(JSON.parse(object.body),snapshot));
        const fences=[{key:slugKey,source:mapping,body:JSON.stringify({...slug,tombstone:true})},{key:snapshotKey,source:object,body:JSON.stringify({retired:true,version:v})}];
        for(const fence of fences){objectWrites++;const result=await external(bound=>store.put(fence.key,fence.body,{ifMatch:fence.source.etag,signal:bound}));ensure(etag(result?.etag));ensure((await read(fence.key)).body===fence.body);}
        for(const fence of fences)ensure((await read(fence.key)).body===fence.body);
        ensure(isDeepStrictEqual(await read(manifestKey),registration));signal.throwIfAborted();
        ensure((await client.query('delete from public.catalog_publication_operations where operation_id=$1 and actor_id=$2 and restaurant_id=$3 and fingerprint=$4 and version=$5::bigint returning operation_id',[ids.finalize,u,r,fingerprint,v])).rowCount===1);
        ensure((await client.query('delete from public.catalog_publication_revisions where restaurant_id=$1 and version=$2::bigint returning restaurant_id',[r,v])).rowCount===1);
        for(const [key,kind]of [[ids.draft,'initial_draft'],[ids.finalize,'finalize']])ensure((await client.query('delete from public.onboarding_intents where operation_id=$1 and actor_id=$2 and restaurant_id=$3 and organization_id=$4 and kind=$5 returning operation_id',[key,u,r,o,kind])).rowCount===1);
        ensure((await client.query('delete from public.account_preferences where user_id=$1 and restaurant_id=$2 and organization_id=$3 returning user_id',[u,r,o])).rowCount===1);
        ensure((await client.query('delete from public.restaurants where id=$1 and organization_id=$2 and owner_id=$3 and name=$4 and slug=$4 returning id',[r,o,u,m.tag])).rowCount===1);
        ensure((await client.query('delete from public.organizations where id=$1 and created_by=$2 and name=$3 returning id',[o,u,m.tag])).rowCount===1);
        ensure((await client.query(domainResidueSql,[r,o,u])).rows[0]?.n===0);signal.throwIfAborted();committing=true;await client.query('COMMIT');client.release();client=null;
        ensure((await pool.query(domainResidueSql,[r,o,u])).rows[0]?.n===0);retired=true;
        return{readbackConfirmed:true,restaurantId:r,organizationId:o,journalRows:0,revisionRows:0,intentRows:0,objectWrites,keys:[slugKey,manifestKey,snapshotKey]};
      }catch{await client?.query('ROLLBACK').catch(()=>{});throw Object.assign(Error('Catalog onboarding retirement stopped'),{safeCode:objectWrites||committing?'onboarding_retirement_uncertain':'onboarding_retirement_failed'});}
      finally{client?.release();}
    },
    async cleanupIdentity({signal}={}){
      active(signal);ensure(!retirementAttempted||retired);cleanupAttempted=true;let client,committing=false;
      try{
        await identity();client=await pool.connect();await client.query('BEGIN');await client.query('select id from better_auth."user" where id=$1 for update',[u]);await ownedIdentity(client);
        ensure((await client.query(identityDomainSql,[u])).rows[0]?.n===0);signal?.throwIfAborted();
        ensure((await client.query('delete from better_auth."user" where id=$1 and name=$2 and email=$3 returning id',[u,m.tag,m.user.email])).rowCount===1);
        const residue=`select ((select count(*) from better_auth."user" where id=$1 or email=$2)+(select count(*) from better_auth.account where "userId"=$1)+
          (select count(*) from better_auth.session where "userId"=$1)+(select count(*) from better_auth.verification where identifier=$2))::int n`;
        ensure((await client.query(residue,[u,m.user.email])).rows[0]?.n===0);signal?.throwIfAborted();committing=true;await client.query('COMMIT');client.release();client=null;
        ensure((await pool.query(residue,[u,m.user.email])).rows[0]?.n===0);return{rows:0};
      }catch{await client?.query('ROLLBACK').catch(()=>{});throw Object.assign(Error('Catalog onboarding identity cleanup stopped'),{safeCode:committing?'onboarding_cleanup_uncertain':'onboarding_cleanup_failed'});}
      finally{client?.release();}
    },
    async close(){if(!closed){closed=true;await pool.end();}}
  };
}
