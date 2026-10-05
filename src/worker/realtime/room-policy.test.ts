import assert from "node:assert/strict";
import test from "node:test";
import * as roomPolicy from "./room-policy.js";

async function policy() {
  return roomPolicy;
}
const owner = { mode: "owner", restaurantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222", sessionId: "33333333-3333-4333-8333-333333333333",
  sessionExpiresAt: 1_000_000 } as const;
const admission = { environment: "preview", origin: "https://app.vapt.test", grant: owner } as const;

test("admission and attachments whitelist minimal valid authority and a bounded lease", async () => {
  const p = await policy();
  assert.deepEqual(p.parseAdmission(admission), admission);
  for (const bad of [null, { ...admission, cookie: "secret" }, { ...admission, environment: "legacy" },
    { ...admission, origin: "https://app.vapt.test/path" },
    { ...admission, grant: { ...owner, sessionId: "bad" } },
    { ...admission, grant: { ...owner, token: "secret" } }]) assert.equal(p.parseAdmission(bad), null);
  assert.equal(p.leaseExpiry(owner, 1000), 301_000);
  assert.equal(p.leaseExpiry({ ...owner, sessionExpiresAt: 2000 }, 1000), 2000);
  const attachment = { version: 1, admission, expiresAt: 301_000, lastSent: 8, lastAck: 7 } as const;
  assert.deepEqual(p.parseAttachment(attachment), attachment);
  for (const bad of [{ ...attachment, lastAck: 9 }, { ...attachment, expiresAt: -1 },
    { ...attachment, version: 2 }, { ...attachment, credential: "secret" }]) assert.equal(p.parseAttachment(bad), null);
});

test("identity cap uses owner user or public order, never session or IP", async () => {
  const p = await policy();
  assert.equal(p.identity(owner), p.identity({ ...owner, sessionId: "44444444-4444-4444-8444-444444444444" }));
  const guest = { mode: "order", restaurantId: owner.restaurantId, orderId: owner.userId, tokenFingerprint: "a".repeat(64) } as const;
  assert.equal(p.identity(guest), p.identity({ ...guest, tokenFingerprint: "b".repeat(64) }));
  assert.notEqual(p.identity(owner), p.identity(guest));
  assert.equal(p.hasCapacity(Array(24).fill(owner), owner), false);
  assert.equal(p.hasCapacity(Array(23).fill(owner), owner), true);
  const other = { ...owner, userId: owner.sessionId };
  assert.equal(p.hasCapacity(Array(128).fill(owner), other), false);
  assert.equal(p.hasCapacity(Array(127).fill(owner), other), true);
});

test("only bounded heartbeat and advancing acknowledgements are accepted", async () => {
  const p = await policy();
  const ack = JSON.stringify({ version: 1, type: "ack", sequence: 8 });
  assert.deepEqual(p.parseControl(ack, 7, 8), { version: 1, type: "ack", sequence: 8 });
  assert.equal(p.parseControl(ack, 8, 8), null);
  assert.equal(p.parseControl(ack, 7, 7), null);
  assert.equal(p.parseControl(JSON.stringify({ version: 1, type: "ack", sequence: 8, token: "secret" }), 7, 8), null);
  assert.deepEqual(p.parseControl('{"version":1,"type":"ping"}' + " ".repeat(4069), 0, 0), { version: 1, type: "ping" });
  assert.equal(p.parseControl("x".repeat(4097), 0, 0), null);
  assert.equal(p.parseControl(new ArrayBuffer(8), 0, 0), null);
});
