import { betterAuth } from "better-auth";
import { Pool } from "pg";

import type { AuthEmailService } from "../../email/types.js";
import type { BetterAuthConfig } from "../../lib/config.js";
import { createBetterAuthOptions } from "./better-auth.js";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to generate the Better Auth schema");
}

const cliConfig: BetterAuthConfig = {
  secret:
    process.env.BETTER_AUTH_SECRET?.trim()
    ?? "schema-generation-only-secret-do-not-use",
  url: new URL(process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000"),
  trustedOrigins: ["http://localhost:5173"],
  databaseUrl,
  turnstileSecretKey: "schema-generation-only",
  email: {
    resendApiKey: "schema-generation-only",
    from: "Vapt <no-reply@vapt.app.br>",
    verifyAccountTemplate: "account-confirmation",
    resetPasswordTemplate: "password-reset",
  },
};

const pool = new Pool({ connectionString: databaseUrl });
const noOpEmailService: AuthEmailService = {
  async sendVerification() {},
  async sendPasswordReset() {},
};

export const auth = betterAuth(createBetterAuthOptions(cliConfig, {
  pool,
  emailService: noOpEmailService,
  runInBackground(task) {
    void task.catch(() => undefined);
  },
}));

export default auth;
