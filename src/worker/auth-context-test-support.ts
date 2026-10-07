import type { PostgresPool, PostgresPoolClient } from "kysely";
import type { AuthEmailService } from "../email/types.js";
import type { BetterAuthConfig } from "../lib/config.js";
import { getSchema } from "better-auth/db";
import { createBetterAuthOptions } from "../modules/auth/better-auth.js";

export function syntheticAuthConfig(): BetterAuthConfig {
  return { secret: "synthetic-worker-auth-secret-at-least-32-characters", url: new URL("https://api.vapt.test"), trustedOrigins: ["https://app.vapt.test"], databaseUrl: "postgresql://synthetic:synthetic@db.vapt.test/vapt", turnstileSecretKey: "synthetic-turnstile", email: { resendApiKey: "re_synthetic", from: "Vapt <test@vapt.test>", verifyAccountTemplate: "verify", resetPasswordTemplate: "reset" } };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only the external SQL transport is synthetic; ALS and Kysely remain real.
export function syntheticAuthDependencies(owner: string, events: string[]) {
  const tasks: Promise<unknown>[] = [];
  const client = {
    async query(sql: string) {
      events.push(`${owner}:${sql}`);
      await Promise.resolve();
      return { command: "SELECT", rowCount: 1, rows: [{ owner }] };
    },
    release() { events.push(`${owner}:release`); },
  } as unknown as PostgresPoolClient;
  const pool: PostgresPool = {
    options: { syntheticOwner: owner },
    async connect() { events.push(`${owner}:connect`); return client; },
    async end() { events.push(`${owner}:end`); },
  };
  const emailService: AuthEmailService = {
    async sendVerification() { events.push(`${owner}:verification`); },
    async sendPasswordReset() { events.push(`${owner}:reset`); },
  };
  return { pool, emailService, runInBackground(task: Promise<unknown>) { tasks.push(task); }, tasks };
}

// Simulated PostgreSQL introspection only; the default Better Auth engine,
// schema validation, Kysely dialect and signed-cookie handling are unchanged.
export function syntheticSchemaAuthDependencies(owner: string, events: string[], missingSchema = false) {
  const dep = syntheticAuthDependencies(owner, events);
  const definitions = getSchema(createBetterAuthOptions(syntheticAuthConfig(), dep));
  const metadata = Object.entries(definitions).flatMap(([table, definition]) =>
    ["id", ...Object.keys(definition.fields)].map(column => ({
      column, table, schema: "better_auth", table_type: "r", type: "text", type_schema: "pg_catalog",
      not_null: false, has_default: false, auto_incrementing: null, column_description: null,
    })));
  dep.pool.connect = async () => {
    events.push(`${owner}:connect`);
    return {
      async query(query: string) {
        let rows: unknown[];
        if (query.includes("current_schemas")) { events.push(`${owner}:search-path`); rows = [{ schemas: ["better_auth", "public"] }]; }
        else if (query.includes("pg_catalog\".\"pg_attribute")) { events.push(`${owner}:schema`); rows = missingSchema ? [] : metadata; }
        else if (query.includes('"better_auth"."session"')) { events.push(`${owner}:session`); rows = []; }
        else throw new Error("Unexpected synthetic SQL path");
        return { command: "SELECT", rowCount: rows.length, rows };
      },
      release() { events.push(`${owner}:release`); },
    } as unknown as PostgresPoolClient;
  };
  return dep;
}
