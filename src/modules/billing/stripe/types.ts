export type StripeMetadata = Record<string, string>;
export type StripeCustomer = { id: string; livemode: boolean; metadata: StripeMetadata };
export type StripeCheckoutSession = {
  id: string; livemode: boolean; metadata: StripeMetadata;
  customerId: string | null; subscriptionId: string | null;
  status: "open" | "complete" | "expired" | null;
  clientReferenceId: string | null; url: string | null; expiresAt: string;
};
export type StripeSubscriptionStatus =
  | "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due"
  | "canceled" | "unpaid" | "paused";
export type StripeSubscription = {
  id: string; livemode: boolean; metadata: StripeMetadata; customerId: string;
  status: StripeSubscriptionStatus;
  items: Array<{ id: string; priceId: string; recurring: boolean; currentPeriodEnd: string }>;
  trialEndsAt: string | null; canceledAt: string | null; cancelAtPeriodEnd: boolean;
};
export type StripeCheckoutInput = {
  customerId: string; priceId: string; metadata: StripeMetadata;
  clientReferenceId: string; successUrl: string; cancelUrl: string;
};
export interface StripeGateway {
  findCustomers(restaurantId: string): Promise<StripeCustomer[]>;
  getCustomer(id: string): Promise<StripeCustomer>;
  createCustomer(input: { email: string; metadata: StripeMetadata }, idempotencyKey: string): Promise<StripeCustomer>;
  getCheckout(id: string): Promise<StripeCheckoutSession>;
  createCheckout(input: StripeCheckoutInput, idempotencyKey: string): Promise<StripeCheckoutSession>;
  createPortal(input: { customerId: string; configurationId: string; returnUrl: string }): Promise<{
    url: string; customerId: string; livemode: boolean;
  }>;
  getSubscription(id: string): Promise<StripeSubscription>;
}
