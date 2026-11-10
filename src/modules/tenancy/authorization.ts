import { z } from 'zod';
import { withTransaction, type Database, type Queryable } from '../../lib/database.js';
import type { PoolClient } from 'pg';
import { AppError } from '../../lib/errors.js';
import type { Access, Capability, OrganizationScope, RestaurantMembership, RestaurantScope, RestaurantWriteScope, Role, TenantActor } from './contracts.js';
import { tenantActorSchema } from './contracts.js';
import { hasCapability } from './policy.js';
import { lockOrganization, lockRestaurant } from './locks.js';

const uuid = z.string().uuid();
function validScope(userId: string, targetId: string) {
  if (!uuid.safeParse(userId).success || !uuid.safeParse(targetId).success) {
    throw new AppError(400, 'invalid_request', 'Invalid request');
  }
}
async function membership(q: Queryable, sql: string, params: string[], capability: Capability): Promise<RestaurantMembership> {
  let rows: { organization_id: string; role: Role }[];
  try { rows = (await q.query<{ organization_id: string; role: Role }>(sql, params)).rows; }
  catch { throw new AppError(500, 'internal_error', 'Failed to verify access'); }
  const row = rows[0];
  if (!row || !hasCapability(row.role, capability)) throw new AppError(403, 'forbidden', 'Forbidden');
  return { organizationId:row.organization_id, role:row.role };
}
export async function authorizeRestaurant(q: Queryable, scope: RestaurantScope, capability: Capability): Promise<Access> {
  validScope(scope.userId, scope.restaurantId);
  if (capability === 'restaurant.create') throw new AppError(400, 'invalid_request', 'Invalid request');
  const access = await membership(q, `select r.organization_id,m.role from public.restaurants r
    join public.organization_members m on m.organization_id=r.organization_id
    where r.id=$1::uuid and m.user_id=$2::uuid and m.status='active'`,
  [scope.restaurantId, scope.userId], capability);
  return { userId:scope.userId, restaurantId:scope.restaurantId, ...access };
}
export async function authorizeOrganization(q: Queryable, scope: OrganizationScope, capability: Capability): Promise<RestaurantMembership> {
  validScope(scope.userId, scope.organizationId);
  return membership(q, `select organization_id,role from public.organization_members
    where organization_id=$1::uuid and user_id=$2::uuid and status='active'`,
  [scope.organizationId,scope.userId], capability);
}
export async function assertLiveSession(q: Queryable, actor: TenantActor): Promise<void> {
  if (!tenantActorSchema.safeParse(actor).success || actor.sessionExpiresAt <= Date.now()) {
    throw new AppError(401, 'unauthorized', 'Unauthorized');
  }
  let live = false;
  try {
    const result = await q.query(`select id from better_auth."session"
      where id=$1::uuid and "userId"=$2::uuid and "expiresAt">clock_timestamp() for share`, [actor.sessionId,actor.userId]);
    live = result.rows.length === 1;
  } catch { throw new AppError(500, 'internal_error', 'Failed to verify session'); }
  if (!live) throw new AppError(401, 'unauthorized', 'Unauthorized');
}

export async function resolveLegacyRestaurant(q: Queryable, userId: string): Promise<RestaurantScope> {
  validScope(userId,userId);
  let ids: { id:string }[];
  try {
    ids = (await q.query<{ id:string }>(`select r.id from public.restaurants r
      join public.organization_members m on m.organization_id=r.organization_id
      where m.user_id=$1::uuid and m.status='active' and m.role in ('owner','admin','manager','staff')
      order by r.id limit 2`, [userId])).rows;
  } catch { throw new AppError(500,'internal_error','Failed to resolve restaurant'); }
  if (ids.length > 1) throw new AppError(409,'restaurant_selection_required','Restaurant selection required');
  if (!ids[0]) throw new AppError(404,'not_found','Restaurant not found');
  return { userId,restaurantId:ids[0].id };
}

export async function withRestaurantWrite<T>(database: Database, scope: RestaurantWriteScope, capability: Capability,
  work: (client: PoolClient)=>Promise<T>, options: {
    transaction?:PoolClient; beforeSession?:(client:PoolClient)=>Promise<void>;
  } = {}): Promise<T> {
  if (!tenantActorSchema.safeParse(scope).success || scope.sessionExpiresAt <= Date.now()) {
    throw new AppError(401,'unauthorized','Unauthorized');
  }
  const execute = async (client:PoolClient) => {
    const first = await authorizeRestaurant(client,scope,capability);
    await lockOrganization(client,first.organizationId,'shared');
    await lockRestaurant(client,scope.restaurantId);
    const current = await authorizeRestaurant(client,scope,capability);
    if (current.organizationId !== first.organizationId) throw new AppError(403,'forbidden','Forbidden');
    await options.beforeSession?.(client);
    await assertLiveSession(client,scope);
    return work(client);
  };
  return options.transaction ? execute(options.transaction) : withTransaction(database,execute);
}

export function legacyWriteActor(userId: string, actor?: TenantActor): TenantActor {
  if (!actor || actor.userId !== userId) throw new AppError(401,'unauthorized','Unauthorized');
  return actor;
}
