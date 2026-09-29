import { createWorkerApp } from "./app.js";
import type { WorkerBindings } from "./environment.js";
import { createWorkerServices } from "./services.js";
import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import type { AuthRuntime } from "../modules/auth/runtime.js";
import type { StripeGateway } from "../modules/billing/stripe/types.js";
import { parseWorkerJson, requireWorkerAuth, trustedRateLimitKey, workerRateLimit } from "./http.js";

type FixtureBindings = WorkerBindings & { TEST_GREETING: string };

const fakeDatabase = {
  async query() { return { rows: [] }; },
  async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
} as unknown as Database;
const fakeAuthRuntime: AuthRuntime = {
  async handler(request) {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "session=one; Secure; HttpOnly; SameSite=Lax; Path=/");
    headers.append("set-cookie", "session=two; Secure; HttpOnly; SameSite=Lax; Path=/");
    return new Response(JSON.stringify({
      method: request.method,
      search: new URL(request.url).search,
      body: request.method === "POST" ? await request.text() : null,
    }), { headers });
  },
  async getSession(headers) {
    if (!headers.get("cookie")?.includes("session=owner")) return null;
    return {
      user: { id: "user-1", email: "owner@vapt.test", name: "Owner" },
      session: { id: "session-1", userId: "user-1", expiresAt: new Date("2030-01-01") },
    };
  },
  async close() {},
};
let serviceFactoryCalls = 0;
const app = createWorkerApp((env, context) => {
  serviceFactoryCalls++;
  return createWorkerServices(env, context, {
    config: { nodeEnv: "test", paymentEffects: { pollIntervalMs: 5_000, batchSize: 25, leaseMs: 60_000, maxAttempts: 5, retryBaseMs: 30_000 } } as AppConfig,
    database: fakeDatabase,
    authRuntime: fakeAuthRuntime,
    stripeGateway: {} as StripeGateway,
    ownershipLookup: async ({ userId, restaurantId }) =>
      userId === "user-1" && restaurantId === "10000000-0000-4000-8000-000000000001",
  });
}, { authRateLimit: false });
app.get("/_test/composition-counts", (context) => context.json({ serviceFactoryCalls }));
app.get("/_test/missing-ingress", (context) => {
  trustedRateLimitKey(new Headers({ "x-forwarded-for": "1.2.3.4" }), "auth");
  return context.json({ unexpected: true });
});
app.get("/_test/protected", workerRateLimit("auth"), async (context) => {
  const auth = await requireWorkerAuth(context);
  return context.json({ userId: auth.userId });
});
app.post("/_test/parse", async (context) => context.json(await parseWorkerJson(context.req.raw)));
app.get("/_test/echo/:value", (context) => context.json({
  value: context.req.param("value"),
  query: context.req.query("q"),
  greeting: (context.env as FixtureBindings).TEST_GREETING,
}));

export default { fetch: app.fetch };
