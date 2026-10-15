import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createWorkerAuthRuntimeFactory } from "./auth-runtime.js";
import { deferred, syntheticAuthConfig, syntheticAuthDependencies } from "./auth-context-test-support.js";

test("late descendant promises cannot retain or reuse the completed invocation dependencies", async () => {
  assert.equal(typeof global.gc, "function", "run this regression with node --expose-gc --test-isolation=none --import tsx --test");
  const lateGate = deferred<void>();
  let lateWork!: Promise<unknown>;
  const factory = createWorkerAuthRuntimeFactory({ createEngine: (_config, bridge) => {
    // Deliberately keep a descendant alive after the operation has returned.
    lateWork = lateGate.promise.then(() => bridge.pool.connect());
    return { ready: Promise.resolve(), runtime: { async handler() { return new Response(); }, async getSession() { return null; }, async close() {} } };
  } });
  async function firstInvocation() {
    const dep = syntheticAuthDependencies("first", []);
    const weak = [new WeakRef(dep.pool), new WeakRef(dep.emailService), new WeakRef(dep.runInBackground)];
    await factory(syntheticAuthConfig(), dep, "preview").getSession(new Headers());
    return weak;
  }
  const weak = await firstInvocation();
  // Each turn drops WeakRef's per-job keep-alive before forcing another collection.
  for (let attempt = 0; attempt < 20; attempt++) {
    await setImmediate(); global.gc!();
  }
  const retained = weak.map(reference => reference.deref() !== undefined);
  const denied = assert.rejects(lateWork, { code: "auth_context_unavailable" });
  lateGate.resolve(); await denied;
  assert.deepEqual(retained, [false, false, false]);
  // The engine itself remains cached and operational after collection.
  assert.equal(await factory(syntheticAuthConfig(), syntheticAuthDependencies("next", []), "preview").getSession(new Headers()), null);
});
