// Restricted transaction core: no CLI, credentials, connection factory or default transport.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
const manifest=[
  ['009_public_catalog_publication.sql','41a2621225454202616664e24c822c32707f5f0f72b15193dd66057202bc0591'],
  ['009_worker_production_catalog_grants.sql','f9f55bf6de7d1c1dc7e6f258f05f3c8fcd7f500e823630d7a0ed8990632d1356'],
  ['010_tenant_foundation.sql','db86e7a78f28d2d98c1e60480361ee79d2071a0d36b2a458e959def4a869e1ed'],
  ['010_worker_production_tenant_grants.sql','02cfcbd52cd2a9b42df29a6627194b75279c79fb1b3262d328d0902e35781533'],
  ['011_organization_billing.sql','c35edf2ae47642c3e4c22bb8b1999822dbbc503f00652a17bdcf3ed7d618547e'],
  ['011_worker_production_billing_grants.sql','e85ac79968c04393fce12e6a55d3a6d3558f712aa92de7ccf529b1c3c2cced0c'],
  ['012_tenant_onboarding.sql','bcf7ac85ad26d10b906a4495132386bfb78bd3ab3d1c7324a0150e3db52f9e2f'],
  ['012_worker_production_onboarding_grants.sql','92fcb99111d8c4654557db8f000d32eb767a8a3029c8ecb57baf7ccedc6392a7'],
];
const tables=['better_auth.account','better_auth.session','better_auth.user','better_auth.verification',
  'public.billing_email_outbox','public.billing_provider_events','public.menu_item_variations','public.menu_items',
  'public.order_feedback','public.order_items','public.orders','public.payment_effect_outbox','public.payment_oauth_states',
  'public.payment_provider_accounts','public.payment_provider_events','public.payment_transactions','public.payment_webhook_events',
  'public.push_subscriptions','public.restaurants','public.table_sessions'];
const baseline='64ef36fbc2ce6cc263aa9596e9b67a2cf4136fdb16b850c428bc648800a7e096';
const migrated='b28390b5839143e11b99d9c82b427fc44f3b11aaadd237f8f8731cd0a32294fe';
function prepare(files) {
  assert(Array.isArray(files)&&files.length===8);
  return files.map((file,index)=>{
    const [name,hash]=manifest[index];assert.equal(file.name,name);assert(Buffer.isBuffer(file.bytes));
    assert.equal(createHash('sha256').update(file.bytes).digest('hex'),hash);
    const sql=file.bytes.toString('utf8');
    assert.equal([...sql.matchAll(/^begin;\s*$/gmi)].length,1);
    assert.equal([...sql.matchAll(/^commit;\s*$/gmi)].length,1);assert(/commit;\s*$/i.test(sql));
    return {name,sha256:hash,body:sql.replace(/^begin;\s*$/mi,'').replace(/^commit;\s*$/mi,'')};
  });
}
function closed(value) {
  assert(value?.httpClosed===true&&value.queuePaused===true&&value.cronRemoved===true);
  assert.equal(value.legacyDurableBusinessCommands,false);
}
function snapshot(value,after) {
  assert.equal(value?.hash,after?migrated:baseline);assert.equal(value.tables,after?30:20);
  assert.equal(value.rows,0);assert.equal(value.readAllStats,true);assert.equal(value.otherClients,0);
  assert.equal(value.preparedTransactions,0);assert.equal(value.unfinishedEffects,0);
}
export function createProductionSchemaJournal(marker) {
  let claimed=false;
  async function exclusive(path,phase) {
    const handle=await open(path,'wx');
    try {await handle.writeFile(JSON.stringify({phase,at:new Date().toISOString()}));await handle.sync();}
    finally {await handle.close();}
  }
  return {
    async claim(){assert(!claimed);await exclusive(marker,'start');claimed=true;},
    async record(phase){assert(claimed);assert(['locked_baseline_confirmed','commit_attempt','commit_confirmed'].includes(phase));await exclusive(marker+'.'+phase+'.json',phase);},
  };
}
export async function runProductionSchemaGate(ports) {
  const report={ok:false,committed:false,commitUncertain:false,rolledBack:false,migrationsApplied:0,statementsExecuted:0};
  let active=false,commitAttempt=false,stage='sql_artifacts';
  try {
    const files=prepare(ports.files);report.manifest=files.map(({name,sha256})=>({name,sha256}));
    stage='exclusive_attempt';await ports.journal.claim();
    stage='controls_before';closed(await ports.checkControls());
    stage='begin';await ports.database.query('BEGIN ISOLATION LEVEL READ COMMITTED');active=true;
    await ports.database.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; SET LOCAL idle_in_transaction_session_timeout='90s'; SET LOCAL transaction_timeout='120s'; SET LOCAL ROLE neondb_owner");
    stage='write_barrier';
    await ports.database.query('LOCK TABLE '+tables.map(name=>name.split('.').map(part=>'"'+part+'"').join('.')).join(',')+' IN ACCESS EXCLUSIVE MODE');
    stage='locked_baseline';report.before=await ports.inspect();snapshot(report.before,false);
    await ports.journal.record('locked_baseline_confirmed');
    for(const file of files) {stage=file.name;await ports.database.query(file.body);report.statementsExecuted++;}
    stage='integrity_effective_permissions';report.verification=await ports.verify();
    assert.deepEqual(report.verification,{integrity:true,permissionMode:'effective_acl',roleLimited:true,allowedReadChecks:5,deniedChecks:9,invalidSessionDenied:true});
    stage='locked_postflight';report.after=await ports.inspect();snapshot(report.after,true);
    stage='controls_before_commit';closed(await ports.checkControls());
    stage='commit_journal';await ports.journal.record('commit_attempt');
    stage='commit';commitAttempt=true;await ports.database.query('COMMIT');
    active=false;report.committed=true;report.commitUncertain=false;report.migrationsApplied=8;
    stage='commit_receipt';await ports.journal.record('commit_confirmed');report.ok=true;
  } catch {
    report.failedStage=stage;
    if(commitAttempt&&!report.committed)report.commitUncertain=true;
    if(active&&!commitAttempt) {
      try {await ports.database.query('ROLLBACK');report.rolledBack=true;active=false;}
      catch {report.rollbackUnconfirmed=true;}
    }
    report.diagnostic='Stopped without retry, traffic release, restore or replay. Preserve the one-shot journal.';
  }
  return report;
}
