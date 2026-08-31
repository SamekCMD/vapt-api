import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { AppConfig } from "../../lib/config.js";
import type { PaymentEffectReconciliation } from "./reconciliation.js";
import { registerPaymentEffectRoutes } from "./effects-routes.js";

const config = {
  n8n: { secrets: { admin: "admin-secret" } },
} as AppConfig;

function fakeReconciliation(): PaymentEffectReconciliation {
  return {
    async runOnce() {
      return {
        claimed: 2,
        completed: 1,
        failed: 1,
        deadLettered: 0,
        pending: 3,
      };
    },
    start() {},
    stop() {},
    snapshot() {
      return {
        pending: 3,
        lastRunAt: "2026-08-01T12:00:00.000Z",
        lastError: null,
      };
    },
  };
}

test("admin payment effect route rejects an invalid secret", async () => {
  const app = Fastify();
  await registerPaymentEffectRoutes(app, config, fakeReconciliation());

  const response = await app.inject({
    method: "POST",
    url: "/admin/payments/effects/reprocess",
    headers: { "x-vapt-admin-key": "wrong-secret" },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: { code: "unauthorized", message: "Unauthorized" },
  });
  await app.close();
});

test("admin payment effect route runs one bounded reconciliation batch", async () => {
  const app = Fastify();
  await registerPaymentEffectRoutes(app, config, fakeReconciliation());

  const response = await app.inject({
    method: "POST",
    url: "/admin/payments/effects/reprocess",
    headers: { "x-vapt-admin-key": "admin-secret" },
    payload: { limit: 10 },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    claimed: 2,
    completed: 1,
    failed: 1,
    deadLettered: 0,
    pending: 3,
  });
  await app.close();
});
