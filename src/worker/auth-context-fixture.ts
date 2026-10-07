import { Kysely, PostgresDialect, sql } from "kysely";
import { createWorkerAuthContext } from "./auth-context.js";
import { deferred, syntheticAuthDependencies } from "./auth-context-test-support.js";

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
    return Response.json({ results, events, missing, expired, taskCounts: owners.map(dep => dep.tasks.length) });
  },
};
