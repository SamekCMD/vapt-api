import type { PaymentEffectRecord } from "./repository.js";

export type ClaimPaymentEffectsInput = {
  workerId: string;
  limit: number;
  lockedAt: string;
  lockedUntil: string;
};

export type CompletePaymentEffectInput = {
  effectId: string;
  workerId: string;
  processedAt: string;
};

export type FailPaymentEffectInput = {
  effectId: string;
  workerId: string;
  status: "failed" | "dead_letter";
  attempts: number;
  availableAt: string;
  lastError: string;
};

export interface PaymentEffectProcessorRepository {
  claimEffects(input: ClaimPaymentEffectsInput): Promise<PaymentEffectRecord[]>;
  completeEffect(input: CompletePaymentEffectInput): Promise<void>;
  failEffect(input: FailPaymentEffectInput): Promise<void>;
  releaseOrderToProduction(input: {
    paymentTransactionId: string;
    restaurantId: string;
  }): Promise<void>;
  countPendingEffects(): Promise<number>;
}

export type PaymentEffectBatchResult = {
  claimed: number;
  completed: number;
  failed: number;
  deadLettered: number;
};

export type PaymentEffectProcessor = {
  processBatch(limit: number): Promise<PaymentEffectBatchResult>;
  countPending(): Promise<number>;
};

type CreatePaymentEffectProcessorInput = {
  repository: PaymentEffectProcessorRepository;
  workerId: string;
  maxAttempts: number;
  leaseMs: number;
  baseRetryDelayMs: number;
  now?: () => Date;
};

class UnsupportedPaymentEffectError extends Error {
  constructor(effectType: string) {
    super(`Unsupported payment effect: ${effectType}`);
    this.name = "UnsupportedPaymentEffectError";
  }
}

export function orderStatusAfterPayment(currentStatus: string): string {
  return currentStatus === "waiting_payment" ? "paid" : currentStatus;
}

function retryDelayMs(baseRetryDelayMs: number, attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 8));
  return baseRetryDelayMs * (2 ** exponent);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Unknown payment effect failure";
}

async function executeEffect(
  repository: PaymentEffectProcessorRepository,
  effect: PaymentEffectRecord,
): Promise<void> {
  if (effect.effectType === "release_order_to_kitchen") {
    await repository.releaseOrderToProduction({
      paymentTransactionId: effect.paymentTransactionId,
      restaurantId: effect.restaurantId,
    });
    return;
  }

  throw new UnsupportedPaymentEffectError(effect.effectType);
}

export function createPaymentEffectProcessor({
  repository,
  workerId,
  maxAttempts,
  leaseMs,
  baseRetryDelayMs,
  now = () => new Date(),
}: CreatePaymentEffectProcessorInput): PaymentEffectProcessor {
  return {
    async processBatch(limit) {
      const claimedAt = now();
      const effects = await repository.claimEffects({
        workerId,
        limit,
        lockedAt: claimedAt.toISOString(),
        lockedUntil: new Date(claimedAt.getTime() + leaseMs).toISOString(),
      });
      const result: PaymentEffectBatchResult = {
        claimed: effects.length,
        completed: 0,
        failed: 0,
        deadLettered: 0,
      };

      for (const effect of effects) {
        try {
          await executeEffect(repository, effect);
          await repository.completeEffect({
            effectId: effect.id,
            workerId,
            processedAt: now().toISOString(),
          });
          result.completed += 1;
        } catch (error) {
          const attempts = effect.attempts + 1;
          const deadLetter = attempts >= maxAttempts || error instanceof UnsupportedPaymentEffectError;
          const failedAt = now();
          await repository.failEffect({
            effectId: effect.id,
            workerId,
            status: deadLetter ? "dead_letter" : "failed",
            attempts,
            availableAt: new Date(
              failedAt.getTime() + retryDelayMs(baseRetryDelayMs, attempts),
            ).toISOString(),
            lastError: errorMessage(error),
          });
          if (deadLetter) result.deadLettered += 1;
          else result.failed += 1;
        }
      }

      return result;
    },

    countPending() {
      return repository.countPendingEffects();
    },
  };
}
