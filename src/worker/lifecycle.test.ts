import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerLifecycle } from "./lifecycle.js";

test("Worker lifecycle generates a UUID-based payment identity", () => {
  const lifecycle = createWorkerLifecycle(() => undefined);
  assert.match(lifecycle.workerId, /^payment-effects-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.doesNotMatch(lifecycle.workerId, new RegExp(`^payment-effects-${process.pid}-`));
});

test("Worker auth email failure is waited on and logged only as a safe code", async () => {
  const tasks: Promise<unknown>[] = [];
  const codes: string[] = [];
  const lifecycle = createWorkerLifecycle((code) => { codes.push(code); });
  await lifecycle.withWaitUntil((task) => { tasks.push(task); }, async () => {
    lifecycle.runInBackground(Promise.reject(new Error("private-recipient-and-secret")));
  });
  assert.equal(tasks.length, 1);
  await Promise.all(tasks);
  assert.deepEqual(codes, ["auth_email_failed"]);
});

test("concurrent requests keep background work on their own waitUntil context", async () => {
  const firstTasks: Promise<unknown>[] = [];
  const secondTasks: Promise<unknown>[] = [];
  const lifecycle = createWorkerLifecycle(() => undefined);
  await Promise.all([
    lifecycle.withWaitUntil((task) => { firstTasks.push(task); }, async () => {
      await Promise.resolve();
      lifecycle.runInBackground(Promise.resolve("first"));
    }),
    lifecycle.withWaitUntil((task) => { secondTasks.push(task); }, async () => {
      await Promise.resolve();
      lifecycle.runInBackground(Promise.resolve("second"));
    }),
  ]);
  assert.deepEqual(await Promise.all(firstTasks), ["first"]);
  assert.deepEqual(await Promise.all(secondTasks), ["second"]);
});
