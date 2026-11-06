import test from 'node:test';
import assert from 'node:assert/strict';
async function feature(){const m=await import('./catalog-recovery-harness.mjs').catch(()=>({}));assert.equal(typeof m.createLocalCatalogRecoveryHarness,'function','local-only recovery harness missing');return m.createLocalCatalogRecoveryHarness;}
for(const raw of ['postgresql://neondb_owner:synthetic@production.invalid/vapt','postgresql://vapt_tenant_admin:synthetic@127.0.0.1:5432/vapt','postgresql://vapt_tenant_admin:'+'a'.repeat(64)+'@127.0.0.1:5432/postgres'])test('recovery harness refuses nonisolated database before SQL/listeners',async()=>{
  const create=await feature();let calls=0;await assert.rejects(()=>create({database:{options:{connectionString:raw},connect:()=>{calls++;},query:()=>{calls++;}},command:{},fault:'accepted'}));assert.equal(calls,0);
});
