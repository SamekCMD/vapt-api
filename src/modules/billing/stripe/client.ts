import Stripe from "stripe";

import type { StripeBillingConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import type { StripeCheckoutSession, StripeGateway, StripeSubscription } from "./types.js";

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

export function createStripeClient(
  config: StripeBillingConfig,
  options: { fetchImpl?: typeof fetch } = {},
): Stripe {
  return new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(options.fetchImpl),
    maxNetworkRetries: 2,
    timeout: 15_000,
  });
}

// SDK types stay here; domain services never depend on expandable Stripe objects.
export function createStripeGateway(client: Stripe): StripeGateway {
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      // Do not attach the SDK error/cause: it may contain request data or credentials.
      throw new AppError(502, "stripe_unavailable", "Billing provider is temporarily unavailable");
    }
  }
  function customer(value: Stripe.Customer | Stripe.DeletedCustomer) {
    if (value.deleted) throw new AppError(502, "invalid_stripe_response", "Invalid billing provider response");
    return { id: value.id, livemode: value.livemode, metadata: value.metadata };
  }
  function checkout(value: Stripe.Checkout.Session): StripeCheckoutSession {
    if (value.mode !== "subscription") throw new AppError(502, "invalid_stripe_response", "Invalid billing provider response");
    if (value.status !== "open" && value.status !== "complete" && value.status !== "expired") {
      throw new AppError(502, "invalid_stripe_response", "Invalid billing provider response");
    }
    return { id: value.id, livemode: value.livemode, metadata: value.metadata ?? {},
      customerId: resourceId(value.customer), subscriptionId: resourceId(value.subscription),
      status: value.status as StripeCheckoutSession["status"], clientReferenceId: value.client_reference_id, url: value.url,
      expiresAt: new Date(value.expires_at * 1000).toISOString() };
  }
  return {
    findCustomers: (restaurantId) => safe(async () => {
      const literal = restaurantId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const matches = await client.customers.search({
        query: `metadata['vapt_restaurant_id']:'${literal}'`, limit: 2,
      });
      if (matches.has_more) throw new AppError(409, "billing_conflict", "Multiple billing Customers found");
      return matches.data.map(customer);
    }),
    getCustomer: (id) => safe(async () => customer(await client.customers.retrieve(id))),
    createCustomer: (input, idempotencyKey) => safe(async () =>
      customer(await client.customers.create(input, { idempotencyKey }))),
    getCheckout: (id) => safe(async () => checkout(await client.checkout.sessions.retrieve(id))),
    createCheckout: (input, idempotencyKey) => safe(async () => checkout(await client.checkout.sessions.create({
      mode: "subscription", customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl, cancel_url: input.cancelUrl,
      client_reference_id: input.clientReferenceId, metadata: input.metadata,
      subscription_data: { metadata: input.metadata },
    }, { idempotencyKey }))),
    createPortal: (input) => safe(async () => {
      const session = await client.billingPortal.sessions.create({ customer: input.customerId,
        configuration: input.configurationId, return_url: input.returnUrl });
      return { url: session.url, customerId: session.customer, livemode: session.livemode };
    }),
    getSubscription: (id) => safe(async (): Promise<StripeSubscription> => {
      const value = await client.subscriptions.retrieve(id);
      if (value.items.has_more) throw new AppError(502, "invalid_stripe_response", "Invalid billing provider response");
      const status = value.status;
      if (status !== "active" && status !== "trialing" && status !== "past_due" && status !== "incomplete" &&
        status !== "incomplete_expired" && status !== "canceled" && status !== "unpaid" && status !== "paused") {
        throw new AppError(502, "invalid_stripe_response", "Invalid billing provider response");
      }
      return { id: value.id, livemode: value.livemode, metadata: value.metadata,
        customerId: resourceId(value.customer)!, status: status as StripeSubscription["status"],
        items: value.items.data.map(item => ({ id: item.id, priceId: item.price.id,
          recurring: item.price.recurring !== null,
          currentPeriodEnd: new Date(item.current_period_end * 1000).toISOString() })),
        trialEndsAt: value.trial_end === null ? null : new Date(value.trial_end * 1000).toISOString(),
        canceledAt: value.canceled_at === null ? null : new Date(value.canceled_at * 1000).toISOString(),
        cancelAtPeriodEnd: value.cancel_at_period_end ||
          (value.cancel_at !== null && value.items.data.length === 1 &&
            value.cancel_at === value.items.data[0]!.current_period_end) };
    }),
  };
}

function resourceId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
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
