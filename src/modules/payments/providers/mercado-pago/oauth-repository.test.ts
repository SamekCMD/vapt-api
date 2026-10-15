import assert from "node:assert/strict";
import test from "node:test";

import type { Queryable } from "../../../../lib/database.js";
import { AppError } from "../../../../lib/errors.js";
import { createMercadoPagoOAuthRepository } from "./oauth.js";

const restaurantId = "10000000-0000-4000-8000-000000000001";
const accountId = "20000000-0000-4000-8000-000000000002";
const consumedAt = "2026-08-06T12:00:00.000Z";

type QueryCall = { sql: string; values: unknown[] | undefined };

function databaseWith(
  responses: Array<{ rows: unknown[] } | Error>,
  calls: QueryCall[],
): Queryable {
  return {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("unexpected query");
      return response;
    },
  } as unknown as Queryable;
}

const rawState = {
  id: "state-1",
  restaurant_id: restaurantId,
  environment: "sandbox",
  state_hash: "hashed-state",
  code_verifier_encrypted: "encrypted-verifier",
  credential_key_id: "env-v1",
  redirect_uri: "https://api.example.com/payments/mercado-pago/oauth/callback",
  expires_at: new Date("2026-08-06T12:10:00.000Z"),
  consumed_at: new Date(consumedAt),
  created_at: new Date("2026-08-06T11:59:00.000Z"),
};

const rawAccount = {
  id: accountId,
  restaurant_id: restaurantId,
  environment: "sandbox",
  status: "active",
  external_account_id: "seller-1",
  capabilities: { payments: true },
  access_token_encrypted: "encrypted-access",
  refresh_token_encrypted: "encrypted-refresh",
  credential_key_id: "env-v1",
  token_expires_at: new Date("2026-08-06T18:00:00.000Z"),
  connected_at: new Date("2026-08-06T12:00:00.000Z"),
  disconnected_at: null,
  last_error: null,
  version: 2,
};

test("consumes an OAuth state atomically before returning it", async () => {
  const calls: QueryCall[] = [];
  const repository = createMercadoPagoOAuthRepository(databaseWith([
    { rows: [rawState] },
  ], calls));

  const result = await repository.consumeOAuthState({
    stateHash: "hashed-state",
    consumedAt,
  });

  assert.equal(result?.stateHash, "hashed-state");
  assert.equal(result?.consumedAt, consumedAt);
  assert.equal(result?.expiresAt, "2026-08-06T12:10:00.000Z");
  assert.match(calls[0]?.sql ?? "", /update public\.payment_oauth_states/i);
  assert.match(calls[0]?.sql ?? "", /consumed_at is null/i);
  assert.match(calls[0]?.sql ?? "", /expires_at\s*>\s*\$2::timestamptz/i);
  assert.deepEqual(calls[0]?.values, ["hashed-state", consumedAt]);
});

test("upserts Mercado Pago credentials on the tenant/provider/environment key", async () => {
  const calls: QueryCall[] = [];
  const repository = createMercadoPagoOAuthRepository(databaseWith([
    { rows: [rawAccount] },
  ], calls));

  const account = await repository.upsertProviderAccount({
    restaurantId,
    environment: "sandbox",
    status: "active",
    externalAccountId: "seller-1",
    capabilities: { payments: true },
    accessTokenEncrypted: "encrypted-access",
    refreshTokenEncrypted: "encrypted-refresh",
    credentialKeyId: "env-v1",
    tokenExpiresAt: "2026-08-06T18:00:00.000Z",
    connectedAt: "2026-08-06T12:00:00.000Z",
  });

  assert.equal(account.tokenExpiresAt, "2026-08-06T18:00:00.000Z");
  assert.match(calls[0]?.sql ?? "", /on conflict\s*\(restaurant_id,\s*provider,\s*environment\)/i);
  assert.deepEqual(calls[0]?.values?.slice(0, 3), [restaurantId, "sandbox", "active"]);
});

test("token rotation and disconnect use optimistic versioning and clear credentials", async () => {
  const calls: QueryCall[] = [];
  const repository = createMercadoPagoOAuthRepository(databaseWith([
    { rows: [{ ...rawAccount, version: 3 }] },
    { rows: [{
      ...rawAccount,
      status: "disconnected",
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      credential_key_id: null,
      token_expires_at: null,
      disconnected_at: new Date("2026-08-06T19:00:00.000Z"),
      version: 4,
    }] },
  ], calls));

  const rotated = await repository.updateProviderTokens({
    accountId,
    expectedVersion: 2,
    accessTokenEncrypted: "new-access",
    refreshTokenEncrypted: "new-refresh",
    credentialKeyId: "env-v2",
    tokenExpiresAt: "2026-08-06T20:00:00.000Z",
  });
  const disconnected = await repository.disconnectProviderAccount({
    restaurantId,
    environment: "sandbox",
    disconnectedAt: "2026-08-06T19:00:00.000Z",
  });

  assert.equal(rotated?.version, 3);
  assert.match(calls[0]?.sql ?? "", /version\s*=\s*version\s*\+\s*1/i);
  assert.deepEqual(calls[0]?.values?.slice(-2), [accountId, 2]);
  assert.equal(disconnected?.accessTokenEncrypted, null);
  assert.match(calls[1]?.sql ?? "", /access_token_encrypted\s*=\s*null/i);
  assert.deepEqual(calls[1]?.values, [restaurantId, "sandbox", "2026-08-06T19:00:00.000Z"]);
});

test("OAuth storage failures never expose ciphertext or SQL", async () => {
  const repository = createMercadoPagoOAuthRepository(databaseWith([
    new Error("select encrypted-access from payment_provider_accounts"),
  ], []));

  await assert.rejects(
    () => repository.findProviderAccount(restaurantId, "sandbox"),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "payment_storage_error");
      assert.equal(error.message, "Failed to load Mercado Pago connection");
      assert.equal(error.diagnostics, undefined);
      assert.doesNotMatch(error.message, /encrypted|select|payment_provider/i);
      return true;
    },
  );
});
