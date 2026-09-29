import type { AppConfig } from "../../lib/config.js";
import type { Queryable } from "../../lib/database.js";
import { createPaymentEffectProcessor } from "./effects.js";
import type { PaymentProvider } from "./provider.js";
import { createPaymentEffectReconciliation } from "./reconciliation.js";
import { createPaymentRepository } from "./repository.js";
import { createPaymentProviderRegistry } from "./registry.js";
import { createPaymentService, type PaymentModule } from "./service.js";

export function createPaymentModule(
  config: AppConfig,
  database: Queryable,
  providers: readonly PaymentProvider[],
  options: { workerId: string; onError(error: unknown): void },
): PaymentModule {
  const registry = createPaymentProviderRegistry(providers);
  const repository = createPaymentRepository(database);
  const service = createPaymentService(registry, repository);
  const effectsConfig = config.paymentEffects ?? {
    pollIntervalMs: 5_000,
    batchSize: 25,
    leaseMs: 60_000,
    maxAttempts: 5,
    retryBaseMs: 30_000,
  };
  const effects = createPaymentEffectProcessor({
    repository,
    workerId: options.workerId,
    maxAttempts: effectsConfig.maxAttempts,
    leaseMs: effectsConfig.leaseMs,
    baseRetryDelayMs: effectsConfig.retryBaseMs,
  });
  const reconciliation = createPaymentEffectReconciliation({
    processor: effects,
    batchSize: effectsConfig.batchSize,
    pollIntervalMs: effectsConfig.pollIntervalMs,
    onError: options.onError,
  });
  return { registry, repository, service, effects, reconciliation };
}
