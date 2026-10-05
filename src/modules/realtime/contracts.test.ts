import assert from "node:assert/strict";
import test from "node:test";

import * as contracts from "./contracts.js";

const envelope = {
  version: 1,
  eventId: "10000000-0000-4000-8000-000000000001",
  sequence: 1,
  topic: "orders",
  entityId: "10000000-0000-4000-8000-000000000002",
  reason: "created",
};

test("realtime opt-in enables only an explicit true value", () => {
  assert.equal(typeof contracts.isRealtimeEnabled, "function", "realtime flag reader must exist");
  const enabled = contracts.isRealtimeEnabled!;
  for (const value of [undefined, "", "false", "TRUE", "1", " true "]) {
    assert.equal(enabled(value), false);
  }
  assert.equal(enabled("true"), true);
});

test("realtime envelope validates the known versioned invalidation contract", () => {
  assert.equal(typeof contracts.parseRealtimeEnvelope, "function", "realtime parser must exist");
  assert.deepEqual(contracts.parseRealtimeEnvelope!(envelope), envelope);
  for (const topic of ["orders", "kitchen", "table_sessions", "payments"]) {
    assert.deepEqual(contracts.parseRealtimeEnvelope!({ ...envelope, topic }), { ...envelope, topic });
  }
});

test("realtime envelope rejects business payloads and unknown fields", () => {
  assert.equal(typeof contracts.parseRealtimeEnvelope, "function", "realtime parser must exist");
  for (const field of ["token", "email", "items", "totalPrice", "restaurantId", "type"]) {
    assert.equal(contracts.parseRealtimeEnvelope!({ ...envelope, [field]: "synthetic" }), null);
  }
});

test("realtime envelope rejects malformed identifiers, topics and sequences", () => {
  assert.equal(typeof contracts.parseRealtimeEnvelope, "function", "realtime parser must exist");
  const invalid = [null, undefined, [], "event", {},
    { ...envelope, version: 2 }, { ...envelope, topic: "catalog" },
    { ...envelope, reason: "paid-secret" }, { ...envelope, entityId: "other" },
    { ...envelope, eventId: "other" }, { ...envelope, sequence: -1 },
    { ...envelope, sequence: 0.1 }, { ...envelope, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...envelope, sequence: NaN }, { ...envelope, sequence: Infinity },
    { ...envelope, topic: "orders".repeat(4096) },
  ];
  for (const value of invalid) assert.equal(contracts.parseRealtimeEnvelope!(value), null);
  assert.deepEqual(contracts.parseRealtimeEnvelope!({ ...envelope, sequence: 0 }), { ...envelope, sequence: 0 });
});
