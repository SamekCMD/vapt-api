import type { AppConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import { createRestaurantAccessChecker, type OwnershipLookup } from "../../../lib/permissions.js";
import type { BillingScope, OwnedBillingScope, StripeBillingStore } from "./repository.js";
import type { StripePlanType } from "./schemas.js";
import type { StripeCheckoutSession, StripeCustomer, StripeGateway } from "./types.js";

export function invalidStripeResponse(): never {
  throw new AppError(502, "invalid_stripe_response", "Invalid billing provider response");
}
export function assertStripeMode(livemode: boolean, environment: "test" | "live"): void {
  if (livemode !== (environment === "live")) invalidStripeResponse();
}
export function assertStripeMetadata(metadata: Record<string, string>, scope: OwnedBillingScope): void {
  if (metadata.vapt_restaurant_id !== scope.restaurantId || metadata.vapt_owner_id !== scope.userId) invalidStripeResponse();
}
export function assertStripeUrl(value: string | null, host: string): string {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port) invalidStripeResponse();
    return url.href;
  } catch { invalidStripeResponse(); }
}
async function provider<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "stripe_unavailable", "Billing provider is temporarily unavailable");
  }
}
export function createStripeBillingService(
  gateway: StripeGateway, ownershipLookup: OwnershipLookup, repository: StripeBillingStore,
  config: Pick<AppConfig, "stripe" | "frontendUrl">,
) {
  const assertAccess = createRestaurantAccessChecker(ownershipLookup);
  const pageUrl = () => new URL("/dashboard/subscription", config.frontendUrl);
  const validateCustomer = (customer: StripeCustomer, scope: OwnedBillingScope, expectedId?: string) => {
    assertStripeMode(customer.livemode, config.stripe.environment);
    assertStripeMetadata(customer.metadata, scope);
    if (!customer.id || (expectedId && customer.id !== expectedId)) invalidStripeResponse();
  };
  const validateCheckout = (session: StripeCheckoutSession, scope: BillingScope, planType: StripePlanType, expectedId?: string) => {
    assertStripeMode(session.livemode, config.stripe.environment);
    assertStripeMetadata(session.metadata, scope);
    if (!session.id || (expectedId && session.id !== expectedId) ||
      session.customerId !== scope.stripeCustomerId || session.clientReferenceId !== scope.restaurantId ||
      session.metadata.vapt_plan_type !== planType || !Number.isFinite(Date.parse(session.expiresAt))) invalidStripeResponse();
  };
  return {
    async createCheckout(input: OwnedBillingScope & { email: string; planType: StripePlanType; idempotencyKey: string }) {
      await assertAccess(input);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) {
        throw new AppError(400, "invalid_request", "A valid Idempotency-Key is required");
      }
      const owned = { userId: input.userId, restaurantId: input.restaurantId };
      const metadata = { vapt_restaurant_id: input.restaurantId, vapt_owner_id: input.userId, vapt_plan_type: input.planType };
      return repository.withBillingLock(owned, async lock => {
        const scope = lock.scope;
        if (scope.stripeSubscriptionId) {
          const subscription = await provider(() => gateway.getSubscription(scope.stripeSubscriptionId!));
          assertStripeMode(subscription.livemode, config.stripe.environment);
          assertStripeMetadata(subscription.metadata, scope);
          if (subscription.id !== scope.stripeSubscriptionId || subscription.customerId !== scope.stripeCustomerId) invalidStripeResponse();
          if (!["canceled", "incomplete_expired"].includes(subscription.status)) {
            throw new AppError(409, "billing_conflict", "Manage the existing subscription in the billing portal");
          }
        }
        if (scope.stripeCustomerId) {
          validateCustomer(await provider(() => gateway.getCustomer(scope.stripeCustomerId!)), scope, scope.stripeCustomerId);
        } else {
          const matches = await provider(() => gateway.findCustomers(scope.restaurantId));
          if (matches.length > 1) throw new AppError(409, "billing_conflict", "Multiple billing Customers found");
          const customer = matches[0] ?? await provider(() => gateway.createCustomer(
            { email: input.email, metadata }, "vapt:customer:" + scope.restaurantId));
          validateCustomer(customer, scope);
          await lock.associateCustomer(customer.id);
        }
        if (scope.checkoutSessionId) {
          if (!scope.checkoutPlanType) invalidStripeResponse();
          const session = await provider(() => gateway.getCheckout(scope.checkoutSessionId!));
          validateCheckout(session, scope, scope.checkoutPlanType, scope.checkoutSessionId);
          if (session.status === "complete") {
            throw new AppError(409, "billing_conflict", "Checkout is awaiting billing confirmation");
          }
          if (session.status === "open" && Date.parse(session.expiresAt) > Date.now()) {
            if (scope.checkoutPlanType !== input.planType) {
              throw new AppError(409, "billing_conflict", "Another plan already has an open Checkout");
            }
            return { checkoutSessionId: session.id, url: assertStripeUrl(session.url, "checkout.stripe.com") };
          }
          // Never replace an open session solely because our local expiry is stale.
          if (session.status !== "expired") invalidStripeResponse();
          await lock.clearPendingCheckout();
        }
        const successUrl = pageUrl(); successUrl.searchParams.set("checkout", "returned");
        const cancelUrl = pageUrl(); cancelUrl.searchParams.set("checkout", "cancelled");
        const session = await provider(() => gateway.createCheckout({
          customerId: scope.stripeCustomerId!, priceId: config.stripe.prices[input.planType],
          metadata, clientReferenceId: scope.restaurantId,
          successUrl: successUrl.href, cancelUrl: cancelUrl.href,
        }, "vapt:checkout:" + scope.restaurantId + ":" + input.planType + ":" + input.idempotencyKey));
        validateCheckout(session, scope, input.planType);
        if (session.status !== "open" || Date.parse(session.expiresAt) <= Date.now()) invalidStripeResponse();
        const url = assertStripeUrl(session.url, "checkout.stripe.com");
        await lock.savePendingCheckout({ id: session.id, planType: input.planType, expiresAt: session.expiresAt });
        return { checkoutSessionId: session.id, url };
      });
    },
    async createPortal(input: OwnedBillingScope) {
      await assertAccess(input);
      const scope = await repository.getScope(input);
      if (!scope.stripeCustomerId) throw new AppError(409, "billing_conflict", "No billing Customer is associated");
      validateCustomer(await provider(() => gateway.getCustomer(scope.stripeCustomerId!)), scope, scope.stripeCustomerId);
      const session = await provider(() => gateway.createPortal({
        customerId: scope.stripeCustomerId!, configurationId: config.stripe.portalConfigurationId, returnUrl: pageUrl().href,
      }));
      assertStripeMode(session.livemode, config.stripe.environment);
      if (session.customerId !== scope.stripeCustomerId) invalidStripeResponse();
      return { url: assertStripeUrl(session.url, "billing.stripe.com") };
    },
    async getSubscriptionStatus(input: OwnedBillingScope) {
      await assertAccess(input);
      return repository.getPublicStatus(input);
    },
    async retiredMutation(input: OwnedBillingScope): Promise<never> {
      await assertAccess(input);
      throw new AppError(410, "billing_route_retired", "Manage billing in the customer portal");
    },
  };
}
