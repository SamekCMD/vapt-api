import assert from "node:assert/strict";
import test from "node:test";

import {
  createPaymentEffectProcessor,
  orderStatusAfterPayment,
  type PaymentEffectProcessorRepository,
} from "./effects.js";
import type { PaymentEffectRecord } from "./repository.js";

const EFFECT: PaymentEffectRecord = {
  id: "effect-1",
  restaurantId: "restaurant-1",
  paymentTransactionId: "transaction-1",
  effectType: "release_order_to_kitchen",
  status: "pending",
  payload: {},
  attempts: 0,
  availableAt: "2026-08-01T12:00:00.000Z",
  lockedUntil: null,
};

function repositoryStub(
  overrides: Partial<PaymentEffectProcessorRepository> = {},
): PaymentEffectProcessorRepository {
  return {
    claimEffects: async () => [],
    completeEffect: async () => undefined,
    failEffect: async () => undefined,
    releaseOrderToProduction: async () => undefined,
    countPendingEffects: async () => 0,
    ...overrides,
  };
}

test("a failed effect remains retryable and completes once after recovery", async () => {
  let claim = 0;
  let releaseAttempts = 0;
  const failures: Array<{ status: string; attempts: number; availableAt: string }> = [];
  const completed: string[] = [];
  const repository = repositoryStub({
    claimEffects: async () => {
      claim += 1;
      if (claim === 1) return [EFFECT];
      if (claim === 2) return [{ ...EFFECT, status: "failed", attempts: 1 }];
      return [];
    },
    releaseOrderToProduction: async () => {
      releaseAttempts += 1;
      if (releaseAttempts === 1) throw new Error("temporary database failure");
    },
    failEffect: async (input) => {
      failures.push({
        status: input.status,
        attempts: input.attempts,
        availableAt: input.availableAt,
      });
    },
    completeEffect: async ({ effectId }) => {
      completed.push(effectId);
    },
  });
  const processor = createPaymentEffectProcessor({
    repository,
    workerId: "worker-a",
    maxAttempts: 4,
    leaseMs: 30_000,
    baseRetryDelayMs: 1_000,
    now: () => new Date("2026-08-01T12:00:00.000Z"),
  });

  const first = await processor.processBatch(10);
  const second = await processor.processBatch(10);

  assert.deepEqual(first, { claimed: 1, completed: 0, failed: 1, deadLettered: 0 });
  assert.deepEqual(second, { claimed: 1, completed: 1, failed: 0, deadLettered: 0 });
  assert.deepEqual(failures, [{
    status: "failed",
    attempts: 1,
    availableAt: "2026-08-01T12:00:01.000Z",
  }]);
  assert.deepEqual(completed, [EFFECT.id]);
  assert.equal(releaseAttempts, 2);
});

test("two concurrent workers cannot execute the same claimed effect", async () => {
  let claimed = false;
  let executions = 0;
  const completed: string[] = [];
  const repository = repositoryStub({
    claimEffects: async () => {
      if (claimed) return [];
      claimed = true;
      await new Promise((resolve) => setImmediate(resolve));
      return [EFFECT];
    },
    releaseOrderToProduction: async () => {
      executions += 1;
    },
    completeEffect: async ({ effectId }) => {
      completed.push(effectId);
    },
  });
  const common = {
    repository,
    maxAttempts: 4,
    leaseMs: 30_000,
    baseRetryDelayMs: 1_000,
    now: () => new Date("2026-08-01T12:00:00.000Z"),
  };
  const workerA = createPaymentEffectProcessor({ ...common, workerId: "worker-a" });
  const workerB = createPaymentEffectProcessor({ ...common, workerId: "worker-b" });

  const results = await Promise.all([
    workerA.processBatch(10),
    workerB.processBatch(10),
  ]);

  assert.equal(results.reduce((sum, result) => sum + result.claimed, 0), 1);
  assert.equal(executions, 1);
  assert.deepEqual(completed, [EFFECT.id]);
});

test("release after payment only advances orders waiting for payment", () => {
  assert.equal(orderStatusAfterPayment("waiting_payment"), "paid");
  for (const status of ["pending", "paid", "preparing", "ready", "delivered"]) {
    assert.equal(orderStatusAfterPayment(status), status);
  }
});

test("an unsupported effect reaches dead letter without being reported as completed", async () => {
  const failed: Array<{ status: string; attempts: number }> = [];
  let completed = false;
  const repository = repositoryStub({
    claimEffects: async () => [{
      ...EFFECT,
      effectType: "notify_order_paid",
      attempts: 3,
    }],
    failEffect: async (input) => {
      failed.push({ status: input.status, attempts: input.attempts });
    },
    completeEffect: async () => {
      completed = true;
    },
  });
  const processor = createPaymentEffectProcessor({
    repository,
    workerId: "worker-a",
    maxAttempts: 4,
    leaseMs: 30_000,
    baseRetryDelayMs: 1_000,
    now: () => new Date("2026-08-01T12:00:00.000Z"),
  });

  const result = await processor.processBatch(10);

  assert.deepEqual(result, { claimed: 1, completed: 0, failed: 0, deadLettered: 1 });
  assert.deepEqual(failed, [{ status: "dead_letter", attempts: 4 }]);
  assert.equal(completed, false);
});
