// Operator-only. No schema/grants, email, Stripe, R2 or DO operations.
import {randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Pool} from 'pg';
import {hashPassword} from 'better-auth/crypto';
const ensure=value=>{if(!value)throw Error('Tenant preview fixture guard failed');};
const ordered=rows=>rows.map(v=>JSON.stringify(Object.fromEntries(Object.entries(v).sort()))).sort();
export async function createTenantFixtureDriver({ownerUrl,tag,createPool=options=>new Pool(options),hash=hashPassword}={}){
  let url;try{url=new URL(ownerUrl);}catch{throw Error('Tenant preview fixture target failed');}
  ensure(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech'
    &&url.pathname==='/vapt'&&url.username==='neondb_owner'&&url.password&&['','5432'].includes(url.port)&&!url.hash
    &&url.searchParams.get('sslmode')==='verify-full'&&[...url.searchParams].every(([k,v])=>k==='sslmode'&&v==='verify-full'||k==='channel_binding'&&v==='require')
    &&/^tenant-smoke-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tag));
  const pool=createPool({host:url.hostname,port:5432,database:'vapt',user:'neondb_owner',password:decodeURIComponent(url.password),
    ssl:{rejectUnauthorized:true},max:1,connectionTimeoutMillis:10000,statement_timeout:8000,lock_timeout:2000});
  ownerUrl=undefined;url=undefined;
  try{const row=(await pool.query('select current_database() as database,current_user as role')).rows[0];ensure(row?.database==='vapt'&&row.role==='neondb_owner');}
  catch{await pool.end();throw Error('Tenant preview fixture identity failed');}
  const users=['owner','admin','manager','staff','owner'].map((role,index)=>({id:randomUUID(),name:tag,email:`${tag}-${index}@example.invalid`,role}));
  const organizations=[{id:randomUUID(),name:tag,created_by:users[0].id},{id:randomUUID(),name:tag,created_by:users[4].id}];
  const members=users.map((user,index)=>({organization_id:organizations[index===4?1:0].id,user_id:user.id,role:user.role,status:'active'}));
  const restaurants=[0,0,1].map((org,index)=>({id:randomUUID(),organization_id:organizations[org].id,owner_id:organizations[org].created_by,name:tag,slug:`${tag}-${index}`}));
  const userIds=users.map(v=>v.id),orgIds=organizations.map(v=>v.id),restaurantIds=restaurants.map(v=>v.id);
  const residueSql=`SELECT (
    (select count(*) from public.organizations where id=ANY($1::uuid[]))+
    (select count(*) from public.organization_members where organization_id=ANY($1::uuid[]) or user_id=ANY($2::uuid[]))+
    (select count(*) from public.organization_subscriptions where organization_id=ANY($1::uuid[]))+
    (select count(*) from public.restaurants where organization_id=ANY($1::uuid[]) or id=ANY($3::uuid[]))+
    (select count(*) from public.account_preferences where user_id=ANY($2::uuid[]) or organization_id=ANY($1::uuid[]))+
    (select count(*) from public.onboarding_intents where actor_id=ANY($2::uuid[]) or organization_id=ANY($1::uuid[]))+
    (select count(*) from public.menu_items where restaurant_id=ANY($3::uuid[]))+
    (select count(*) from public.orders where restaurant_id=ANY($3::uuid[]))+
    (select count(*) from public.payment_effect_outbox where restaurant_id=ANY($3::uuid[]))+
    (select count(*) from public.billing_email_outbox where organization_id=ANY($1::uuid[]))+
    (select count(*) from public.billing_provider_events where organization_id=ANY($1::uuid[]))+
    (select count(*) from public.catalog_publication_operations where restaurant_id=ANY($3::uuid[]) or actor_id=ANY($2::uuid[]))+
    (select count(*) from better_auth."user" where id=ANY($2::uuid[]))+
    (select count(*) from better_auth.account where "userId"=ANY($2::uuid[]))+
    (select count(*) from better_auth.session where "userId"=ANY($2::uuid[]))
  )::integer AS residue`;
  let attempted=false,seeded=false,cleaned=false;
  return{
    identifiers(){return structuredClone({tag,users:users.map(({role,...v})=>v),organizations,restaurants,members});},
    async seed(){
      ensure(!attempted);attempted=true;
      const credentials=users.map((v,index)=>({...v,organizationId:members[index].organization_id,password:randomBytes(32).toString('base64url')}));
      const hashes=await Promise.all(credentials.map(v=>hash(v.password)));const client=await pool.connect();let committing=false;
      try{
        await client.query('BEGIN');
        const collision=(await client.query(`SELECT ((select count(*) from better_auth."user" where id=ANY($1::uuid[]) or email=ANY($2::text[]))+
          (select count(*) from public.organizations where id=ANY($3::uuid[]))+
          (select count(*) from public.restaurants where id=ANY($4::uuid[]) or slug=ANY($5::text[])))::integer AS collision`,[userIds,users.map(v=>v.email),orgIds,restaurantIds,restaurants.map(v=>v.slug)])).rows[0];ensure(collision?.collision===0);
        for(const [index,user]of users.entries()){
          await client.query('INSERT INTO better_auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[user.id,user.name,user.email]);
          await client.query('INSERT INTO better_auth.account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES(gen_random_uuid(),$1::text,\'credential\',$1::uuid,$2,now(),now())',[user.id,hashes[index]]);
        }
        for(const [index,org]of organizations.entries()){
          await client.query('INSERT INTO public.organizations(id,name,created_by) VALUES($1,$2,$3)',[org.id,org.name,org.created_by]);
          await client.query("INSERT INTO public.organization_subscriptions(organization_id,plan_type,plan_status,billing_contact_user_id) VALUES($1,$2,'active',$3)",[org.id,index===0?'business':'pro',org.created_by]);
        }
        for(const member of members)await client.query("INSERT INTO public.organization_members(organization_id,user_id,role,status) VALUES($1,$2,$3,'active')",[member.organization_id,member.user_id,member.role]);
        for(const r of restaurants)await client.query(`INSERT INTO public.restaurants(id,organization_id,owner_id,name,slug,plan_type,plan_status,onboarding_completed,onboarding_status,onboarding_step,total_tables,max_tables,max_pending_orders,payment_mode)
          VALUES($1,$2,$3,$4,$5,$6,'active',true,'complete',2,2,2,10,'open_tab')`,[r.id,r.organization_id,r.owner_id,r.name,r.slug,r.organization_id===orgIds[0]?'business':'pro']);
        committing=true;await client.query('COMMIT');seeded=true;return credentials;
      }catch{await client.query('ROLLBACK').catch(()=>{});const error=Error(committing?'Tenant preview fixture seed uncertain':'Tenant preview fixture seed failed');if(committing)error.safeCode='tenant_seed_uncertain';throw error;}
      finally{hashes.fill('');client.release();}
    },
    async cleanup(){
      ensure(seeded&&!cleaned);const client=await pool.connect();
      try{
        await client.query('BEGIN');
        // Lock identities before checking the full owned relation set. Foreign
        // members/units or altered markers abort BEFORE any DELETE.
        await client.query('SELECT id FROM public.organizations WHERE id=ANY($1::uuid[]) FOR UPDATE',[orgIds]);
        await client.query('SELECT id FROM public.restaurants WHERE id=ANY($1::uuid[]) FOR UPDATE',[restaurantIds]);
        await client.query('SELECT id FROM better_auth."user" WHERE id=ANY($1::uuid[]) FOR UPDATE',[userIds]);
        const snapshot=(await client.query(`SELECT jsonb_build_object(
          'users',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'email',email)),'[]') from better_auth."user" where id=ANY($2::uuid[])),
          'organizations',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'created_by',created_by)),'[]') from public.organizations where id=ANY($1::uuid[])),
          'restaurants',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'organization_id',organization_id,'owner_id',owner_id,'name',name,'slug',slug)),'[]') from public.restaurants where organization_id=ANY($1::uuid[]) or id=ANY($3::uuid[])),
          'members',(select coalesce(jsonb_agg(jsonb_build_object('organization_id',organization_id,'user_id',user_id,'role',role,'status',status)),'[]') from public.organization_members where organization_id=ANY($1::uuid[]) or user_id=ANY($2::uuid[]))
        ) AS owned_snapshot`,[orgIds,userIds,restaurantIds])).rows[0]?.owned_snapshot;
        for(const [key,expected]of Object.entries({users:users.map(({role,...v})=>v),organizations,restaurants,members}))ensure(snapshot&&isDeepStrictEqual(ordered(snapshot[key]),ordered(expected)));
        // Unexpected effects are not ours to discard just because their tenant
        // is synthetic. This smoke never creates onboarding/billing/catalog work.
        const effects=(await client.query(`SELECT ((select count(*) from public.onboarding_intents where organization_id=ANY($1::uuid[]))+
          (select count(*) from public.billing_email_outbox where organization_id=ANY($1::uuid[]))+
          (select count(*) from public.billing_provider_events where organization_id=ANY($1::uuid[]))+
          (select count(*) from public.catalog_publication_operations where restaurant_id=ANY($2::uuid[]))+
          (select count(*) from public.payment_effect_outbox where restaurant_id=ANY($2::uuid[])))::integer AS residue`,[orgIds,restaurantIds])).rows[0];ensure(effects?.residue===0);
        for(const r of restaurants)await client.query('DELETE FROM public.restaurants WHERE id=$1 AND organization_id=$2 AND owner_id=$3 AND name=$4 AND slug=$5',[r.id,r.organization_id,r.owner_id,r.name,r.slug]);
        for(const org of organizations)await client.query('DELETE FROM public.organizations WHERE id=$1 AND created_by=$2 AND name=$3',[org.id,org.created_by,org.name]);
        for(const user of users)await client.query('DELETE FROM better_auth."user" WHERE id=$1 AND name=$2 AND email=$3',[user.id,user.name,user.email]);
        ensure((await client.query(residueSql,[orgIds,userIds,restaurantIds])).rows[0]?.residue===0);
        await client.query('COMMIT');
      }catch{await client.query('ROLLBACK').catch(()=>{});throw Error('Tenant preview fixture cleanup failed');}
      finally{client.release();}
      // Release first: this operator intentionally has a one-connection pool.
      // Independent transaction verifies committed cleanup. No DELETE retry.
      try{ensure((await pool.query(residueSql,[orgIds,userIds,restaurantIds])).rows[0]?.residue===0);cleaned=true;return{rows:0};}
      catch{throw Error('Tenant preview fixture cleanup readback failed');}
    },
    async close(){await pool.end();},
  };
}
