import type {
  CancelPaymentInput,
  CancelPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  GetPaymentStatusInput,
  NormalizedPayment,
  NormalizedPaymentEvent,
  PaymentProviderCapabilities,
  PaymentProviderCode,
  ProviderWebhookInput,
  RefundPaymentInput,
  RefundPaymentResult,
} from "./types.js";

export interface PaymentProvider {
  readonly code: PaymentProviderCode;

  getCapabilities(): PaymentProviderCapabilities;

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;

  getPaymentStatus(input: GetPaymentStatusInput): Promise<NormalizedPayment>;

  cancelPayment?(input: CancelPaymentInput): Promise<CancelPaymentResult>;

  refundPayment?(input: RefundPaymentInput): Promise<RefundPaymentResult>;

  handleWebhook?(input: ProviderWebhookInput): Promise<NormalizedPaymentEvent>;
}
