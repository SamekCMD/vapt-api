import type { ApiServices } from "../composition/api-services.js";
import type { PaymentEffectReconciliationResult } from "../modules/payments/reconciliation.js";

export function runScheduledReconciliation(services: ApiServices): Promise<PaymentEffectReconciliationResult> {
  const configuredBatch = services.config.paymentEffects?.batchSize ?? 25;
  const limit = Math.max(1, Math.min(configuredBatch, 100));
  return services.payments.reconciliation.runOnce(limit);
}
