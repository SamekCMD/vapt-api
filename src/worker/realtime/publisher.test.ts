import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerBindings } from "../environment.js";
import { createWorkerRealtimePublisher } from "./publisher.js";

const change = { restaurantId: "11111111-1111-4111-8111-111111111111", topics: ["orders"],
  orderIds: ["22222222-2222-4222-8222-222222222222"], entityId: "22222222-2222-4222-8222-222222222222", reason: "updated" } as const;
async function publisher(env: WorkerBindings, failure: (code: string) => void) {
  return createWorkerRealtimePublisher(env, failure);
}
function bindings(publish: (change: unknown) => Promise<unknown>, names: string[] = []): WorkerBindings {
  return { ENVIRONMENT: "preview", REALTIME_ENABLED: "true", RESTAURANT_REALTIME: {
    getByName(name: string) { names.push(name); return { publish }; },
  } } as unknown as WorkerBindings;
}
test("disabled publisher never resolves rooms and absent binding cannot break committed writes", async () => {
  let called = 0;
  const env = bindings(async () => { called++; });
  for (const flag of [undefined, "false", "TRUE"]) {
    await (await publisher({ ...env, REALTIME_ENABLED: flag }, () => { called++; }))(change);
  }
  assert.equal(called, 0);
  const failures: string[] = [];
  await assert.doesNotReject((await publisher({ ENVIRONMENT: "preview", REALTIME_ENABLED: "true" }, code => failures.push(code)))(change));
  assert.deepEqual(failures, ["realtime_publish_failed"]);
});
test("publisher addresses authoritative restaurant and forwards only committed change", async () => {
  const names: string[] = [];
  const observed: unknown[] = [];
  const publish = await publisher(bindings(async value => { observed.push(value); return { delivered: 1 }; }, names), () => assert.fail());
  await publish(change);
  assert.deepEqual(names, [change.restaurantId]);
  assert.deepEqual(observed, [change]);
});
test("transport exceptions are sanitized and even a failing observer cannot abort business writes", async () => {
  const failures: string[] = [];
  const publish = await publisher(bindings(async () => { throw new Error("private-transport-sentinel"); }), code => {
    failures.push(code); throw new Error("observer failed");
  });
  await assert.doesNotReject(publish(change));
  assert.deepEqual(failures, ["realtime_publish_failed"]);
});
test("publisher stops waiting after two seconds on a stalled room", { timeout: 5000 }, async () => {
  const failures: string[] = [];
  const publish = await publisher(bindings(() => new Promise(() => {})), code => failures.push(code));
  const start = Date.now();
  await publish(change);
  assert.ok(Date.now() - start >= 1900);
  assert.ok(Date.now() - start < 3000);
  assert.deepEqual(failures, ["realtime_publish_failed"]);
});
