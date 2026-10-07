import { createWorkerAuthRuntimeFactory } from "./auth-runtime.js";
import { syntheticAuthConfig, syntheticSchemaAuthDependencies } from "./auth-context-test-support.js";

// Only external SQL introspection/email are synthetic. The default Worker
// builder, Better Auth limiter and CAPTCHA admission remain real.
export async function probeWorkerAuthRateLimit(environment: string, ip: string, otherIp: string) {
  const events: string[] = [];
  const dependencies = syntheticSchemaAuthDependencies("rate", events);
  const runtime = createWorkerAuthRuntimeFactory()(syntheticAuthConfig(), dependencies, environment);
  const call = (address: string, forwarded: string, path = "/send-verification-email") => runtime.handler(
    new Request(`https://api.vapt.test/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.vapt.test", "cf-connecting-ip": address, "x-forwarded-for": forwarded },
      body: JSON.stringify({ email: "unknown@vapt.test", password: "synthetic-placeholder" }),
    }),
  );
  const statuses: number[] = [];
  const codes: unknown[] = [];
  for (let index = 0; index < 4; index++) {
    const response = await call(ip, `192.0.2.${index + 1}`);
    statuses.push(response.status);
    codes.push((await response.json() as { code?: unknown }).code ?? null);
  }
  const spoofed = await call(ip, "192.0.2.99");
  const alias = await call(ip, "192.0.2.98", "/send-verification-email/?synthetic=1");
  const independent = await call(otherIp, "192.0.2.99");
  const reset = await call(ip, "192.0.2.99", "/request-password-reset");
  const signIn = await call(ip, "192.0.2.99", "/sign-in/email");
  await runtime.close();
  return { statuses, codes, spoofed: spoofed.status, retryAfter: Number(spoofed.headers.get("x-retry-after")),
    alias: alias.status, independent: independent.status, reset: reset.status, signIn: signIn.status,
    cookieCount: spoofed.headers.getSetCookie().length, events, tasks: dependencies.tasks.length };
}
