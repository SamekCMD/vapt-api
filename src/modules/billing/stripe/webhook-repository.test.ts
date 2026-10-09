import assert from "node:assert/strict";
import test from "node:test";

import type { Database } from "../../../lib/database.js";
import { createStripeWebhookRepository } from "./webhook-repository.js";
import type { ReconciliationScope } from "./webhook-repository.js";

const event = {
  providerEventId: "evt_test", eventType: "invoice.paid",
  payload: { id: "evt_test", type: "invoice.paid", livemode: false },
};
const now = new Date("2026-09-27T12:00:00Z");
const reconciliationScope: ReconciliationScope = {
  restaurantId: "10000000-0000-4000-8000-000000000001", userId: "20000000-0000-4000-8000-000000000001",
  stripeCustomerId: "cus_vapt", stripeSubscriptionId: null, checkoutSessionId: "cs_test_vapt",
  planStatus: "trialing", stateUpdatedAt: null,
};

function scriptedDatabase(responses: unknown[][], errorAt?: number) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const operations: string[] = [];
  const query = async (sql: string, values?: unknown[]) => {
    operations.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };
    calls.push({ sql, values });
    if (calls.length === errorAt) throw new Error("secret SQL postgresql://credential@db");
    return { rows: responses.shift() ?? [] };
  };
  return {
    calls, operations,
    database: { query, async connect() {
      return { query, release() { operations.push("RELEASE"); } };
    } } as unknown as Database,
  };
}

test("Stripe event claim is atomic and begins with attempt one", async () => {
  const { database, calls } = scriptedDatabase([[{ attemptCount: 1 }]]);
  const result = await createStripeWebhookRepository(database, { now: () => now }).claimEvent(event);

  assert.deepEqual(result, { kind: "claimed", attemptCount: 1 });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /on conflict \(provider, provider_event_id\) do update/i);
  assert.match(calls[0]!.sql, /attempt_count = .*attempt_count \+ 1/i);
  assert.equal(calls[0]!.values?.[0], event.providerEventId);
});

test("restaurant resolution prioritizes unique Subscription then Customer then UUID metadata and locks row", async () => {
  for (const foundAt of [0, 1, 2]) {
    const responses = Array.from({ length: foundAt }, () => [] as unknown[]);
    responses.push([{ ...reconciliationScope, stateUpdatedAt: now }]);
    const { database, calls } = scriptedDatabase(responses);
    const scope = await createStripeWebhookRepository(database).resolveRestaurant(database, {
      subscriptionId: "sub_vapt", customerId: "cus_vapt", restaurantId: reconciliationScope.restaurantId,
    });
    assert.equal(calls.length, foundAt + 1);
    assert.match(calls[0]!.sql, /where stripe_subscription_id = \$1::text for update/);
    if (foundAt > 0) assert.match(calls[1]!.sql, /where stripe_customer_id = \$1::text for update/);
    if (foundAt > 1) assert.match(calls[2]!.sql, /where id = \$1::uuid for update/);
    assert.equal(scope?.stateUpdatedAt, now.toISOString());
  }
});
test("unknown/untrusted non-UUID metadata never becomes a SQL identifier or cast", async () => {
  const { database, calls } = scriptedDatabase([]);
  assert.equal(await createStripeWebhookRepository(database).resolveRestaurant(database, {
    subscriptionId: null, customerId: null, restaurantId: "not-a-uuid' OR true",
  }), null);
  assert.equal(calls.length, 0);
});
test("canonical reconciliation is parameterized and owner-fenced without a host-clock ordering predicate", async () => {
  const { database, calls } = scriptedDatabase([[{ id: reconciliationScope.restaurantId }]]);
  const changed = await createStripeWebhookRepository(database).applySubscription(database, reconciliationScope, {
    customerId: "cus_vapt", subscriptionId: "sub_vapt", subscriptionItemId: "si_vapt", planType: "pro",
    planStatus: "active", trialEndsAt: null, currentPeriodEnd: "2030-01-01T00:00:00.000Z",
    cancelAtPeriodEnd: false, subscriptionCanceledAt: null, observedAt: now.toISOString(),
    checkoutSessionId: "cs_test_vapt", billingLastError: null,
  });
  assert.equal(changed, true);
  assert.match(calls[0]!.sql, /owner_id = \$2::uuid/);
  assert.doesNotMatch(calls[0]!.sql, /stripe_state_updated_at <=/);
  assert.match(calls[0]!.sql, /stripe_subscription_item_id = \$5::text/);
  assert.deepEqual(calls[0]!.values?.slice(0, 5), [reconciliationScope.restaurantId, reconciliationScope.userId, "cus_vapt", "sub_vapt", "si_vapt"]);
});
test("expiration clears all three pending columns only for matching owned Session", async () => {
  const { database, calls } = scriptedDatabase([[]]);
  assert.equal(await createStripeWebhookRepository(database).clearPendingCheckout(database, reconciliationScope, "cs_test_old"), false);
  assert.match(calls[0]!.sql, /owner_id = \$2::uuid and stripe_checkout_session_id = \$3::text/);
  assert.match(calls[0]!.sql, /stripe_checkout_plan_type = null/);
  assert.match(calls[0]!.sql, /stripe_checkout_expires_at = null/);
});

for (const status of ["processed", "ignored"]) {
  test(`Stripe ${status} event is a terminal duplicate`, async () => {
    const { database } = scriptedDatabase([[], [{ processingStatus: status }]]);
    const result = await createStripeWebhookRepository(database).claimEvent(event);
    assert.deepEqual(result, { kind: "duplicate_processed" });
  });
}

test("Stripe pending_retry claims another attempt instead of being dropped", async () => {
  const { database, calls } = scriptedDatabase([[{ attemptCount: 2 }]]);
  assert.deepEqual(await createStripeWebhookRepository(database).claimEvent(event),
    { kind: "claimed", attemptCount: 2 });
  assert.match(calls[0]!.sql, /processing_status in \('received', 'pending_retry'\)/i);
});

test("Stripe expired lease can be reclaimed with a new fencing attempt", async () => {
  const { database, calls } = scriptedDatabase([[{ attemptCount: 3 }]]);
  const repository = createStripeWebhookRepository(database, { now: () => now, leaseMs: 60000 });
  assert.deepEqual(await repository.claimEvent(event), { kind: "claimed", attemptCount: 3 });
  assert.match(calls[0]!.sql, /processing_started_at <= \$5::timestamptz/i);
  assert.equal(calls[0]!.values?.[4], "2026-09-27T11:59:00.000Z");
});

test("Stripe unexpired processing lease remains in flight", async () => {
  const { database } = scriptedDatabase([[], [{ processingStatus: "processing" }]]);
  assert.deepEqual(await createStripeWebhookRepository(database).claimEvent(event), { kind: "in_flight" });
});

test("Stripe event completion and email intent share one transaction and deduplication key", async () => {
  const { database, calls, operations } = scriptedDatabase([
    [{ attemptCount: 2, processingStatus: "processing" }], [], [], [{ id: "event-row" }],
  ]);
  const repository = createStripeWebhookRepository(database, { now: () => now });
  await repository.withClaimedEvent({ providerEventId: "evt_test", attemptCount: 2 }, async (transaction) => {
    const intent = {
      restaurantId: "restaurant-1", providerEventId: "evt_test", billingResourceId: "in_vapt",
      emailKind: "subscription_activated" as const, payload: { planType: "starter" },
    };
    await repository.enqueueEmail(transaction, intent);
    await repository.enqueueEmail(transaction, intent);
    return "processed";
  });

  assert.match(calls[0]!.sql, /for update/i);
  for (const call of calls.slice(1, 3)) {
    assert.match(call.sql, /on conflict do nothing/i);
    assert.deepEqual(call.values?.slice(0, 3), ["restaurant-1", "evt_test", "subscription_activated"]);
  }
  assert.match(calls.at(-1)!.sql, /attempt_count = \$2::integer/i);
  assert.deepEqual(operations.slice(-2), ["COMMIT", "RELEASE"]);
});

test("Stripe stale worker cannot reconcile a reclaimed event", async () => {
  const { database, operations } = scriptedDatabase([[{ attemptCount: 3, processingStatus: "processing" }]]);
  let workCalled = false;
  await assert.rejects(
    createStripeWebhookRepository(database).withClaimedEvent(
      { providerEventId: "evt_test", attemptCount: 2 },
      async () => { workCalled = true; return "processed"; },
    ),
    /claim is no longer owned/i,
  );
  assert.equal(workCalled, false);
  assert.deepEqual(operations.slice(-2), ["ROLLBACK", "RELEASE"]);
});

test("Stripe failure records a safe retry code only for its owned attempt", async () => {
  const { database, calls } = scriptedDatabase([[{ id: "event-row" }]]);
  await createStripeWebhookRepository(database).markFailed({
    providerEventId: "evt_test", attemptCount: 2, errorCode: "stripe_unavailable",
  });
  assert.match(calls[0]!.sql, /processing_status = 'pending_retry'/i);
  assert.match(calls[0]!.sql, /attempt_count = \$2::integer/i);
  assert.deepEqual(calls[0]!.values, ["evt_test", 2, "stripe_unavailable"]);
});

test("email insertion includes the business resource key and suppresses either deduplication constraint", async () => {
  const { database, calls } = scriptedDatabase([[]]);
  await createStripeWebhookRepository(database).enqueueEmail(database, {
    restaurantId: "restaurant-1", providerEventId: "evt_one", billingResourceId: "in_same",
    emailKind: "subscription_activated", payload: {},
  });
  assert.match(calls[0]!.sql, /billing_resource_id/);
  assert.match(calls[0]!.sql, /on conflict do nothing/);
  assert.ok(calls[0]!.values?.includes("in_same"));
});

test("Stripe persistence failure rolls back intents and sanitizes details", async () => {
  const { database, operations } = scriptedDatabase([[{ attemptCount: 1, processingStatus: "processing" }]], 2);
  const repository = createStripeWebhookRepository(database);
  await assert.rejects(repository.withClaimedEvent(
    { providerEventId: "evt_test", attemptCount: 1 },
    async (transaction) => {
      await repository.enqueueEmail(transaction, {
        restaurantId: "restaurant-1", providerEventId: "evt_test", billingResourceId: "in_vapt",
        emailKind: "payment_failed", payload: {},
      });
      return "processed";
    },
  ), (error: unknown) => error instanceof Error && !/secret|SQL|credential/.test(error.message));
  assert.deepEqual(operations.slice(-2), ["ROLLBACK", "RELEASE"]);
});
