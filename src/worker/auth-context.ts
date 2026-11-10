import { AsyncLocalStorage } from "node:async_hooks";
import type { PostgresCursor, PostgresPool, PostgresPoolClient, PostgresQueryResult } from "kysely";
import type { AuthEmailService } from "../email/types.js";
import { AppError } from "../lib/errors.js";
import type { BackgroundTaskRunner } from "../modules/auth/runtime.js";

export type WorkerAuthDependencies = {
  pool: PostgresPool;
  emailService: AuthEmailService;
  runInBackground: BackgroundTaskRunner;
};

type Scope = { dependencies: WorkerAuthDependencies | undefined; live: boolean };

export function createWorkerAuthContext() {
  const invocation = new AsyncLocalStorage<Scope>();
  const unavailable = () => new AppError(503, "auth_context_unavailable", "Service unavailable");
  function current() {
    const scope = invocation.getStore();
    const dependencies = scope?.dependencies;
    if (!scope?.live || !dependencies) throw unavailable();
    return { scope, dependencies };
  }

  const pool: PostgresPool = {
    // Kysely caches this facade, never a real pool or its credentials.
    options: {},
    async connect() {
      const { scope: owner, dependencies } = current();
      const client = await dependencies.pool.connect();
      if (!owner.live || invocation.getStore() !== owner) {
        client.release();
        throw unavailable();
      }
      let released = false;
      function query<R>(sql: string, parameters: readonly unknown[]): Promise<PostgresQueryResult<R>>;
      function query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
      function query<R>(input: string | PostgresCursor<R>, parameters: readonly unknown[] = []): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
        // No cursor/control-client support: neither may escape invocation ownership.
        if (typeof input !== "string") throw unavailable();
        return (async () => {
          if (released || !owner.live || invocation.getStore() !== owner) throw unavailable();
          return client.query<R>(input, parameters);
        })();
      }
      return {
        processID: client.processID,
        query,
        release() {
          if (released) return;
          released = true;
          // Cleanup must always release the original client, even after scope exit.
          client.release();
        },
      } satisfies PostgresPoolClient;
    },
    async end() {}, // Request-owned pools retain their existing lifecycle.
  };

  const dependencies: WorkerAuthDependencies = {
    pool,
    emailService: {
      async sendVerification(input) { return current().dependencies.emailService.sendVerification(input); },
      async sendPasswordReset(input) { return current().dependencies.emailService.sendPasswordReset(input); },
    },
    runInBackground(task) {
      let active: ReturnType<typeof current>;
      try { active = current(); } catch (error) {
        // Do not leave a rejected email promise unobserved when registration fails.
        void task.catch(() => undefined);
        throw error;
      }
      active.dependencies.runInBackground(task);
    },
  };

  return {
    dependencies,
    run<T>(requestDependencies: WorkerAuthDependencies, work: () => Promise<T>): Promise<T> {
      const scope: Scope = { dependencies: requestDependencies, live: true };
      return invocation.run(scope, async () => {
        try { return await work(); } finally {
          scope.live = false;
          // Descendant async resources can outlive this operation. Leave them
          // a closed marker, not its pool, email client or execution context.
          scope.dependencies = undefined;
        }
      });
    },
  };
}
