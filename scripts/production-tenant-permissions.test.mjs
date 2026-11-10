import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('./production-tenant-permissions.mjs').catch(error=>{
  if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};
});
const allowed=['organization_read','member_read','subscription_read','journal_read','onboarding_read'];
const denied=['schema_create','member_insert','subscription_update','restaurant_org_update','restaurant_insert','journal_update','sequence_set','contact_update','organization_truncate'];
function fixture() {
  const flags=Object.fromEntries([['schema_usage',true],...allowed.map(key=>[key,true]),...denied.map(key=>[key,false])]);
  const role={rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,memberships:0};
  const narrow=Array.from({length:4},()=>({prosecdef:true,allowed:true,public_execute:false,proconfig:['search_path=pg_catalog, public']}));
  const queries=[];
  const f={flags,role,narrow,queries,invalidCode:'P0401'};
  f.client={query:async sql=>{
    queries.push(sql);
    if(/^\s*select\s+has_table_privilege/i.test(sql))return {rows:[flags]};
    if(sql.includes('from pg_roles'))return {rows:[role]};
    if(sql.includes('from pg_proc'))return {rows:narrow};
    if(sql.includes('create_initial_restaurant_draft(')&&sql.startsWith('select public.'))throw Object.assign(Error('synthetic session rejected'),{code:f.invalidCode});
    if(/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) /.test(sql))return {rows:[]};
    throw Error('Unexpected SQL boundary');
  }};return f;
}
test.beforeEach(()=>assert.equal(typeof module.verifyProductionTenantPermissions,'function','non-switching permission verifier missing'));
async function verify(f){return module.verifyProductionTenantPermissions(f.client);}
test('verifies effective application privileges while owner has no SET ROLE permission, without impersonation or grants',async()=>{
  const f=fixture(),result=await verify(f);
  assert.deepEqual(result,{permissionMode:'effective_acl',roleLimited:true,allowedReadChecks:5,deniedChecks:9,invalidSessionDenied:true});
  assert(f.queries.every(sql=>!/^\s*(SET|GRANT|REVOKE|ALTER|CREATE ROLE)\b/i.test(sql)));
});
for(const key of allowed)test('refuses missing read capability '+key,async()=>{const f=fixture();f.flags[key]=false;await assert.rejects(verify(f));});
for(const key of denied)test('refuses unintended effective permission '+key,async()=>{const f=fixture();f.flags[key]=true;await assert.rejects(verify(f));});
test('does not interpret unknown effective privilege as denied',async()=>{const f=fixture();f.flags.sequence_set=null;await assert.rejects(verify(f));});
test('rejects inherited administrative membership',async()=>{const f=fixture();f.role.memberships=1;await assert.rejects(verify(f));});
test('rejects elevated application role',async()=>{const f=fixture();f.role.rolbypassrls=true;await assert.rejects(verify(f));});
test('rejects public execution of a privileged routine',async()=>{const f=fixture();f.narrow[0].public_execute=true;await assert.rejects(verify(f));});
test('rejects missing fixed search path',async()=>{const f=fixture();f.narrow[0].proconfig=[];await assert.rejects(verify(f));});
test('wrong invalid-session result cannot satisfy the verifier and its savepoint is rolled back',async()=>{
  const f=fixture();f.invalidCode='42501';await assert.rejects(verify(f));assert(f.queries.includes('ROLLBACK TO SAVEPOINT permissions_probe'));
});
