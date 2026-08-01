import assert from "node:assert/strict";
import test from "node:test";

import type {
  PaymentEffectBatchResult,
  PaymentEffectProcessor,
} from "./effects.js";
import { createPaymentEffectReconciliation } from "./reconciliation.js";

const EMPTY_BATCH: PaymentEffectBatchResult = {
  claimed: 0,
  completed: 0,
  failed: 0,
  deadLettered: 0,
};

test("reconciliation coalesces concurrent runs in one API instance", async () => {
  let releaseBatch!: () => void;
  let processCalls = 0;
  const gate = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  const processor: PaymentEffectProcessor = {
    async processBatch() {
      processCalls += 1;
      await gate;
      return { ...EMPTY_BATCH, claimed: 1, completed: 1 };
    },
    async countPending() {
      return 2;
    },
  };
  const reconciliation = createPaymentEffectReconciliation({
    processor,
    batchSize: 25,
    pollIntervalMs: 5_000,
  });

  const first = reconciliation.runOnce();
  const second = reconciliation.runOnce();
  releaseBatch();

  assert.deepEqual(await first, await second);
  assert.equal(processCalls, 1);
  const snapshot = reconciliation.snapshot();
  assert.equal(snapshot.pending, 2);
  assert.equal(typeof snapshot.lastRunAt, "string");
  assert.equal(snapshot.lastError, null);
});

test("reconciliation records a failure and recovers on the next run", async () => {
  let shouldFail = true;
  const processor: PaymentEffectProcessor = {
    async processBatch() {
      if (shouldFail) throw new Error("temporary database failure");
      return EMPTY_BATCH;
    },
    async countPending() {
      return 0;
    },
  };
  const reconciliation = createPaymentEffectReconciliation({
    processor,
    batchSize: 25,
    pollIntervalMs: 5_000,
  });

  await assert.rejects(reconciliation.runOnce(), /temporary database failure/);
  assert.equal(reconciliation.snapshot().lastError, "temporary database failure");

  shouldFail = false;
  await reconciliation.runOnce();
  const recovered = reconciliation.snapshot();
  assert.equal(recovered.pending, 0);
  assert.equal(typeof recovered.lastRunAt, "string");
  assert.equal(recovered.lastError, null);
});
