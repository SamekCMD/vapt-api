import { z } from "zod";
import type { StripeBillingConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import type { StripePlanStatus } from "./repository.js";
import type { StripePlanType } from "./schemas.js";
import { assertStripeMetadata, assertStripeMode, invalidStripeResponse } from "./service.js";
import type { StripeGateway, StripeSubscription } from "./types.js";
import type { BillingEmailKind, StripeWebhookRepository } from "./webhook-repository.js";

const eventSchema = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9]+$/), type: z.string().min(1).max(255),
  created: z.number().int().nonnegative(), livemode: z.boolean(), data: z.object({ object: z.record(z.string(), z.unknown()) }) });
const handledEvents = new Set(["checkout.session.completed", "checkout.session.expired", "invoice.paid",
  "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"]);
export type StripeWebhookResult = { received: boolean; duplicate: boolean; ignored: boolean; providerEventId: string };
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function id(value: unknown): string | null {
  return typeof value === "string" ? value : typeof object(value).id === "string" ? object(value).id as string : null;
}
function metadata(value: unknown): Record<string, string> {
  const source = object(value); const safe: Record<string, string> = {};
  for (const field of ["vapt_restaurant_id", "vapt_owner_id", "vapt_plan_type"]) {
    if (typeof source[field] === "string") safe[field] = source[field];
  }
  return safe;
}
function localStatus(subscription: StripeSubscription): StripePlanStatus {
  if (subscription.status === "canceled") return "cancelled";
  if (subscription.status === "incomplete_expired") return "expired";
  return subscription.status;
}
function emailKind(type: string, reason: unknown, status: StripePlanStatus): BillingEmailKind | null {
  if (type === "customer.subscription.deleted" && status === "cancelled") return "subscription_cancelled";
  if (type === "invoice.payment_failed" && ["past_due", "incomplete", "unpaid", "paused"].includes(status)) return "payment_failed";
  if (type === "invoice.paid" && (status === "active" || status === "trialing")) {
    if (reason === "subscription_create") return "subscription_activated";
    if (reason === "subscription_cycle") return "subscription_renewed";
  }
  return null;
}
export function createStripeWebhookService(config: StripeBillingConfig, repository: StripeWebhookRepository,
  gateway: StripeGateway, options: { now?: () => Date; logger?: { info(fields: Record<string, unknown>, message?: string): void } } = {}) {
  const now = options.now ?? (() => new Date());
  return {
    async handleEvent(value: unknown): Promise<StripeWebhookResult> {
      const parsed = eventSchema.safeParse(value);
      if (!parsed.success || parsed.data.livemode !== (config.environment === "live")) {
        throw new AppError(400, "invalid_webhook_event", "Invalid billing event");
      }
      const event = parsed.data; const resource = event.data.object;
      const invoice = event.type.startsWith("invoice."); const checkout = event.type.startsWith("checkout.");
      const details = object(object(resource.parent).subscription_details);
      const meta = metadata(invoice ? details.metadata : resource.metadata);
      const customerId = id(resource.customer);
      const subscriptionId = invoice ? id(details.subscription) : checkout ? id(resource.subscription) : id(resource.id);
      const resourceId = id(resource.id);
      const fields: Record<string, unknown> = { stripeEventId: event.id, eventType: event.type };
      const response = (duplicate: boolean, ignored: boolean): StripeWebhookResult =>
        ({ received: true, duplicate, ignored, providerEventId: event.id });
      let claim;
      try {
        claim = await repository.claimEvent({ providerEventId: event.id, eventType: event.type,
          payload: { id: event.id, type: event.type, created: event.created, livemode: event.livemode,
            resourceId, customerId, subscriptionId, metadata: meta } });
      } catch {
        options.logger?.info({ ...fields, outcome: "pending_retry" }, "Stripe billing event");
        throw new AppError(500, "billing_processing_failed", "Billing event will be retried");
      }
      if (claim.kind === "in_flight") {
        options.logger?.info({ ...fields, outcome: "in_flight" }, "Stripe billing event");
        throw new AppError(503, "billing_processing_pending", "Billing event will be retried");
      }
      if (claim.kind !== "claimed") {
        options.logger?.info({ ...fields, outcome: claim.kind }, "Stripe billing event");
        return response(true, false);
      }
      const token = { providerEventId: event.id, attemptCount: claim.attemptCount };
      let ignored = true;
      try {
        const supported = handledEvents.has(event.type);
        const hasReferences = Boolean(customerId && resourceId && (subscriptionId || event.type === "checkout.session.expired"));
        if (supported && hasReferences) {
          if ((checkout && (resource.object !== "checkout.session" || resource.mode !== "subscription")) ||
            (invoice && resource.object !== "invoice") || (!checkout && !invoice && resource.object !== "subscription")) invalidStripeResponse();
        }
        await repository.withClaimedEvent(token, async transaction => {
          if (!supported || !hasReferences) return "ignored";
          const scope = await repository.resolveRestaurant(transaction, { subscriptionId, customerId,
            restaurantId: meta.vapt_restaurant_id ?? null });
          if (!scope) return "ignored";
          fields.restaurantId = scope.restaurantId;
          if (scope.stripeCustomerId !== null && scope.stripeCustomerId !== customerId) invalidStripeResponse();
          if (!invoice || meta.vapt_restaurant_id !== undefined || meta.vapt_owner_id !== undefined) assertStripeMetadata(meta, scope);
          if (checkout && resource.client_reference_id !== scope.restaurantId) invalidStripeResponse();
          if (event.type === "checkout.session.expired") {
            ignored = !await repository.clearPendingCheckout(transaction, scope, resourceId!);
            return ignored ? "ignored" : "processed";
          }
          if (!subscriptionId) invalidStripeResponse();
          // Query current state under this tenant's row lock: retrieval and writes are ordered across events.
          // event.created is not a state version and must not be used to activate an old snapshot.
          const observedAt = now().toISOString();
          const canonical = await gateway.getSubscription(subscriptionId);
          assertStripeMode(canonical.livemode, config.environment);
          if (canonical.id !== subscriptionId || canonical.customerId !== customerId) invalidStripeResponse();
          assertStripeMetadata(canonical.metadata, scope);
          if (scope.stripeSubscriptionId !== null && scope.stripeSubscriptionId !== canonical.id) {
            // A newer subscription owns this Customer. Never let an old delayed event rebind it.
            const replacement = event.type === "checkout.session.completed" && scope.checkoutSessionId === resourceId;
            if (!replacement) {
              if (event.type === "customer.subscription.deleted") return "ignored";
              throw new AppError(409, "billing_association_conflict", "Subscription association conflicts");
            }
            const previous = await gateway.getSubscription(scope.stripeSubscriptionId);
            assertStripeMode(previous.livemode, config.environment);
            assertStripeMetadata(previous.metadata, scope);
            if (previous.id !== scope.stripeSubscriptionId || previous.customerId !== canonical.customerId ||
              !["canceled", "incomplete_expired"].includes(previous.status)) invalidStripeResponse();
          }
          if (canonical.items.length !== 1) invalidStripeResponse();
          const item = canonical.items[0]!;
          const plans = (Object.entries(config.prices) as Array<[StripePlanType, string]>).filter(([, price]) => price === item.priceId);
          if (!item.recurring || !item.id || plans.length !== 1 || !Number.isFinite(Date.parse(item.currentPeriodEnd))) invalidStripeResponse();
          const status = localStatus(canonical);
          if (event.type === "customer.subscription.deleted" && status !== "cancelled") invalidStripeResponse();
          const planType = plans[0]![0];
          const changed = await repository.applySubscription(transaction, scope, {
            customerId: canonical.customerId, subscriptionId: canonical.id, subscriptionItemId: item.id,
            planType, planStatus: status, trialEndsAt: canonical.trialEndsAt, currentPeriodEnd: item.currentPeriodEnd,
            cancelAtPeriodEnd: canonical.cancelAtPeriodEnd, subscriptionCanceledAt: canonical.canceledAt,
            observedAt, checkoutSessionId: event.type === "checkout.session.completed" ? resourceId : null,
            billingLastError: ["past_due", "incomplete", "unpaid", "paused"].includes(status) ? "payment_required" : null,
          });
          if (!changed) return "ignored";
          const kind = emailKind(event.type, resource.billing_reason, status);
          if (kind) await repository.enqueueEmail(transaction, { restaurantId: scope.restaurantId,
            providerEventId: event.id, billingResourceId: resourceId!, emailKind: kind,
            payload: { planType, planStatus: status, currentPeriodEnd: item.currentPeriodEnd } });
          ignored = false;
          return "processed";
        });
        options.logger?.info({ ...fields, outcome: ignored ? "ignored" : "processed" }, "Stripe billing event");
        return response(false, ignored);
      } catch {
        try { await repository.markFailed({ ...token, errorCode: "billing_processing_failed" }); } catch { /* lease reclaim remains available */ }
        options.logger?.info({ ...fields, outcome: "pending_retry" }, "Stripe billing event");
        throw new AppError(500, "billing_processing_failed", "Billing event will be retried");
      }
    },
  };
}
