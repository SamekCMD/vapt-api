import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import type { BetterAuthConfig } from "../../lib/config.js";
import type { AuthEmailService } from "../../email/types.js";
import { createBetterAuthOptions } from "./better-auth.js";

const config: BetterAuthConfig = {
  secret: "better-auth-secret-at-least-32-characters",
  url: new URL("https://api.preview.vapt.test"),
  trustedOrigins: [
    "https://preview.vapt.test",
    "http://localhost:5173",
  ],
  databaseUrl: "postgresql://vapt:password@db.vapt.test/vapt",
  turnstileSecretKey: "turnstile-secret-key",
  email: {
    resendApiKey: "re_test_key",
    from: "Vapt <no-reply@vapt.app.br>",
    verifyAccountTemplate: "account-confirmation",
    resetPasswordTemplate: "password-reset",
  },
};

function createFixture() {
  const deliveries: unknown[] = [];
  const backgroundTasks: Promise<unknown>[] = [];
  const emailService: AuthEmailService = {
    async sendVerification(input) {
      deliveries.push({ kind: "verification", input });
    },
    async sendPasswordReset(input) {
      deliveries.push({ kind: "password-reset", input });
    },
  };
  const pool = new Pool({ connectionString: config.databaseUrl });
  const options = createBetterAuthOptions(config, {
    pool,
    emailService,
    runInBackground(task) {
      backgroundTasks.push(task);
    },
  });

  return { backgroundTasks, deliveries, options, pool };
}

test("Better Auth options isolate UUID auth tables in the better_auth schema", async (t) => {
  const { options, pool } = createFixture();
  t.after(() => pool.end());

  assert.equal(
    (options.database as { schemaName?: string }).schemaName,
    "better_auth",
  );
  assert.equal(options.advanced?.database?.generateId, "uuid");
  assert.equal(options.advanced?.database?.joins, true);
});

test("Better Auth options require verified email and keep origin protections enabled", async (t) => {
  const { options, pool } = createFixture();
  t.after(() => pool.end());

  assert.equal(options.baseURL, "https://api.preview.vapt.test");
  assert.deepEqual(options.trustedOrigins, config.trustedOrigins);
  assert.equal(options.emailAndPassword?.enabled, true);
  assert.equal(options.emailAndPassword?.requireEmailVerification, true);
  assert.equal(options.emailAndPassword?.revokeSessionsOnPasswordReset, true);
  assert.equal(options.emailVerification?.sendOnSignUp, true);
  assert.equal(options.emailVerification?.sendOnSignIn, true);
  const advanced = options.advanced as {
    disableCSRFCheck?: boolean;
    disableOriginCheck?: boolean;
  };
  assert.notEqual(advanced.disableCSRFCheck, true);
  assert.notEqual(advanced.disableOriginCheck, true);
});

test("Better Auth protects the exact email endpoints with Cloudflare Turnstile", async (t) => {
  const { options, pool } = createFixture();
  t.after(() => pool.end());
  const plugin = options.plugins?.find((candidate) => candidate.id === "captcha");

  assert.ok(plugin);
  assert.deepEqual(plugin.options, {
    provider: "cloudflare-turnstile",
    secretKey: "turnstile-secret-key",
    endpoints: [
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
    ],
  });
});

test("Better Auth delegates published email variables through the background runner", async (t) => {
  const { backgroundTasks, deliveries, options, pool } = createFixture();
  t.after(() => pool.end());
  const verification = options.emailVerification?.sendVerificationEmail;
  const passwordReset = options.emailAndPassword?.sendResetPassword;
  assert.ok(verification);
  assert.ok(passwordReset);

  await verification({
    user: {
      email: "gestor@vapt.test",
    },
    token: "verification-token-redacted",
    url: "https://api.preview.vapt.test/api/auth/verify-email?token=redacted",
  });
  await passwordReset({
    user: {
      email: "gestor@vapt.test",
    },
    token: "reset-token-redacted",
    url: "https://preview.vapt.test/reset-password?token=redacted",
  });

  assert.equal(backgroundTasks.length, 2);
  await Promise.all(backgroundTasks);
  assert.deepEqual(deliveries, [
    {
      kind: "verification",
      input: {
        to: "gestor@vapt.test",
        confirmationCode: "verification-token-redacted",
        confirmationUrl:
          "https://api.preview.vapt.test/api/auth/verify-email?token=redacted",
      },
    },
    {
      kind: "password-reset",
      input: {
        to: "gestor@vapt.test",
        resetPasswordUrl:
          "https://preview.vapt.test/reset-password?token=redacted",
      },
    },
  ]);
});
