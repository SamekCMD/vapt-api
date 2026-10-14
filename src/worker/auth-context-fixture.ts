import { Kysely, PostgresDialect, sql } from "kysely";
import { createWorkerAuthContext } from "./auth-context.js";
import { deferred, syntheticAuthDependencies, syntheticAuthConfig, syntheticSchemaAuthDependencies } from "./auth-context-test-support.js";
import { createWorkerAuthRuntimeFactory } from "./auth-runtime.js";
import { serializeSignedCookie } from "better-call";

export default {
  async fetch() {
    const bridge = createWorkerAuthContext();
    const events: string[] = [];
    const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: bridge.dependencies.pool }) });
    const owners = ["a", "b"].map(owner => syntheticAuthDependencies(owner, events));
    const results = await Promise.all(owners.map(dep => bridge.run(dep, async () => {
      const result = await db.transaction().execute(async tx => {
        await Promise.resolve();
        return (await sql<{ owner: string }>`select owner`.execute(tx)).rows[0].owner;
      });
      bridge.dependencies.runInBackground(bridge.dependencies.emailService.sendPasswordReset({ to: "synthetic@vapt.test", resetPasswordUrl: "https://vapt.test/reset" }));
      return result;
    })));
    await Promise.all(owners.flatMap(dep => dep.tasks));
    let missing = false;
    try { await bridge.dependencies.pool.connect(); } catch (error) { missing = (error as { code: string }).code === "auth_context_unavailable"; }
    const resume = deferred<void>();
    let late!: Promise<boolean>;
    await bridge.run(owners[0], async () => {
      late = resume.promise.then(async () => {
        try { await bridge.dependencies.pool.connect(); return false; } catch (error) { return (error as { code: string }).code === "auth_context_unavailable"; }
      });
    });
    resume.resolve();
    const expired = await late;
    await db.destroy();
    const authEvents: string[] = [];
    const factory = createWorkerAuthRuntimeFactory();
    const config = syntheticAuthConfig();
    const unknownCookie = (await serializeSignedCookie("__Secure-better-auth.session_token", "unknown-synthetic", config.secret)).split(";")[0];
    const sessions = [];
    for (const [owner, cookie] of [["a", "analytics=synthetic"], ["b", "__Secure-better-auth.session_token=invalid"], ["c", unknownCookie]]) {
      sessions.push(await factory(config, syntheticSchemaAuthDependencies(owner, authEvents), "preview").getSession(new Headers({ cookie })));
    }
    const concurrentEvents: string[] = [];
    const concurrentFactory = createWorkerAuthRuntimeFactory();
    const concurrentSessions = await Promise.all(["p", "q"].map(owner =>
      concurrentFactory(config, syntheticSchemaAuthDependencies(owner, concurrentEvents), "preview").getSession(new Headers({ cookie: unknownCookie }))));
    let badSchema = false;
    try {
      await createWorkerAuthRuntimeFactory()(config, syntheticSchemaAuthDependencies("bad", [], true), "preview").getSession(new Headers());
    } catch (error) { badSchema = (error as { code: string }).code === "SCHEMA_MISMATCH"; }
    // Test-worker-only console capture: real default engine + synthetic SQL.
    // This never enters the production bundle or inspects real credentials.
    const loggingFailures: { path: string; failed: boolean; entries: unknown[][] }[] = [];
    for (const path of ["handler", "getSession"] as const) {
      const dep = syntheticSchemaAuthDependencies("logging", []);
      const connect = dep.pool.connect.bind(dep.pool);
      dep.pool.connect = async () => {
        const client = await connect(), query = client.query.bind(client);
        client.query = (async (sql: string, parameters: readonly unknown[]) => {
          if (sql.includes('"better_auth"."session"')) throw new Error("synthetic-private@example.invalid token=synthetic-private-cookie password=synthetic-private-password");
          return query(sql, parameters);
        }) as typeof client.query;
        return client;
      };
      const entries: unknown[][] = [];
      const original = { error: console.error, warn: console.warn, log: console.log };
      console.error = console.warn = console.log = (...args: unknown[]) => { entries.push(args); };
      let failed = false;
      try {
        const runtime = createWorkerAuthRuntimeFactory()(config, dep, "production");
        const headers = new Headers({ cookie: unknownCookie, origin: "https://app.vapt.test", "cf-connecting-ip": "203.0.113.61" });
        if (path === "handler") {
          failed = (await runtime.handler(new Request("https://api.vapt.test/api/auth/get-session?token=synthetic-private-query", { headers }))).status === 500;
        } else {
          try { await runtime.getSession(headers); } catch { failed = true; }
        }
      } finally { Object.assign(console, original); }
      loggingFailures.push({ path, failed, entries });
    }
    return Response.json({ results, events, missing, expired, taskCounts: owners.map(dep => dep.tasks.length), sessions, authEvents, badSchema, concurrentEvents, concurrentSessions, loggingFailures });
  },
};
