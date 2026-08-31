import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createMercadoPagoOAuthRepository } from "./oauth.js";

test("consumes an OAuth state atomically before returning it", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const consumedAt = "2026-08-06T12:00:00.000Z";
  const row = {
    id: "state-1",
    restaurant_id: "10000000-0000-4000-8000-000000000001",
    environment: "sandbox",
    state_hash: "hashed-state",
    code_verifier_encrypted: "encrypted-verifier",
    credential_key_id: "env-v1",
    redirect_uri: "https://api.example.com/payments/mercado-pago/oauth/callback",
    expires_at: "2026-08-06T12:10:00.000Z",
    consumed_at: consumedAt,
    created_at: "2026-08-06T11:59:00.000Z",
  };

  const chain = {
    update(value: unknown) {
      calls.push({ method: "update", args: [value] });
      return this;
    },
    eq(column: string, value: unknown) {
      calls.push({ method: "eq", args: [column, value] });
      return this;
    },
    is(column: string, value: unknown) {
      calls.push({ method: "is", args: [column, value] });
      return this;
    },
    gt(column: string, value: unknown) {
      calls.push({ method: "gt", args: [column, value] });
      return this;
    },
    select(columns: string) {
      calls.push({ method: "select", args: [columns] });
      return this;
    },
    async maybeSingle<T>() {
      calls.push({ method: "maybeSingle", args: [] });
      return { data: row as T, error: null };
    },
  };
  const client = {
    from(table: string) {
      calls.push({ method: "from", args: [table] });
      return chain;
    },
  } as unknown as SupabaseClient;

  const repository = createMercadoPagoOAuthRepository(client);
  const result = await repository.consumeOAuthState({
    stateHash: "hashed-state",
    consumedAt,
  });

  assert.equal(result?.stateHash, "hashed-state");
  assert.equal(result?.consumedAt, consumedAt);
  assert.deepEqual(
    calls.map(({ method, args }) => ({ method, args })),
    [
      { method: "from", args: ["payment_oauth_states"] },
      { method: "update", args: [{ consumed_at: consumedAt }] },
      { method: "eq", args: ["state_hash", "hashed-state"] },
      { method: "is", args: ["consumed_at", null] },
      { method: "gt", args: ["expires_at", consumedAt] },
      { method: "select", args: [
        "id, restaurant_id, environment, state_hash, code_verifier_encrypted, credential_key_id, redirect_uri, expires_at, consumed_at, created_at",
      ] },
      { method: "maybeSingle", args: [] },
    ],
  );
});
