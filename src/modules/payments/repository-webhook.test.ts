import assert from "node:assert/strict";
import test from "node:test";

import type { Queryable } from "../../lib/database.js";
import { createPaymentRepository } from "./repository.js";

test("failed webhook reservation is atomically reopened for a single provider retry", async () => {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const responses = [
    { rows: [] },
    { rows: [{ status: "failed", attempts: 1 }] },
    { rows: [{ id: "event-1" }] },
  ];
  const database = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return responses.shift() ?? { rows: [] };
    },
  } as unknown as Queryable;
  const repository = createPaymentRepository(database);

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
  assert.match(calls[0]?.sql ?? "", /on conflict\s*\(provider,\s*external_event_id\)\s*do nothing/i);
  assert.match(calls[2]?.sql ?? "", /status\s*=\s*'failed'/i);
  assert.match(calls[2]?.sql ?? "", /attempts\s*=\s*\$3::integer/i);
  assert.deepEqual(calls[2]?.values, ["mercado_pago", "987654321", 1]);
});

test("a reserved or processed webhook remains a duplicate", async () => {
  const responses = [
    { rows: [] },
    { rows: [{ status: "processed", attempts: 1 }] },
  ];
  const database = {
    async query() {
      return responses.shift() ?? { rows: [] };
    },
  } as unknown as Queryable;
  const repository = createPaymentRepository(database);

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

  assert.deepEqual(result, { duplicate: true });
});
