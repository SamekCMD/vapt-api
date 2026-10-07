import type { PostgresPool, PostgresPoolClient } from "kysely";
import type { AuthEmailService } from "../email/types.js";

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
