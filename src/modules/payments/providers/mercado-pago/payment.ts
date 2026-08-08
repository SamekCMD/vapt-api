import { AppError } from "../../../../lib/errors.js";
import type { PaymentProvider } from "../../provider.js";
import type { MercadoPagoCheckoutClient } from "./client.js";

export type MercadoPagoAccessTokenResolver = (input: {
  providerAccountId: string;
  restaurantId: string;
}) => Promise<string>;

export function createMercadoPagoPaymentProvider(input: {
  client: MercadoPagoCheckoutClient;
  resolveAccessToken: MercadoPagoAccessTokenResolver;
  notificationUrl: URL;
  now?: () => string;
}): PaymentProvider {
  const now = input.now ?? (() => new Date().toISOString());

  return {
    code: "mercado_pago",

    getCapabilities() {
      return {
        onlineCheckout: true,
        webhooks: false,
        cancellation: false,
        fullRefunds: false,
        partialRefunds: false,
        oauthConnection: true,
      };
    },

    async createPayment(payment) {
      if (!payment.providerAccountId) {
        throw new AppError(
          409,
          "payment_account_unavailable",
          "An active Mercado Pago account is required",
        );
      }
      if (!payment.returnUrls) {
        throw new AppError(
          500,
          "payment_configuration_error",
          "Checkout return URLs are not configured",
        );
      }

      const accessToken = await input.resolveAccessToken({
        providerAccountId: payment.providerAccountId,
        restaurantId: payment.restaurantId,
      });
      const preference = await input.client.createPreference({
        accessToken,
        transactionId: payment.transactionId,
        restaurantId: payment.restaurantId,
        orderId: payment.orderId,
        amount: payment.amount,
        description: payment.description,
        returnUrls: payment.returnUrls,
        notificationUrl: input.notificationUrl,
      });

      return {
        transactionId: payment.transactionId,
        provider: "mercado_pago",
        status: "pending",
        amount: payment.amount,
        paymentMethod: null,
        externalPaymentId: null,
        providerStatus: "preference_created",
        occurredAt: now(),
        metadata: { preferenceId: preference.preferenceId },
        checkoutUrl: preference.checkoutUrl,
        expiresAt: null,
      };
    },

    async getPaymentStatus() {
      throw new AppError(
        405,
        "unsupported_operation",
        "Mercado Pago status synchronization is not available yet",
      );
    },
  };
}
