import { createHmac, randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import type { Pool } from "pg";

import type { AuthEmailService } from "../email/types.js";
import type { ApiServices } from "../composition/api-services.js";
import type { AppConfig, BetterAuthConfig } from "../lib/config.js";
import { withTransaction } from "../lib/database.js";
import { createBetterAuthRuntime } from "../modules/auth/better-auth.js";
import { createPaymentModule } from "../modules/payments/composition.js";
import type { ProbeBindings } from "./hyperdrive-probe.js";
import { runScheduledReconciliation } from "./scheduled.js";

const insertVerification = 'INSERT INTO better_auth."verification" ("identifier", "value", "expiresAt") VALUES ($1, $2, now() + interval \'5 minutes\')';
const countVerification = 'SELECT count(*)::integer AS count FROM better_auth."verification" WHERE "identifier" = $1';
const deleteVerification = 'DELETE FROM better_auth."verification" WHERE "identifier" = $1';

export type ProbeOperationDependencies = {
  createAuthRuntime?: typeof createBetterAuthRuntime;
  createReconciliationServices?: (database: Pool) => ApiServices;
};

const defaultDependencies: ProbeOperationDependencies = {};

const forbiddenEmail: AuthEmailService = {
  async sendVerification() { throw new Error("Diagnostic email is forbidden"); },
  async sendPasswordReset() { throw new Error("Diagnostic email is forbidden"); },
};

function syntheticAuth(env: ProbeBindings) {
  if (!env.PROBE_TOKEN) throw new Error("Missing probe token");
  const digest = createHmac("sha256", env.PROBE_TOKEN).update("vapt-stage10-auth").digest("hex");
  return {
    token: `vapt-stage10-${digest}`,
    email: `stage10-${digest.slice(0, 24)}@example.invalid`,
  };
}

function authConfig(secret: string): BetterAuthConfig {
  return {
    secret,
    url: new URL("https://probe.vapt.invalid"),
    trustedOrigins: ["https://probe.vapt.invalid"],
    databaseUrl: "not-used-by-diagnostic",
    turnstileSecretKey: secret,
    email: {
      resendApiKey: "",
      from: "Vapt Probe <noreply@example.invalid>",
      verifyAccountTemplate: "",
      resetPasswordTemplate: "",
    },
  };
}

async function authProbe(
  operation: string,
  database: Pool,
  env: ProbeBindings,
  dependencies: ProbeOperationDependencies,
): Promise<Response> {
  const { token, email } = syntheticAuth(env);
  if (operation === "auth/create") {
    await withTransaction(database, async (client) => {
      const user = await client.query(
        'INSERT INTO better_auth."user" ("name", "email", "emailVerified") VALUES ($1, $2, true) RETURNING id',
        ["Vapt Stage 10 Diagnostic", email],
      );
      await client.query(
        'INSERT INTO better_auth."session" ("expiresAt", "token", "updatedAt", "userId") VALUES (now() + interval \'5 minutes\', $1, now(), $2)',
        [token, user.rows[0]?.id],
      );
    });
    return Response.json({ ok: true, created: true });
  }
  if (operation === "auth/revoke") {
    await withTransaction(database, async (client) => {
      await client.query('DELETE FROM better_auth."session" WHERE "token" = $1', [token]);
      await client.query('DELETE FROM better_auth."user" WHERE "email" = $1', [email]);
    });
    return Response.json({ ok: true, revoked: true });
  }

  const runtime = (dependencies.createAuthRuntime ?? createBetterAuthRuntime)(authConfig(env.PROBE_TOKEN!), {
    pool: database,
    emailService: forbiddenEmail,
    runInBackground() { throw new Error("Diagnostic background task is forbidden"); },
  });
  const signature = await makeSignature(token, env.PROBE_TOKEN!);
  const headers = new Headers({
    cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  });
  const session = await runtime.getSession(headers);
  return Response.json({ ok: true, sessionPresent: session?.user.email === email });
}

function createReconciliationServices(database: Pool): ApiServices {
  const config = {
    paymentEffects: {
      pollIntervalMs: 5000,
      batchSize: 1,
      leaseMs: 30000,
      maxAttempts: 1,
      retryBaseMs: 30000,
    },
  } as AppConfig;
  const payments = createPaymentModule(config, database, [], {
    workerId: "vapt-stage10-reconcile-preview",
    onError() {},
  });
  return { config, payments } as ApiServices;
}

async function reconcileProbe(database: Pool, dependencies: ProbeOperationDependencies): Promise<Response> {
  const pending = Number((await database.query("SELECT public.count_pending_payment_effects() AS count")).rows[0]?.count);
  if (pending !== 0) return Response.json({ ok: false, blocked: true }, { status: 409 });
  const services = (dependencies.createReconciliationServices ?? createReconciliationServices)(database);
  const result = await runScheduledReconciliation(services);
  const ok = result.claimed === 0 && result.pending === 0;
  return Response.json({
    ok,
    ranOnce: true,
    claimed: result.claimed,
    pending: result.pending,
  }, { status: ok ? 200 : 503 });
}

async function transactionProbe(database: Pool): Promise<Response> {
  const rollbackMarker = `vapt-stage10-rollback-${randomUUID()}`;
  const commitMarker = `vapt-stage10-commit-${randomUUID()}`;
  const expectedRollback = new Error("probe rollback");
  let rollbackAbsent = false;
  let committedVisible = false;
  let cleaned = false;
  try {
    try {
      await withTransaction(database, async (client) => {
        await client.query(insertVerification, [rollbackMarker, "synthetic"]);
        throw expectedRollback;
      });
    } catch (error) {
      if (error !== expectedRollback) throw error;
    }
    rollbackAbsent = Number((await database.query(countVerification, [rollbackMarker])).rows[0]?.count) === 0;
    await withTransaction(database, async (client) => {
      await client.query(insertVerification, [commitMarker, "synthetic"]);
    });
    committedVisible = Number((await database.query(countVerification, [commitMarker])).rows[0]?.count) === 1;
  } finally {
    await database.query(deleteVerification, [rollbackMarker]);
    await database.query(deleteVerification, [commitMarker]);
    cleaned = Number((await database.query(countVerification, [commitMarker])).rows[0]?.count) === 0;
  }
  const ok = rollbackAbsent && committedVisible && cleaned;
  return Response.json({ ok, rollbackAbsent, committedVisible, cleaned }, { status: ok ? 200 : 503 });
}

export async function runProbeOperation(
  operation: string,
  database: Pool,
  env: ProbeBindings,
  dependencies: ProbeOperationDependencies = defaultDependencies,
): Promise<Response> {
  if (operation === "identity") {
    const result = await database.query("SELECT current_database() AS database, current_user AS username");
    if (result.rows[0]?.database !== "vapt" || result.rows[0]?.username !== "vapt_api_preview") {
      return Response.json({ ok: false }, { status: 503 });
    }
    return Response.json({ ok: true, database: "vapt", user: "vapt_api_preview" });
  }
  if (operation === "query") {
    const result = await database.query("SELECT $1::text AS marker", ["vapt-stage10"]);
    return Response.json({
      ok: result.rows[0]?.marker === "vapt-stage10",
      parameterized: true,
    });
  }
  if (operation === "transaction") return transactionProbe(database);
  if (operation === "auth/create" || operation === "auth/read" || operation === "auth/revoke") {
    return authProbe(operation, database, env, dependencies);
  }
  if (operation === "reconcile") return reconcileProbe(database, dependencies);
  return Response.json({ ok: false }, { status: 503 });
}
