import assert from "node:assert/strict";
import test from "node:test";

import { createSessionResolver } from "./session-resolver.js";
import type { AuthRuntime } from "./runtime.js";

test("session resolver accepts Fetch Headers and ignores bearer-only identity", async () => {
  const seen: Headers[] = [];
  const runtime: AuthRuntime = {
    async handler() { return new Response(); },
    async getSession(headers) {
      seen.push(headers);
      return headers.get("cookie") === "session=owner"
        ? { user: { id: "user-1", email: "owner@vapt.test", name: "Owner" },
            session: { id: "session-1", userId: "user-1", expiresAt: new Date('2030-01-01T00:00:00Z') } }
        : null;
    },
    async close() {},
  };
  const resolve = createSessionResolver(runtime, "fetch");
  assert.deepEqual(await resolve(new Headers({ cookie: "session=owner" })), {
    userId: "user-1", email: "owner@vapt.test", role: "authenticated",
    sessionId: "session-1", sessionExpiresAt: 1893456000000,
  });
  assert.equal(await resolve(new Headers({ authorization: "Bearer legacy" })), null);
  assert.equal(seen[0]?.get("cookie"), "session=owner");
});

test('session resolver rejects expired, invalid or cross-user session metadata', async () => {
  for (const session of [
    { id:'session-1', userId:'user-1', expiresAt:new Date(0) },
    { id:'session-1', userId:'user-1', expiresAt:new Date(NaN) },
    { id:'session-1', userId:'other', expiresAt:new Date('2030-01-01') },
  ]) {
    const runtime: AuthRuntime = {
      async handler() { return new Response(); }, async close() {},
      async getSession() { return { user:{ id:'user-1',email:'test@example.invalid',name:'Teste' },session }; },
    };
    assert.equal(await createSessionResolver(runtime,'fetch')(new Headers({ cookie:'session=test' })), null);
  }
});
