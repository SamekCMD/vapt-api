import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { registerErrorHandler } from "../../../../plugins/error-handler.js";
import { registerRawBody } from "../../../../plugins/raw-body.js";
import { registerMercadoPagoWebhookRoutes } from "./webhook-routes.js";
import type { MercadoPagoWebhookService } from "./webhook.js";

test("canonical and compatibility webhook routes forward signed request data", async () => {
  const calls: unknown[] = [];
  const service: MercadoPagoWebhookService = {
    async handle(input) {
      calls.push(input);
      return { received: true, duplicate: false, ignored: true };
    },
  };
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerRawBody(app);
  await registerMercadoPagoWebhookRoutes(app, service);

  for (const path of [
    "/webhooks/payments/mercado-pago",
    "/payments/mercado-pago/webhook",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `${path}?data.id=123456789`,
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-123",
        "x-signature": "ts=1,v1=" + "a".repeat(64),
      },
      payload: JSON.stringify({ id: 1, type: "payment", data: { id: "123456789" } }),
    });
    assert.equal(response.statusCode, 200);
  }

  assert.equal(calls.length, 2);
  assert.equal((calls[0] as { dataId: string }).dataId, "123456789");
  await app.close();
});

test("Mercado Pago webhook route rejects missing signature headers", async () => {
  const service: MercadoPagoWebhookService = {
    async handle() {
      throw new Error("should not run");
    },
  };
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerRawBody(app);
  await registerMercadoPagoWebhookRoutes(app, service);

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/payments/mercado-pago?data.id=123456789",
    payload: { data: { id: "123456789" } },
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: {
      code: "invalid_webhook_signature",
      message: "Invalid Mercado Pago webhook signature",
    },
  });
  await app.close();
});
