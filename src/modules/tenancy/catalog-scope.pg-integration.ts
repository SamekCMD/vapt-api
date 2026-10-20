import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { applyCatalogCommand,findCommittedCommand } from '../catalog-publication/transaction.js';
import { fingerprintCommand } from '../catalog-publication/policy.js';
import type { CatalogCommand } from '../catalog-publication/contracts.js';
import { lockOrganization } from './locks.js';
import { withTransaction } from '../../lib/database.js';
import { withTenantFixture } from './pg-test-support.js';

test('membership revocation blocks new apply but not internal recovery of a committed public projection',async()=>{
  await withTenantFixture(async f=>{
    const command:CatalogCommand={operationId:randomUUID(),restaurantId:f.restA,actor:f.adminActor,
      mutation:{type:'restaurant.patch',input:{name:'Administrador autorizado'}}};
    const committed=await applyCatalogCommand(f.pool,command);
    assert.equal(committed.receipt.restaurantId,f.restA);
    assert.equal((await f.pool.query('select name from public.restaurants where id=$1',[f.restB])).rows[0].name,'Restaurante B');
    const identity={...command,fingerprint:await fingerprintCommand(command)};
    await withTransaction(f.pool,async client=>{
      await lockOrganization(client,f.orgA,'exclusive');
      await client.query("update public.organization_members set status='disabled' where organization_id=$1 and user_id=$2",[f.orgA,f.admin]);
    });
    await assert.rejects(applyCatalogCommand(f.pool,{...command,operationId:randomUUID()}),{statusCode:403});
    assert.deepEqual(await findCommittedCommand(f.pool,identity),committed);
    await assert.rejects(findCommittedCommand(f.pool,{...identity,actor:f.ownerActor}),{statusCode:409});
    await assert.rejects(findCommittedCommand(f.pool,{...identity,restaurantId:f.restB}),{statusCode:409});
    await assert.rejects(findCommittedCommand(f.pool,{...identity,fingerprint:'f'.repeat(64)}),{statusCode:409});
  });
});

test('staff and foreign organization commands cannot mutate or allocate a journal version',async()=>{
  await withTenantFixture(async f=>{
    for(const [actor,restaurantId] of [[f.staffActor,f.restA],[f.adminActor,f.restOther]] as const){
      const command:CatalogCommand={operationId:randomUUID(),restaurantId,actor,mutation:{type:'rebuild'}};
      await assert.rejects(applyCatalogCommand(f.pool,command),{statusCode:403});
      assert.equal((await f.pool.query('select count(*)::int n from public.catalog_publication_operations where operation_id=$1',[command.operationId])).rows[0].n,0);
    }
  });
});
