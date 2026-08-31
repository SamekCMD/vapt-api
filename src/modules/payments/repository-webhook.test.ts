import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createPaymentRepository } from "./repository.js";

test("failed webhook reservation is atomically reopened for a provider retry", async () => {
  const updates: unknown[] = [];
  let operation: "insert" | "select" | "update" = "insert";
  const chain = {
    insert() {
      operation = "insert";
      return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
    },
    select() {
      if (operation !== "update") operation = "select";
      return this;
    },
    update(value: unknown) {
      operation = "update";
      updates.push(value);
      return this;
    },
    eq() {
      return this;
    },
    async maybeSingle<T>() {
      if (operation === "select") {
        return { data: { status: "failed", attempts: 1 } as T, error: null };
      }
      return { data: { id: "event-1" } as T, error: null };
    },
  };
  const client = {
    from() {
      return chain;
    },
  } as unknown as SupabaseClient;
  const repository = createPaymentRepository(client);

  const result = await repository.reserveWebhookEvent({
    provider: "mercado_pago",
    externalEventId: "987654321",
    eventType: "payment.updated",
    restaurantId: null,
    providerAccountId: null,
    paymentTransactionId: null,
    signatureValid: true,
    payload: {},
  });

  assert.deepEqual(result, { duplicate: false });
  assert.deepEqual(updates, [{
    status: "received",
    attempts: 2,
    last_error: null,
    processed_at: null,
  }]);
});
