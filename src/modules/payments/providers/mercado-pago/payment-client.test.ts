import assert from "node:assert/strict";
import test from "node:test";

import { createMercadoPagoPaymentClient } from "./payment-client.js";

test("Mercado Pago payment client fetches authoritative payment details", async () => {
  let request: { url: string; init: RequestInit } | null = null;
  const client = createMercadoPagoPaymentClient({
    fetchImpl: async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({
        id: 123456789,
        status: "approved",
        status_detail: "accredited",
        transaction_amount: 23,
        currency_id: "BRL",
        external_reference: "10000000-0000-4000-8000-000000000001",
        collector_id: 3595396809,
        date_last_updated: "2026-08-08T12:05:00.000Z",
        payment_method_id: "pix",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.getPayment({
    accessToken: "TEST-private-token",
    paymentId: "123456789",
  });

  const captured = request as unknown as { url: string; init: RequestInit };
  assert.equal(captured.url, "https://api.mercadopago.com/v1/payments/123456789");
  assert.deepEqual(captured.init.headers, {
    accept: "application/json",
    authorization: "Bearer TEST-private-token",
  });
  assert.deepEqual(result, {
    id: "123456789",
    status: "approved",
    statusDetail: "accredited",
    transactionAmount: "23.00",
    currency: "BRL",
    externalReference: "10000000-0000-4000-8000-000000000001",
    collectorId: "3595396809",
    dateLastUpdated: "2026-08-08T12:05:00.000Z",
    paymentMethodId: "pix",
  });
});

test("Mercado Pago payment client rejects incomplete provider responses", async () => {
  const client = createMercadoPagoPaymentClient({
    fetchImpl: async () => new Response(JSON.stringify({
      id: 123456789,
      status: "approved",
    }), { status: 200 }),
  });

  await assert.rejects(
    client.getPayment({ accessToken: "TEST-private-token", paymentId: "123456789" }),
    /invalid payment response/i,
  );
});
