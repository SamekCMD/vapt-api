import { AppError } from "../../../lib/errors.js";
import type { PaymentProvider } from "../provider.js";
import type { PaymentMethod } from "../types.js";

const MANUAL_METHODS = new Set<PaymentMethod>([
  "cash",
  "external_pix",
  "credit_card",
  "debit_card",
  "voucher",
  "other",
]);

export function createManualPaymentProvider(
  now: () => string = () => new Date().toISOString(),
): PaymentProvider {
  return {
    code: "manual",

    getCapabilities() {
      return {
        onlineCheckout: false,
        webhooks: false,
        cancellation: false,
        fullRefunds: false,
        partialRefunds: false,
        oauthConnection: false,
      };
    },

    async createPayment(input) {
      if (!input.paymentMethod || !MANUAL_METHODS.has(input.paymentMethod)) {
        throw new AppError(400, "invalid_payment_method", "Invalid manual payment method");
      }

      return {
        transactionId: input.transactionId,
        provider: "manual",
        status: "paid",
        amount: input.amount,
        paymentMethod: input.paymentMethod,
        externalPaymentId: null,
        providerStatus: "confirmed_by_operator",
        occurredAt: now(),
        metadata: {},
        checkoutUrl: null,
        expiresAt: null,
      };
    },

    async getPaymentStatus() {
      throw new AppError(
        405,
        "unsupported_operation",
        "Manual payments do not have an external status",
      );
    },
  };
}
