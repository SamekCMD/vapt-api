import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { BackgroundTaskRunner } from "../modules/auth/runtime.js";

type WaitUntil = (task: Promise<unknown>) => void;

export function createWorkerLifecycle(onError: (code: "auth_email_failed") => void): {
  workerId: string;
  runInBackground: BackgroundTaskRunner;
  withWaitUntil<T>(waitUntil: WaitUntil, work: () => Promise<T>): Promise<T>;
} {
  const invocation = new AsyncLocalStorage<WaitUntil>();
  return {
    workerId: `payment-effects-${randomUUID()}`,
    runInBackground(task) {
      const waitUntil = invocation.getStore();
      const observed = task.catch(() => {
        onError("auth_email_failed");
      });
      if (!waitUntil) {
        void observed;
        throw new Error("Worker background task has no invocation context");
      }
      waitUntil(observed);
    },
    withWaitUntil(waitUntil, work) {
      return invocation.run(waitUntil, work);
    },
  };
}
