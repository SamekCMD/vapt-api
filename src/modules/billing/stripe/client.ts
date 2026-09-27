import Stripe from "stripe";

import type { StripeBillingConfig } from "../../../lib/config.js";

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

export function createStripeClient(
  config: StripeBillingConfig,
  options: { fetchImpl?: typeof fetch } = {},
): Stripe {
  return new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(options.fetchImpl),
    maxNetworkRetries: 2,
  });
}

export function constructStripeWebhookEvent(
  client: Pick<Stripe, "webhooks">,
  rawBody: string,
  signatureHeader: string,
  config: Pick<StripeBillingConfig, "webhookSecret" | "webhookToleranceSeconds">,
): Promise<Stripe.Event> {
  return client.webhooks.constructEventAsync(
    rawBody,
    signatureHeader,
    config.webhookSecret,
    config.webhookToleranceSeconds,
    Stripe.createSubtleCryptoProvider(),
  );
}
