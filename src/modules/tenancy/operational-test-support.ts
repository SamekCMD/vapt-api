import assert from 'node:assert/strict';
import type { Database,Queryable } from '../../lib/database.js';

// Unit serialization/rollback doubles retain their business-query behavior.
// Only this explicit synthetic tenant/session is answered here; authorization
// and real PostgreSQL isolation are exercised by *.pg-integration.ts.
export const operationalSession={ sessionId:'90000000-0000-4000-8000-000000000001',sessionExpiresAt:Date.now()+3_600_000 };
export function operationalTestDatabase(database:Database,scope:{userId:string;restaurantId:string}):Database {
  const organizationId='90000000-0000-4000-8000-000000000002';
  const wrap=(q:Queryable)=>async(sql:string,values?:unknown[])=>{
    if(sql.startsWith('select r.organization_id,m.role')) {
      assert.deepEqual(values,[scope.restaurantId,scope.userId]);
      return {rows:[{organization_id:organizationId,role:'manager'}]};
    }
    if(sql.startsWith('select r.id from public.restaurants r')) {
      assert.deepEqual(values,[scope.userId]);return {rows:[{id:scope.restaurantId}]};
    }
    if(sql.startsWith('select id from better_auth."session"')) {
      assert.deepEqual(values,[operationalSession.sessionId,scope.userId]);return {rows:[{id:operationalSession.sessionId}]};
    }
    if(/pg_advisory_xact_lock/.test(sql)) {
      assert.ok(values?.length===1);
      assert.ok(values[0]===`tenant:organization:${organizationId}` || values[0]===`tenant:restaurant:${scope.restaurantId}`);
      return {rows:[]};
    }
    return q.query(sql,values);
  };
  return {
    query:wrap(database),
    async connect(){ const client=await database.connect();return {query:wrap(client),release:()=>client.release()}; },
  } as unknown as Database;
}
