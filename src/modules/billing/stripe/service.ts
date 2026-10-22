import type { AppConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import type {OrganizationScope,OrganizationWriteScope} from "../../tenancy/contracts.js";
import type { BillingScope, StripeBillingStore } from "./repository.js";
import type { StripePlanType } from "./schemas.js";
import type { StripeCheckoutSession, StripeCustomer, StripeGateway } from "./types.js";

export function invalidStripeResponse(): never {
  throw new AppError(502, "invalid_stripe_response", "Invalid billing provider response");
}
export function assertStripeMode(livemode: boolean, environment: "test" | "live"): void {
  if (livemode !== (environment === "live")) invalidStripeResponse();
}
export type BillingMetadataScope=Pick<BillingScope,'organizationId'|'billingContactUserId'|'legacyResources'>;
export function assertStripeMetadata(metadata:Record<string,string>,scope:BillingMetadataScope,resourceId?:string):void {
  const legacy=scope.legacyResources.find(value=>value.resourceId===resourceId);
  const hasCanonical=metadata.vapt_organization_id!==undefined || metadata.vapt_billing_contact_user_id!==undefined;
  if(hasCanonical && (metadata.vapt_organization_id!==scope.organizationId ||
    metadata.vapt_billing_contact_user_id!==scope.billingContactUserId)) invalidStripeResponse();
  const hasLegacy=metadata.vapt_restaurant_id!==undefined || metadata.vapt_owner_id!==undefined;
  if(!hasCanonical || hasLegacy){
    if(!legacy || metadata.vapt_restaurant_id!==legacy.restaurantId || metadata.vapt_owner_id!==legacy.legacyOwnerId)
      invalidStripeResponse();
  }
}
function clientReference(scope:BillingMetadataScope,metadata:Record<string,string>,resourceId:string):string {
  if(metadata.vapt_organization_id!==undefined) return scope.organizationId;
  const legacy=scope.legacyResources.find(value=>value.resourceId===resourceId);
  if(!legacy) invalidStripeResponse();return legacy.restaurantId;
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
  gateway: StripeGateway, repository: StripeBillingStore,
  config: Pick<AppConfig, "stripe" | "frontendUrl">,
) {
  const pageUrl = (organizationId:string) => { const url=new URL("/dashboard/subscription",config.frontendUrl);url.searchParams.set("billingOrganizationId",organizationId);return url; };
  const validateCustomer = (customer: StripeCustomer, scope: BillingMetadataScope, expectedId?: string) => {
    assertStripeMode(customer.livemode, config.stripe.environment);
    assertStripeMetadata(customer.metadata, scope,customer.id);
    if (!customer.id || (expectedId && customer.id !== expectedId)) invalidStripeResponse();
  };
  const validateCheckout = (session: StripeCheckoutSession, scope: BillingScope, planType: StripePlanType, expectedId?: string) => {
    assertStripeMode(session.livemode, config.stripe.environment);
    assertStripeMetadata(session.metadata, scope,session.id);
    if (!session.id || (expectedId && session.id !== expectedId) ||
      session.customerId !== scope.stripeCustomerId || session.clientReferenceId !== clientReference(scope,session.metadata,session.id) ||
      session.metadata.vapt_plan_type !== planType || !Number.isFinite(Date.parse(session.expiresAt))) invalidStripeResponse();
  };
  return {
    async createCheckout(input: OrganizationWriteScope & { email?: string; planType: StripePlanType; idempotencyKey: string }) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) {
        throw new AppError(400, "invalid_request", "A valid Idempotency-Key is required");
      }
      return repository.withBillingLock({userId:input.userId,organizationId:input.organizationId,sessionId:input.sessionId,sessionExpiresAt:input.sessionExpiresAt}, async lock => {
        const scope=lock.scope;
        const metadata={vapt_organization_id:scope.organizationId,vapt_billing_contact_user_id:scope.billingContactUserId,vapt_plan_type:input.planType};
        if (scope.stripeSubscriptionId) {
          const subscription = await provider(() => gateway.getSubscription(scope.stripeSubscriptionId!));
          assertStripeMode(subscription.livemode, config.stripe.environment);
          assertStripeMetadata(subscription.metadata, scope,subscription.id);
          if (subscription.id !== scope.stripeSubscriptionId || subscription.customerId !== scope.stripeCustomerId) invalidStripeResponse();
          if (!["canceled", "incomplete_expired"].includes(subscription.status)) {
            throw new AppError(409, "billing_conflict", "Manage the existing subscription in the billing portal");
          }
        }
        if (scope.stripeCustomerId) {
          validateCustomer(await provider(() => gateway.getCustomer(scope.stripeCustomerId!)), scope, scope.stripeCustomerId);
        } else {
          const matches = await provider(() => gateway.findCustomers(scope.organizationId));
          if (matches.length > 1) throw new AppError(409, "billing_conflict", "Multiple billing Customers found");
          const customer = matches[0] ?? await provider(() => gateway.createCustomer(
            { email:scope.billingContactEmail ?? (()=>{throw new AppError(409,"billing_contact_unverified","Verified billing contact is required");})(), metadata }, "vapt:customer:" + scope.organizationId));
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
        const successUrl = pageUrl(scope.organizationId); successUrl.searchParams.set("checkout", "returned");
        const cancelUrl = pageUrl(scope.organizationId); cancelUrl.searchParams.set("checkout", "cancelled");
        const session = await provider(() => gateway.createCheckout({
          customerId: scope.stripeCustomerId!, priceId: config.stripe.prices[input.planType],
          metadata, clientReferenceId: scope.organizationId,
          successUrl: successUrl.href, cancelUrl: cancelUrl.href,
        }, "vapt:checkout:" + scope.organizationId + ":" + input.planType + ":" + input.idempotencyKey));
        validateCheckout(session, scope, input.planType);
        if (session.status !== "open" || Date.parse(session.expiresAt) <= Date.now()) invalidStripeResponse();
        const url = assertStripeUrl(session.url, "checkout.stripe.com");
        await lock.savePendingCheckout({ id: session.id, planType: input.planType, expiresAt: session.expiresAt });
        return { checkoutSessionId: session.id, url };
      });
    },
    async createPortal(input: OrganizationWriteScope) {
      return repository.withBillingLock(input,async({scope})=>{
      if (!scope.stripeCustomerId) throw new AppError(409, "billing_conflict", "No billing Customer is associated");
      validateCustomer(await provider(() => gateway.getCustomer(scope.stripeCustomerId!)), scope, scope.stripeCustomerId);
      const session = await provider(() => gateway.createPortal({
        customerId: scope.stripeCustomerId!, configurationId: config.stripe.portalConfigurationId, returnUrl: pageUrl(scope.organizationId).href,
      }));
      assertStripeMode(session.livemode, config.stripe.environment);
      if (session.customerId !== scope.stripeCustomerId) invalidStripeResponse();
      return { url: assertStripeUrl(session.url, "billing.stripe.com") };
      });
    },
    async getSubscriptionStatus(input: OrganizationScope) {
      return repository.getPublicStatus(input);
    },
  };
}
