import type {
  PaymentEffectBatchResult,
  PaymentEffectProcessor,
} from "./effects.js";

export type PaymentEffectHealth = {
  pending: number | null;
  lastRunAt: string | null;
  lastError: string | null;
};

export type PaymentEffectReconciliationResult = PaymentEffectBatchResult & {
  pending: number;
};

export type PaymentEffectReconciliation = {
  runOnce(limit?: number): Promise<PaymentEffectReconciliationResult>;
  start(): void;
  stop(): void;
  snapshot(): PaymentEffectHealth;
};

type CreatePaymentEffectReconciliationInput = {
  processor: PaymentEffectProcessor;
  batchSize: number;
  pollIntervalMs: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Unknown payment reconciliation failure";
}

export function createPaymentEffectReconciliation({
  processor,
  batchSize,
  pollIntervalMs,
  now = () => new Date(),
  onError = () => undefined,
}: CreatePaymentEffectReconciliationInput): PaymentEffectReconciliation {
  let activeRun: Promise<PaymentEffectReconciliationResult> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let health: PaymentEffectHealth = {
    pending: null,
    lastRunAt: null,
    lastError: null,
  };

  const run = async (limit: number): Promise<PaymentEffectReconciliationResult> => {
    try {
      const batch = await processor.processBatch(limit);
      const pending = await processor.countPending();
      health = {
        pending,
        lastRunAt: now().toISOString(),
        lastError: null,
      };
      return { ...batch, pending };
    } catch (error) {
      health = {
        ...health,
        lastRunAt: now().toISOString(),
        lastError: safeErrorMessage(error),
      };
      throw error;
    }
  };

  const reconciliation: PaymentEffectReconciliation = {
    runOnce(limit = batchSize) {
      if (activeRun) return activeRun;

      const boundedLimit = Math.max(1, Math.min(limit, 100));
      activeRun = run(boundedLimit).finally(() => {
        activeRun = null;
      });
      return activeRun;
    },

    start() {
      if (timer) return;

      const tick = () => {
        void reconciliation.runOnce().catch(onError);
      };
      tick();
      timer = setInterval(tick, pollIntervalMs);
      timer.unref();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    snapshot() {
      return { ...health };
    },
  };

  return reconciliation;
}
