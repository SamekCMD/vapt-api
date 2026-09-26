import assert from "node:assert/strict";
import test from "node:test";

import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { createWebhookRepository } from "./repository.js";

const event = {
  providerEventId: "evt_1",
  eventType: "invoice.paid",
  rawPayload: { id: "evt_1", type: "invoice.paid" },
  restaurantId: null,
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
};

test("billing webhook reservation uses one ON CONFLICT statement to detect duplicates", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const responses = [{ rows: [{ id: "stored-event-1" }] }, { rows: [] }];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return responses.shift() ?? { rows: [] };
    },
  } as unknown as Queryable;
  const repository = createWebhookRepository(database);

  const created = await repository.reserveBillingEvent(event);
  const duplicate = await repository.reserveBillingEvent(event);

  assert.deepEqual(created, { duplicate: false });
  assert.deepEqual(duplicate, { duplicate: true });
  assert.match(calls[0]?.sql ?? "", /on conflict\s*\(provider,\s*provider_event_id\)\s*do nothing/i);
  assert.deepEqual(calls[0]?.values?.slice(0, 6), [
    "evt_1",
    "invoice.paid",
    null,
    "cus_1",
    "sub_1",
    event.rawPayload,
  ]);
});

test("billing webhook status updates keep gateway metadata inside the stored payload", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Queryable;
  const repository = createWebhookRepository(database);

  await repository.markBillingEventProcessed(event);
  await repository.markBillingEventFailed(event, "upstream_down");

  assert.match(calls[0]?.sql ?? "", /update public\.billing_provider_events/i);
  assert.equal((calls[0]?.values?.[0] as { gateway: { status: string } }).gateway.status, "processed");
  assert.equal((calls[1]?.values?.[0] as { gateway: { status: string } }).gateway.status, "pending_retry");
  assert.equal((calls[1]?.values?.[0] as { gateway: { lastProcessingError: string } }).gateway.lastProcessingError, "upstream_down");
});

test("billing webhook repository sanitizes PostgreSQL failures", async () => {
  const database = {
    async query() {
      throw new Error("postgresql://stripe:secret@db insert billing_provider_events");
    },
  } as unknown as Queryable;

  await assert.rejects(
    () => createWebhookRepository(database).reserveBillingEvent(event),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "internal_error");
      assert.equal(error.message, "Failed to persist Stripe webhook event");
      assert.equal(error.diagnostics, undefined);
      assert.doesNotMatch(error.message, /secret|insert|billing_provider/i);
      return true;
    },
  );
});
