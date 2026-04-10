import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
import { registerRawBody } from "../../plugins/raw-body.js";
import { registerWebhookRoutes } from "./routes.js";
import { createWebhookService } from "./service.js";

const validConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  host: "127.0.0.1",
  corsOrigins: ["http://localhost:5173"],
  logLevel: "silent",
  n8n: {
    baseUrl: new URL("https://n8n.example.com/webhook"),
    timeoutMs: 5000,
    secrets: {
      app: "app-secret",
      webhookSetup: "setup-secret",
      admin: "admin-secret",
    },
  },
  webhooks: {
    stripe: {
      signingSecret: "whsec_test",
      toleranceSeconds: 300,
    },
  },
  supabase: {
    url: new URL("https://supabase.example.com"),
    serviceRoleKey: "service-role-key",
    jwtSecret: "jwt-secret",
  },
};

class InMemoryWebhookRepository {
  readonly billingEvents = new Map<string, { status: string; error: string | null }>();
  readonly paymentEvents = new Map<string, { status: string; error: string | null }>();
  readonly asaasContexts = new Map<string, { orderId: string; restaurantId: string; webhookToken: string | null }>([
    ["order-1", { orderId: "order-1", restaurantId: "rest-1", webhookToken: "asaas-token" }],
  ]);

  async findAsaasWebhookContext(orderId: string) {
    return this.asaasContexts.get(orderId) ?? null;
  }

  async reserveBillingEvent(input: { providerEventId: string }) {
    if (this.billingEvents.has(input.providerEventId)) {
      return { duplicate: true };
    }

    this.billingEvents.set(input.providerEventId, { status: "received", error: null });
    return { duplicate: false };
  }

  async reservePaymentEvent(input: { providerEventId: string }) {
    if (this.paymentEvents.has(input.providerEventId)) {
      return { duplicate: true };
    }

    this.paymentEvents.set(input.providerEventId, { status: "received", error: null });
    return { duplicate: false };
  }

  async markBillingEventProcessed(input: { providerEventId: string }) {
    this.billingEvents.set(input.providerEventId, { status: "processed", error: null });
  }

  async markBillingEventFailed(input: { providerEventId: string }, errorMessage: string) {
    this.billingEvents.set(input.providerEventId, {
      status: "pending_retry",
      error: errorMessage,
    });
  }

  async markPaymentEventProcessed(input: { providerEventId: string }) {
    this.paymentEvents.set(input.providerEventId, { status: "processed", error: null });
  }

  async markPaymentEventFailed(input: { providerEventId: string }, errorMessage: string) {
    this.paymentEvents.set(input.providerEventId, {
      status: "pending_retry",
      error: errorMessage,
    });
  }
}

function createStripeSignature(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  return `t=${timestamp},v1=${signature}`;
}

async function buildWebhookTestApp(options?: {
  repository?: InMemoryWebhookRepository;
  n8nClient?: {
    stripe: { forwardWebhook: (input: { rawBody: string; signatureHeader: string }) => Promise<unknown> };
    asaas: { forwardWebhook: (input: { rawBody: string; accessToken: string }) => Promise<unknown> };
  };
}) {
  const repository = options?.repository ?? new InMemoryWebhookRepository();
  const n8nClient = options?.n8nClient ?? {
    stripe: {
      forwardWebhook: async () => undefined,
    },
    asaas: {
      forwardWebhook: async () => undefined,
    },
  };
  const service = createWebhookService(
    {
      stripeSigningSecret: validConfig.webhooks.stripe.signingSecret,
      stripeToleranceSeconds: validConfig.webhooks.stripe.toleranceSeconds,
    },
    repository,
    n8nClient,
  );
  const app = Fastify({ logger: false });

  registerErrorHandler(app);
  await registerRawBody(app);
  await registerWebhookRoutes(app, validConfig, { service });

  return { app, repository };
}

test("stripe webhook rejects invalid signature", async () => {
  const { app } = await buildWebhookTestApp();

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=123,v1=invalid",
    },
    payload: JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } }),
  });

  assert.equal(response.statusCode, 401);

  await app.close();
});

test("stripe webhook forwards new events and marks them processed", async () => {
  const forwarded: Array<{ rawBody: string; signatureHeader: string }> = [];
  const repository = new InMemoryWebhookRepository();
  const { app } = await buildWebhookTestApp({
    repository,
    n8nClient: {
      stripe: {
        forwardWebhook: async (input) => {
          forwarded.push(input);
        },
      },
      asaas: {
        forwardWebhook: async () => undefined,
      },
    },
  });
  const rawBody = JSON.stringify({
    id: "evt_1",
    type: "invoice.paid",
    data: {
      object: {
        customer: "cus_123",
        subscription: "sub_123",
      },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "content-type": "application/json",
      "stripe-signature": createStripeSignature(rawBody, validConfig.webhooks.stripe.signingSecret),
    },
    payload: rawBody,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    received: true,
    duplicate: false,
    providerEventId: "evt_1",
  });
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.rawBody, rawBody);
  assert.equal(repository.billingEvents.get("evt_1")?.status, "processed");

  await app.close();
});

test("stripe webhook does not forward duplicates", async () => {
  let forwardCount = 0;
  const repository = new InMemoryWebhookRepository();
  repository.billingEvents.set("evt_1", { status: "processed", error: null });
  const { app } = await buildWebhookTestApp({
    repository,
    n8nClient: {
      stripe: {
        forwardWebhook: async () => {
          forwardCount += 1;
        },
      },
      asaas: {
        forwardWebhook: async () => undefined,
      },
    },
  });
  const rawBody = JSON.stringify({
    id: "evt_1",
    type: "invoice.paid",
    data: { object: {} },
  });

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "content-type": "application/json",
      "stripe-signature": createStripeSignature(rawBody, validConfig.webhooks.stripe.signingSecret),
    },
    payload: rawBody,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(forwardCount, 0);
  assert.deepEqual(response.json(), {
    received: true,
    duplicate: true,
    providerEventId: "evt_1",
  });

  await app.close();
});

test("stripe webhook keeps failed forwards pending retry", async () => {
  const repository = new InMemoryWebhookRepository();
  const { app } = await buildWebhookTestApp({
    repository,
    n8nClient: {
      stripe: {
        forwardWebhook: async () => {
          throw new Error("upstream_down");
        },
      },
      asaas: {
        forwardWebhook: async () => undefined,
      },
    },
  });
  const rawBody = JSON.stringify({
    id: "evt_2",
    type: "customer.subscription.updated",
    data: { object: {} },
  });

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "content-type": "application/json",
      "stripe-signature": createStripeSignature(rawBody, validConfig.webhooks.stripe.signingSecret),
    },
    payload: rawBody,
  });

  assert.equal(response.statusCode, 502);
  assert.equal(repository.billingEvents.get("evt_2")?.status, "pending_retry");

  await app.close();
});

test("asaas webhook validates token and forwards new events", async () => {
  const forwarded: Array<{ rawBody: string; accessToken: string }> = [];
  const repository = new InMemoryWebhookRepository();
  const { app } = await buildWebhookTestApp({
    repository,
    n8nClient: {
      stripe: {
        forwardWebhook: async () => undefined,
      },
      asaas: {
        forwardWebhook: async (input) => {
          forwarded.push(input);
        },
      },
    },
  });
  const rawBody = JSON.stringify({
    event: "PAYMENT_RECEIVED",
    payment: {
      externalReference: "order-1",
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/asaas",
    headers: {
      "content-type": "application/json",
      "asaas-access-token": "asaas-token",
    },
    payload: rawBody,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(repository.paymentEvents.get("asaas:order-1:PAYMENT_RECEIVED")?.status, "processed");

  await app.close();
});

test("asaas webhook rejects invalid stored token", async () => {
  const { app } = await buildWebhookTestApp();
  const rawBody = JSON.stringify({
    event: "PAYMENT_RECEIVED",
    payment: {
      externalReference: "order-1",
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/asaas",
    headers: {
      "content-type": "application/json",
      "asaas-access-token": "wrong-token",
    },
    payload: rawBody,
  });

  assert.equal(response.statusCode, 401);

  await app.close();
});
