import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import { PostgresDialect, type PostgresPool } from "kysely";

import type { AuthEmailService } from "../../email/types.js";
import type { BetterAuthConfig } from "../../lib/config.js";
import type {
  AuthRuntime,
  BackgroundTaskRunner,
  BetterAuthSession,
} from "./runtime.js";

export type BetterAuthOptionDependencies = {
  pool: PostgresPool;
  emailService: AuthEmailService;
  runInBackground: BackgroundTaskRunner;
};

export function createBetterAuthOptions(
  config: BetterAuthConfig,
  dependencies: BetterAuthOptionDependencies,
) {
  return {
    appName: "Vapt",
    baseURL: config.url.origin,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: {
      dialect: new PostgresDialect({ pool: dependencies.pool }),
      type: "postgres" as const,
      schemaName: "better_auth",
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }: {
        user: { email: string };
        url: string;
        token: string;
      }) {
        dependencies.runInBackground(
          dependencies.emailService.sendPasswordReset({
            to: user.email,
            resetPasswordUrl: url,
          }),
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      async sendVerificationEmail({ user, url, token }: {
        user: { email: string };
        url: string;
        token: string;
      }) {
        dependencies.runInBackground(
          dependencies.emailService.sendVerification({
            to: user.email,
            confirmationCode: token,
            confirmationUrl: url,
          }),
        );
      },
    },
    plugins: [
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: config.turnstileSecretKey,
        endpoints: [
          "/sign-up/email",
          "/sign-in/email",
          "/request-password-reset",
        ],
      }),
    ],
    advanced: {
      useSecureCookies: config.url.protocol === "https:",
      database: {
        generateId: "uuid" as const,
        joins: true,
      },
    },
  };
}

export type BetterAuthRuntimeDependencies = {
  emailService: AuthEmailService;
  runInBackground: BackgroundTaskRunner;
  pool: PostgresPool;
};

export function createBetterAuthRuntime(
  config: BetterAuthConfig,
  dependencies: BetterAuthRuntimeDependencies,
): AuthRuntime {
  const auth = betterAuth(createBetterAuthOptions(config, {
    pool: dependencies.pool,
    emailService: dependencies.emailService,
    runInBackground: dependencies.runInBackground,
  }));

  return {
    handler: auth.handler,
    async getSession(headers) {
      const session = await auth.api.getSession({ headers });
      return session as BetterAuthSession | null;
    },
    async close() {},
  };
}
