// Pre-commit effective ACL verification as the migration owner, without role switching.
// PostgreSQL evaluates PUBLIC/inherited permissions through has_*_privilege.
// This is not a claim of authenticating with the application credential.
import assert from 'node:assert/strict';
export async function verifyProductionTenantPermissions(client) {
  const row=(await client.query(`select has_table_privilege('vapt_api_production','public.organizations','SELECT') as organization_read,
    has_table_privilege('vapt_api_production','public.organization_members','SELECT') as member_read,
    has_table_privilege('vapt_api_production','public.organization_subscriptions','SELECT') as subscription_read,
    has_table_privilege('vapt_api_production','public.catalog_publication_operations','SELECT') as journal_read,
    has_table_privilege('vapt_api_production','public.onboarding_intents','SELECT') as onboarding_read,
    has_schema_privilege('vapt_api_production','public','USAGE') as schema_usage,
    has_schema_privilege('vapt_api_production','public','CREATE') as schema_create,
    has_table_privilege('vapt_api_production','public.organization_members','INSERT') as member_insert,
    has_table_privilege('vapt_api_production','public.organization_subscriptions','UPDATE') as subscription_update,
    has_column_privilege('vapt_api_production','public.restaurants','organization_id','UPDATE') as restaurant_org_update,
    has_table_privilege('vapt_api_production','public.restaurants','INSERT') as restaurant_insert,
    has_table_privilege('vapt_api_production','public.catalog_publication_operations','UPDATE') as journal_update,
    has_sequence_privilege('vapt_api_production','public.catalog_publication_version_seq','UPDATE') as sequence_set,
    has_column_privilege('vapt_api_production','public.organization_subscriptions','billing_contact_user_id','UPDATE') as contact_update,
    has_table_privilege('vapt_api_production','public.organizations','TRUNCATE') as organization_truncate`)).rows[0];
  for(const key of ['organization_read','member_read','subscription_read','journal_read','onboarding_read','schema_usage'])assert.equal(row?.[key],true);
  for(const key of ['schema_create','member_insert','subscription_update','restaurant_org_update','restaurant_insert','journal_update','sequence_set','contact_update','organization_truncate'])assert.equal(row?.[key],false);
  const role=(await client.query("select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,(select count(*)::int from pg_auth_members where member=pg_roles.oid) as memberships from pg_roles where rolname='vapt_api_production'")).rows[0];
  assert(role?.rolcanlogin===true&&role.rolsuper===false&&role.rolcreatedb===false&&role.rolcreaterole===false&&role.rolreplication===false&&role.rolbypassrls===false&&role.memberships===0);
  const narrow=(await client.query("select p.prosecdef,p.proconfig,has_function_privilege('vapt_api_production',p.oid,'EXECUTE') as allowed,has_function_privilege('public',p.oid,'EXECUTE') as public_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])",
    [['reconcile_organization_subscription','create_initial_restaurant_draft','create_organization_restaurant_draft','finalize_restaurant_onboarding']])).rows;
  assert.equal(narrow.length,4);
  assert(narrow.every(value=>value.prosecdef===true&&value.allowed===true&&value.public_execute===false&&Array.isArray(value.proconfig)&&value.proconfig.some(config=>/^search_path=pg_catalog,\s*public$/.test(config))));
  await client.query('SAVEPOINT permissions_probe');let code;
  try {await client.query("select public.create_initial_restaurant_draft('9fe119c4-d93b-4330-aad1-40eaa5fb872c','3c4c59ad-bd02-4e0e-97bf-69d15127d2f1','12ad89ab-a57a-438b-a146-452bf8a3e3b4','Gate Test','gate-test',null)");}
  catch(error){code=error.code;}
  finally {await client.query('ROLLBACK TO SAVEPOINT permissions_probe');await client.query('RELEASE SAVEPOINT permissions_probe');}
  assert.equal(code,'P0401');
  return {permissionMode:'effective_acl',roleLimited:true,allowedReadChecks:5,deniedChecks:9,invalidSessionDenied:true};
}
