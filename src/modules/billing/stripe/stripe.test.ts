import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../../lib/database.js";
import { createStripeBillingRepository } from "./repository.js";

function lockedBillingDatabase(options: { owned?: boolean; customerId?: string | null; writeError?: unknown } = {}) {
  const operations: string[] = [];
  const writes: unknown[][] = [];
  const row = {
    userId: "owner-1", restaurantId: "restaurant-1", planType: "starter",
    planStatus: "trialing", stripeCustomerId: options.customerId ?? null,
    stripeSubscriptionId: null, trialEndsAt: new Date("2026-10-01T00:00:00Z"),
    currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionCanceledAt: null,
    checkoutSessionId: null, checkoutPlanType: null, checkoutExpiresAt: null,
  };
  const query = async (sql: string, values?: unknown[]) => {
    operations.push(sql);
    if (sql.includes("from public.restaurants")) {
      assert.match(sql, /owner_id = \$2::uuid/);
      assert.deepEqual(values?.slice(0, 2), ["restaurant-1", "owner-1"]);
      return { rows: options.owned === false ? [] : [row] };
    }
    if (sql.includes("update public.restaurants")) {
      writes.push(values ?? []);
      if (options.writeError) throw options.writeError;
      assert.match(sql, /owner_id = \$2::uuid/);
      assert.deepEqual(values?.slice(0, 2), ["restaurant-1", "owner-1"]);
      return { rows: [{ id: "restaurant-1" }] };
    }
    return { rows: [] };
  };
  const database = {
    query,
    async connect() {
      operations.push("CONNECT");
      return { query, release() { operations.push("RELEASE"); } };
    },
  } as unknown as Database;
  return { database, operations, writes };
}

test("billing public status is owner-scoped and contains no provider identifiers", async () => {
  const { database } = lockedBillingDatabase({ customerId: "cus_private" });
  const repository = createStripeBillingRepository(database);
  const status = await repository.getPublicStatus({ userId: "owner-1", restaurantId: "restaurant-1" });

  assert.deepEqual(status, {
    planType: "starter", planStatus: "trialing", trialEndsAt: "2026-10-01T00:00:00.000Z",
    currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionCanceledAt: null,
    canManageBilling: true, requiresBillingAction: false,
  });
  assert.doesNotMatch(JSON.stringify(status), /cus_private|stripeCustomerId|stripeSubscriptionId|owner-1/);
});

test("billing customer association holds the owner lock and uses compare-and-set", async () => {
  const { database, operations, writes } = lockedBillingDatabase();
  const repository = createStripeBillingRepository(database);

  const result = await repository.withBillingLock(
    { userId: "owner-1", restaurantId: "restaurant-1" },
    async (lock) => {
      assert.equal(lock.scope.stripeCustomerId, null);
      assert.match(operations.at(-1) ?? "", /for update/i);
      await lock.associateCustomer("cus_created");
      await lock.savePendingCheckout({
        id: "cs_test_pending", planType: "pro", expiresAt: "2026-10-01T01:00:00.000Z",
      });
      return lock.scope.stripeCustomerId;
    },
  );

  assert.equal(result, "cus_created");
  assert.match(operations.find((sql) => sql.includes("update public.restaurants")) ?? "",
    /stripe_customer_id is null or stripe_customer_id = \$3::text/i);
  assert.equal(writes.length, 2);
  assert.deepEqual(operations.slice(-2), ["COMMIT", "RELEASE"]);
  assert.ok(operations.every((sql) => !/set\s+plan_(type|status)/i.test(sql)));
});

test("billing lock rejects another tenant before calling the provider callback", async () => {
  const { database, operations } = lockedBillingDatabase({ owned: false });
  let providerCalled = false;
  await assert.rejects(
    createStripeBillingRepository(database).withBillingLock(
      { userId: "owner-1", restaurantId: "restaurant-1" },
      async () => { providerCalled = true; },
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "forbidden",
  );
  assert.equal(providerCalled, false);
  assert.deepEqual(operations.slice(-2), ["ROLLBACK", "RELEASE"]);
});

test("billing association prevents rebinding an existing Customer", async () => {
  const { database, writes } = lockedBillingDatabase({ customerId: "cus_existing" });
  await assert.rejects(
    createStripeBillingRepository(database).withBillingLock(
      { userId: "owner-1", restaurantId: "restaurant-1" },
      async (lock) => lock.associateCustomer("cus_other"),
    ),
    /already associated/i,
  );
  assert.equal(writes.length, 0);
});

test("billing unique conflicts roll back without exposing storage details", async () => {
  const { database, operations } = lockedBillingDatabase({
    writeError: { code: "23505", message: "postgresql://secret@db cus_private duplicate SQL" },
  });
  await assert.rejects(
    createStripeBillingRepository(database).withBillingLock(
      { userId: "owner-1", restaurantId: "restaurant-1" },
      async (lock) => lock.associateCustomer("cus_created"),
    ),
    (error: unknown) => error instanceof Error && "statusCode" in error &&
      error.statusCode === 409 && !/secret|postgresql|cus_private|SQL/.test(error.message),
  );
  assert.deepEqual(operations.slice(-2), ["ROLLBACK", "RELEASE"]);
});
