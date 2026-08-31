export const PAYMENT_PROVIDER_CODES = ["manual", "mercado_pago", "asaas_legacy"] as const;
export type PaymentProviderCode = (typeof PAYMENT_PROVIDER_CODES)[number];

export const PAYMENT_STATUSES = [
  "created",
  "pending",
  "processing",
  "paid",
  "failed",
  "cancelled",
  "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type PaymentProcessingMode = "manual" | "online" | "legacy";
export type PaymentEnvironment = "sandbox" | "production";
export type PaymentMethod =
  | "cash"
  | "external_pix"
  | "pix"
  | "credit_card"
  | "debit_card"
  | "voucher"
  | "other";

export type Money = {
  amount: string;
  currency: string;
};

export type PaymentProviderCapabilities = {
  onlineCheckout: boolean;
  webhooks: boolean;
  cancellation: boolean;
  fullRefunds: boolean;
  partialRefunds: false;
  oauthConnection: boolean;
};

export type PaymentReturnUrls = {
  success: URL;
  pending: URL;
  failure: URL;
};

export type CreatePaymentInput = {
  transactionId: string;
  restaurantId: string;
  orderId: string;
  providerAccountId: string | null;
  environment: PaymentEnvironment;
  amount: Money;
  paymentMethod: PaymentMethod | null;
  description: string;
  idempotencyKey: string;
  returnUrls: PaymentReturnUrls | null;
};

export type NormalizedPayment = {
  transactionId: string;
  provider: PaymentProviderCode;
  status: PaymentStatus;
  amount: Money;
  paymentMethod: PaymentMethod | null;
  externalPaymentId: string | null;
  providerStatus: string | null;
  occurredAt: string;
  metadata: Readonly<Record<string, unknown>>;
};

export type CreatePaymentResult = NormalizedPayment & {
  checkoutUrl: URL | null;
  expiresAt: string | null;
};

export type GetPaymentStatusInput = {
  transactionId: string;
  providerAccountId: string | null;
  externalPaymentId: string;
  amount: Money;
};

export type CancelPaymentInput = GetPaymentStatusInput & {
  reason: string;
};

export type CancelPaymentResult = NormalizedPayment;

export type RefundPaymentInput = GetPaymentStatusInput & {
  reason: string;
};

export type RefundPaymentResult = NormalizedPayment;

export type ProviderWebhookInput = {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  providerAccountId: string | null;
  receivedAt: string;
};

export type NormalizedPaymentEvent = {
  externalEventId: string;
  eventType: string;
  payment: NormalizedPayment | null;
  ignoredReason: string | null;
};

export type StartPaymentInput = {
  restaurantId: string;
  orderId: string;
  provider: PaymentProviderCode;
  environment: PaymentEnvironment;
  amount: Money;
  paymentMethod: PaymentMethod | null;
  processingMode: PaymentProcessingMode;
  description: string;
  idempotencyKey: string;
  requestFingerprint: string;
  confirmedByUserId?: string;
  returnUrls: PaymentReturnUrls | null;
};
