import type { PoolClient } from 'pg';

// Transaction-scoped only. See010 capacity trigger: exactly the same organization key.
export async function lockOrganization(client: PoolClient, organizationId: string, mode: 'shared' | 'exclusive'): Promise<void> {
  const functionName = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await client.query(`select ${functionName}(hashtextextended($1::text,0))`, [`tenant:organization:${organizationId.toLowerCase()}`]);
}
async function exclusive(client: PoolClient, key: string) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1::text,0))', [key]);
}
export async function lockRestaurant(client: PoolClient, restaurantId: string): Promise<void> {
  await exclusive(client, `tenant:restaurant:${restaurantId.toLowerCase()}`);
}
export async function lockOperation(client: PoolClient, operationId: string): Promise<void> {
  await exclusive(client, `tenant:operation:${operationId.toLowerCase()}`);
}
export async function lockSlugs(client: PoolClient, slugs: readonly string[]): Promise<void> {
  for (const slug of [...new Set(slugs)].sort()) await exclusive(client, `tenant:slug:${slug}`);
}
