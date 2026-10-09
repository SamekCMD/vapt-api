import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { signIngressTicket, verifyIngressTicket } from "./ingress-ticket.js";

const now = 2_000_000_000_000;
const key = "synthetic-realtime-ingress-secret-32-characters";
const audience = { environment: "production", origin: "https://vapt.test", restaurantId: "11111111-1111-4111-8111-111111111111" } as const;
const raw = "x".repeat(43);
const ticket = { ticket: raw, restaurantId: audience.restaurantId, expiresAt: now + 30_000 };
const referenceMac = createHmac("sha256", key).update(JSON.stringify([
  "vapt.realtime.ingress.v1", "production", "https://vapt.test", "11111111-1111-4111-8111-111111111111", raw, now + 30_000,
])).digest("base64url");
const signed = `rt1.${raw}.${now + 30_000}.${referenceMac}`;
const header = (value = signed) => `vapt.realtime.v1, vapt.ticket.${value}`;

test("production ingress proof preserves raw authority and expires exactly at the deadline", () => {
  assert.equal(signIngressTicket(ticket, audience, key, now), signed);
  assert.equal(verifyIngressTicket(header(), audience, key, now), raw);
  assert.equal(verifyIngressTicket(header(), audience, key, now + 29_999), raw);
  assert.equal(verifyIngressTicket(header(), audience, key, now + 30_000), null);
  assert.equal(verifyIngressTicket(header(), audience, key, now - 1), null, "future authority exceeding the 30s window is refused");
});

test("proof rejects room/origin/environment substitution and credential rotation", () => {
  for (const changed of [{ ...audience, restaurantId: "22222222-2222-4222-8222-222222222222" },
    { ...audience, origin: "https://other.test" }, { ...audience, environment: "preview" as const }]) {
    assert.equal(verifyIngressTicket(header(), changed, key, now), null);
  }
  assert.equal(verifyIngressTicket(header(), audience, "other-synthetic-credential-32-characters", now), null);
  assert.equal(verifyIngressTicket(header(signed.replace(String(now + 30_000), String(now + 30_001))), audience, key, now), null);
});

test("noncanonical MAC aliases and ambiguous or oversized protocols fail before grant lookup", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = referenceMac.slice(0, -1) + alphabet[alphabet.indexOf(referenceMac.at(-1)!) + 1];
  assert.equal(verifyIngressTicket(header(`rt1.${raw}.${now + 30_000}.${alias}`), audience, key, now), null);
  for (const value of [header() + ", extra", header() + ", vapt.realtime.v1",
    `vapt.ticket.${signed}, vapt.ticket.${signed}`, `vapt.realtime.v1,${" ".repeat(100)}vapt.ticket.${signed}`,
    header(`rt1.${raw}.0${now + 30_000}.${referenceMac}`), header(`rt1.${raw}.${Number.MAX_SAFE_INTEGER + 1}.${referenceMac}`)]) {
    assert.equal(verifyIngressTicket(value, audience, key, now), null);
  }
});

test("issuer fails closed for missing key, malformed room, wrong raw scope and invalid expiry", () => {
  for (const signingKey of [undefined, "short", " ".repeat(32)]) {
    assert.throws(() => signIngressTicket(ticket, audience, signingKey, now));
    assert.equal(verifyIngressTicket(header(), audience, signingKey, now), null);
  }
  for (const value of [{ ...ticket, ticket: "short" }, { ...ticket, restaurantId: "22222222-2222-4222-8222-222222222222" },
    { ...ticket, expiresAt: now }, { ...ticket, expiresAt: now + 30_001 }]) {
    assert.throws(() => signIngressTicket(value, audience, key, now));
  }
  assert.throws(() => signIngressTicket(ticket, { ...audience, origin: "https://vapt.test/path" }, key, now));
  assert.equal(verifyIngressTicket(header(), { ...audience, restaurantId: "invalid" }, key, now), null);
});
