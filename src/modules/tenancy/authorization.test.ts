import assert from 'node:assert/strict';
import test from 'node:test';
import type { Queryable } from '../../lib/database.js';
import type { PoolClient } from 'pg';
import { actorFromAuth } from '../../plugins/auth.js';
import { authorizeOrganization, authorizeRestaurant, assertLiveSession } from './authorization.js';
import { getRestaurantLimit, hasCapability, operationFeatures } from './policy.js';
import { lockOrganization, lockRestaurant, lockOperation, lockSlugs } from './locks.js';
import type { Role, Capability } from './contracts.js';

const userId = '11111111-1111-4111-8111-111111111111';
const restaurantId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const capabilities: Capability[] = ['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'];

test('restaurant limits preserve Starter1, Pro1, Business25 and trial1', () => {
  assert.equal(getRestaurantLimit('starter'), 1); assert.equal(getRestaurantLimit('pro'), 1);
  assert.equal(getRestaurantLimit('business'), 25); assert.equal(getRestaurantLimit('trial'), 1);
});
const roleMatrix: [Role, boolean[]][] = [
  ['owner', [true,true,true,true,true,true]], ['admin', [true,true,true,true,true,true]],
  ['manager', [true,true,true,false,true,false]], ['staff', [true,true,false,false,false,false]],
];
for (const [role, expected] of roleMatrix) {
  test(`${role} capabilities are explicit and independent of session role or subscription`, () => {
    assert.deepEqual(capabilities.map((cap) => hasCapability(role, cap)), expected);
  });
}
test('unknown roles and capabilities fail closed', () => {
  assert.equal(hasCapability('superuser' as Role, 'restaurant.read'), false);
  assert.equal(hasCapability('authenticated' as Role, 'billing.read'), false);
  assert.equal(hasCapability('owner', 'toString' as Capability), false);
  assert.equal(hasCapability('toString' as Role, 'restaurant.read'), false);
});
test('operation features preserve active plan access and a live trial without exposing billing', () => {
  const now = Date.parse('2026-10-19T00:00:00Z');
  assert.deepEqual(operationFeatures('starter','active',null,now), {
    cashier:false,open_tab:false,metrics:false,multi_user:false,advanced_reports:false,
  });
  assert.deepEqual(operationFeatures('pro','active',null,now), {
    cashier:true,open_tab:true,metrics:true,multi_user:false,advanced_reports:false,
  });
  const all = { cashier:true,open_tab:true,metrics:true,multi_user:true,advanced_reports:true };
  assert.deepEqual(operationFeatures('business','active',null,now), all);
  assert.deepEqual(operationFeatures('starter','trialing','2026-10-20T00:00:00Z',now), all);
  for (const status of ['past_due','incomplete','unpaid','paused','expired','cancelled','trialing'] as const) {
    const result = operationFeatures('business',status,'2026-10-19T00:00:00Z',now);
    assert.deepEqual(result, { cashier:false,open_tab:false,metrics:false,multi_user:false,advanced_reports:false });
  }
  assert.equal(operationFeatures('business','trialing','invalid',now).cashier, false);
  assert.equal(operationFeatures('business','trialing',null,now).cashier, false);
});
test('write actors require real, unexpired internal session metadata', () => {
  const base = { userId, email:null, role:'authenticated' as const };
  const sessionExpiresAt = Date.now() + 60_000;
  assert.deepEqual(actorFromAuth({ ...base, sessionId, sessionExpiresAt }), { userId, sessionId, sessionExpiresAt });
  for (const invalid of [base, { ...base, sessionId, sessionExpiresAt:0 },
    { ...base, sessionId, sessionExpiresAt:Date.now()-1 }, { ...base, sessionId:'invalid', sessionExpiresAt },
    { ...base, sessionId, sessionExpiresAt:Infinity }, { ...base, userId:'invalid', sessionId, sessionExpiresAt }]) {
    assert.throws(() => actorFromAuth(invalid), { statusCode:401, code:'unauthorized' });
  }
});
test('SQL failure never reuses previous authorization or leaks database diagnostics', async () => {
  const failing = { async query() { throw new Error('sensitive SQL diagnostics'); } } as unknown as Queryable;
  for (const operation of [
    () => authorizeRestaurant(failing, { userId, restaurantId }, 'restaurant.read'),
    () => authorizeOrganization(failing, { userId, organizationId:restaurantId }, 'billing.read'),
    () => assertLiveSession(failing, { userId, sessionId, sessionExpiresAt:Date.now()+60_000 }),
  ]) {
    await assert.rejects(operation(), (error: unknown) => error instanceof Error &&
      'statusCode' in error && error.statusCode === 500 && !error.message.includes('sensitive'));
  }
  await assert.rejects(authorizeRestaurant(failing, { userId, restaurantId }, 'restaurant.create'), { statusCode:400 });
  await assert.rejects(authorizeRestaurant(failing, { userId, restaurantId:'invalid' }, 'restaurant.read'), { statusCode:400 });
});

test('UUID lock identities canonicalize case just like PostgreSQL UUIDs', async () => {
  const keys: string[] = [];
  const client = { async query(_sql: string, values: string[]) { keys.push(values[0]); return { rows:[] }; } } as unknown as PoolClient;
  const id = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
  await lockOrganization(client, id, 'shared'); await lockRestaurant(client, id); await lockOperation(client, id);
  assert.deepEqual(keys, ['tenant:organization:abcdefab-1234-4234-8234-abcdefabcdef',
    'tenant:restaurant:abcdefab-1234-4234-8234-abcdefabcdef', 'tenant:operation:abcdefab-1234-4234-8234-abcdefabcdef']);
});
test('slug locks emit a sorted distinct set of SQL parameters', async () => {
  const keys: string[] = [];
  const client = { async query(_sql: string, values: string[]) { keys.push(values[0]); return { rows:[] }; } } as unknown as PoolClient;
  await lockSlugs(client, ['z-slug','a-slug','z-slug']);
  assert.deepEqual(keys, ['tenant:slug:a-slug','tenant:slug:z-slug']);
});
