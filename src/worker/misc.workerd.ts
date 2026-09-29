import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "wrangler";

const restaurantId = "10000000-0000-4000-8000-000000000001";
const itemId = "10000000-0000-4000-8000-000000000041";

test("misc Worker routes fail closed and preserve admin and image contracts", async () => {
  const server = createTestHarness({ workers: [
    { configPath: "./wrangler.worker-test.jsonc" },
    { configPath: "./wrangler.worker-test-misc.jsonc" },
  ] });
  try {
    await server.listen();
    const base = "https://api.vapt.test";
    const disabled = server.getWorker("vapt-api-worker-test");
    const enabled = server.getWorker("vapt-api-worker-misc-test");
    const imagePath = `/restaurants/${restaurantId}/menu-items/${itemId}/image`;
    const disabledUpload = await disabled.fetch(`${base}${imagePath}/upload`, { method: "POST" });
    assert.equal(disabledUpload.status, 404);
    const noPushSession = await enabled.fetch(`${base}/ingest/push-subscription`, { method: "POST" });
    assert.equal(noPushSession.status, 401);
    const noFeedbackToken = await enabled.fetch(`${base}/ingest/order-feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_id: "10000000-0000-4000-8000-000000000011", rating: 5 }),
    });
    assert.equal(noFeedbackToken.status, 401);
    const acceptedFeedback = await enabled.fetch(`${base}/ingest/order-feedback`, {
      method: "POST", headers: { "content-type": "application/json", "x-vapt-order-token": "synthetic-public-order-token-1234567890" },
      body: JSON.stringify({ order_id: "10000000-0000-4000-8000-000000000011", rating: 5 }),
    });
    assert.equal(acceptedFeedback.status, 200);
    const acceptedPush = await enabled.fetch(`${base}/ingest/push-subscription`, {
      method: "POST", headers: { cookie: "session=owner", "content-type": "application/json" },
      body: JSON.stringify({ subscription: { endpoint: "https://push.vapt.test/sub" }, endpoint: "https://push.vapt.test/sub", origin: "https://app.vapt.test", user_agent: "synthetic" }),
    });
    assert.equal(acceptedPush.status, 200);

    const wrongAdminKey = await enabled.fetch(`${base}/admin/payments/effects/reprocess`, {
      method: "POST", headers: { "content-type": "application/json", "x-vapt-admin-key": "wrong" }, body: "{}",
    });
    assert.equal(wrongAdminKey.status, 401);
    const badLimit = await enabled.fetch(`${base}/admin/payments/effects/reprocess`, {
      method: "POST", headers: { "content-type": "application/json", "x-vapt-admin-key": "synthetic-admin-secret" },
      body: '{"limit":101}',
    });
    assert.equal(badLimit.status, 400);
    assert.deepEqual(await badLimit.json(), {
      error: { code: "invalid_request", message: "Limit must be an integer from 1 to 100" },
    });
    const validRun = await enabled.fetch(`${base}/admin/payments/effects/reprocess`, {
      method: "POST", headers: { "content-type": "application/json", "x-vapt-admin-key": "synthetic-admin-secret" },
      body: '{"limit":2}',
    });
    assert.equal(validRun.status, 200);

    const upload = await enabled.fetch(`${base}${imagePath}/upload`, {
      method: "POST", headers: { cookie: "session=owner", "content-type": "application/json" },
      body: '{"contentType":"image/png","contentLength":1234}',
    });
    assert.equal(upload.status, 200);
    const prepared = await upload.json() as { method: string; headers: Record<string, string>; expiresInSeconds: number };
    assert.equal(prepared.method, "PUT");
    assert.equal(prepared.headers["Content-Type"], "image/png");
    assert.equal(prepared.expiresInSeconds, 300);
    const deleted = await enabled.fetch(`${base}${imagePath}`, {
      method: "DELETE", headers: { cookie: "session=owner" },
    });
    assert.equal(deleted.status, 204);
    const foreignDelete = await enabled.fetch(`${base}/restaurants/10000000-0000-4000-8000-000000000002/menu-items/${itemId}/image`, {
      method: "DELETE", headers: { cookie: "session=owner" },
    });
    assert.equal(foreignDelete.status, 403);
    const counts = await enabled.fetch(`${base}/_test/misc-counts`);
    assert.deepEqual(await counts.json(), {
      adminRunCalls: 1, adminRequestedLimit: 2, intervalStarts: 0,
      bucketDeletedKey: `${restaurantId}/${itemId}`, realR2Calls: 0,
    });
  } finally {
    await server.close();
  }
});
