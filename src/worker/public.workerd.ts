import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

const orderId = "10000000-0000-4000-8000-000000000011";
const sessionId = "10000000-0000-4000-8000-000000000012";
const token = "synthetic-public-order-token-1234567890";
const body = {
  restaurantSlug: "synthetic-restaurant",
  channel: "local",
  tableNumber: 1,
  items: [{ menuItemId: "10000000-0000-4000-8000-000000000013", quantity: 1 }],
};

test("public Worker routes preserve order replay, tokens and validation", async () => {
  const server = createTestHarness({ workers: [{ configPath: "./wrangler.worker-test.jsonc" }] });
  try {
    await server.listen();
    const fixture = server.getWorker("vapt-api-worker-test");
    const base = "https://api.vapt.test";
    const orderRequest = (key: string, payload = body) => fixture.fetch(`${base}/public/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(payload),
    });

    const catalog = await fixture.fetch(`${base}/public/restaurants/synthetic-restaurant/catalog`);
    assert.equal(catalog.status, 200);
    const created = await orderRequest("synthetic-order-1");
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { orderId: string }).orderId, orderId);
    const replayed = await orderRequest("synthetic-order-1");
    assert.equal(replayed.status, 200);
    const conflict = await orderRequest("synthetic-order-1", { ...body, tableNumber: 2 });
    assert.equal(conflict.status, 409);
    const invalid = await orderRequest("synthetic-order-2", { ...body, items: [] });
    assert.equal(invalid.status, 400);
    const malformedOrderId = await fixture.fetch(`${base}/public/orders/not-a-uuid`, {
      headers: { "x-vapt-order-token": token },
    });
    assert.equal(malformedOrderId.status, 400);

    const read = await fixture.fetch(`${base}/public/orders/${orderId}`, {
      headers: { "x-vapt-order-token": token },
    });
    assert.equal(read.status, 200);
    const missingReadToken = await fixture.fetch(`${base}/public/orders/${orderId}`);
    assert.equal(missingReadToken.status, 400);
    const missingToken = await fixture.fetch(`${base}/public/orders/${orderId}/feedback`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: '{"rating":5}',
    });
    assert.equal(missingToken.status, 401);
    const feedback = await fixture.fetch(`${base}/public/orders/${orderId}/feedback`, {
      method: "PUT", headers: { "content-type": "application/json", "x-vapt-order-token": token },
      body: '{"rating":5}',
    });
    assert.equal(feedback.status, 200);
    const malformedFeedback = await fixture.fetch(`${base}/public/orders/${orderId}/feedback`, {
      method: "PUT", headers: { "content-type": "application/json", "x-vapt-order-token": token },
      body: '{"rating":9}',
    });
    assert.equal(malformedFeedback.status, 400);
    const check = await fixture.fetch(`${base}/public/table-sessions/${sessionId}/request-check`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicOrderId: orderId, publicOrderToken: token }),
    });
    assert.equal(check.status, 200);
    const wrongSession = await fixture.fetch(`${base}/public/table-sessions/10000000-0000-4000-8000-000000000014/request-check`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicOrderId: orderId, publicOrderToken: token }),
    });
    assert.equal(wrongSession.status, 404);
  } finally {
    await server.close();
  }
});
