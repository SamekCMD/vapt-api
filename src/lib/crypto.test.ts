import assert from "node:assert/strict";
import test from "node:test";

import {
  createSecretCipher,
  parseSecretEncryptionKey,
} from "./crypto.js";

const key = Buffer.alloc(32, 7);

test("secret cipher encrypts and decrypts with AES-256-GCM", () => {
  const cipher = createSecretCipher(key);
  const encrypted = cipher.encrypt("access-token", "restaurant-1:mercado_pago");

  assert.match(encrypted, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(
    cipher.decrypt(encrypted, "restaurant-1:mercado_pago"),
    "access-token",
  );
  assert.equal(encrypted.includes("access-token"), false);
});

test("secret cipher generates a different nonce for every encryption", () => {
  const cipher = createSecretCipher(key);

  const first = cipher.encrypt("same-token", "restaurant-1");
  const second = cipher.encrypt("same-token", "restaurant-1");

  assert.notEqual(first, second);
});

test("secret cipher rejects a tampered authentication tag", () => {
  const cipher = createSecretCipher(key);
  const encrypted = cipher.encrypt("refresh-token", "restaurant-1");
  const parts = encrypted.split(".");
  parts[2] = Buffer.alloc(16, 1).toString("base64url");

  assert.throws(
    () => cipher.decrypt(parts.join("."), "restaurant-1"),
    /encrypted secret could not be authenticated/i,
  );
});

test("secret cipher binds ciphertext to its associated context", () => {
  const cipher = createSecretCipher(key);
  const encrypted = cipher.encrypt("access-token", "restaurant-1");

  assert.throws(
    () => cipher.decrypt(encrypted, "restaurant-2"),
    /encrypted secret could not be authenticated/i,
  );
});

test("parseSecretEncryptionKey accepts only a base64 encoded 32-byte key", () => {
  assert.deepEqual(parseSecretEncryptionKey(key.toString("base64")), key);
  assert.throws(
    () => parseSecretEncryptionKey(Buffer.alloc(31).toString("base64")),
    /32 bytes/i,
  );
  assert.throws(() => parseSecretEncryptionKey("not-base64!"), /base64/i);
});
