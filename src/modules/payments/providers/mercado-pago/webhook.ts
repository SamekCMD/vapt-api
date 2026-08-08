import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "../../../../lib/errors.js";
import type {
  PaymentProviderAccountRecord,
  PaymentRepository,
  PaymentTransactionRecord,
} from "../../repository.js";
import { isPaymentTransitionAllowed } from "../../state-machine.js";
import type { PaymentEnvironment, PaymentStatus } from "../../types.js";
import type { MercadoPagoPaymentClient, MercadoPagoPaymentResult } from "./payment-client.js";

type MercadoPagoWebhookRepository = Pick<
  PaymentRepository,
  | "findActiveProviderAccountByExternalAccountId"
  | "findTransactionById"
  | "reserveWebhookEvent"
  | "markWebhookEvent"
  | "applyPaymentTransition"
>;

type MercadoPagoWebhookInput = {
  rawBody: string;
  dataId: string;
  requestId: string;
  signatureHeader: string;
};

type MercadoPagoWebhookEnvelope = {
  externalEventId: string;
  eventType: string;
  action: string;
  dataId: string;
  externalAccountId: string | null;
  environment: PaymentEnvironment | null;
  payload: Readonly<Record<string, unknown>>;
};

type MercadoPagoWebhookResult =
  | { received: true; duplicate: true }
  | { received: true; duplicate: false; status: PaymentStatus }
  | { received: true; duplicate: false; ignored: true };

export type MercadoPagoWebhookService = {
  handle(input: MercadoPagoWebhookInput): Promise<MercadoPagoWebhookResult>;
};

function signatureParts(header: string): { timestamp: string; digest: string } | null {
  const values = new Map<string, string>();
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }

  const timestamp = values.get("ts");
  const digest = values.get("v1");
  if (!timestamp || !/^\d+$/.test(timestamp) || !digest || !/^[a-f0-9]{64}$/i.test(digest)) {
    return null;
  }
  return { timestamp, digest: digest.toLowerCase() };
}

export function verifyMercadoPagoWebhookSignature(input: {
  dataId: string;
  requestId: string;
  signatureHeader: string;
  secret: string;
}): boolean {
  const parts = signatureParts(input.signatureHeader);
  if (!parts || !input.dataId || !input.requestId || !input.secret) return false;

  const normalizedDataId = input.dataId.toLowerCase();
  const manifest = `id:${normalizedDataId};request-id:${input.requestId};ts:${parts.timestamp};`;
  const expected = createHmac("sha256", input.secret).update(manifest).digest();
  const received = Buffer.from(parts.digest, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function parseWebhookEnvelope(rawBody: string, signedDataId: string, requestId: string): MercadoPagoWebhookEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new AppError(400, "invalid_request", "Invalid Mercado Pago webhook payload");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "invalid_request", "Invalid Mercado Pago webhook payload");
  }

  const payload = value as Record<string, unknown>;
  const data = payload.data;
  const bodyDataId = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).id
    : null;
  const normalizedBodyDataId = typeof bodyDataId === "string" || typeof bodyDataId === "number"
    ? String(bodyDataId).toLowerCase()
    : null;
  if (!normalizedBodyDataId || normalizedBodyDataId !== signedDataId.toLowerCase()) {
    throw new AppError(401, "invalid_webhook_signature", "Invalid Mercado Pago webhook signature");
  }

  const rawEventId = payload.id;
  const externalEventId = typeof rawEventId === "string" || typeof rawEventId === "number"
    ? String(rawEventId)
    : requestId;
  const rawAccountId = payload.user_id;
  const externalAccountId = typeof rawAccountId === "string" || typeof rawAccountId === "number"
    ? String(rawAccountId)
    : null;
  const environment = typeof payload.live_mode === "boolean"
    ? payload.live_mode ? "production" : "sandbox"
    : null;

  return {
    externalEventId,
    eventType: typeof payload.type === "string" ? payload.type : "unknown",
    action: typeof payload.action === "string" ? payload.action : "unknown",
    dataId: normalizedBodyDataId,
    externalAccountId,
    environment,
    payload,
  };
}

function mapPaymentStatus(status: string): PaymentStatus | null {
  switch (status) {
    case "approved":
      return "paid";
    case "pending":
      return "pending";
    case "authorized":
    case "in_process":
    case "in_mediation":
      return "processing";
    case "rejected":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "refunded":
      return "refunded";
    default:
      return null;
  }
}

function minorUnits(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(Math.round(parsed * 100)) ? Math.round(parsed * 100) : null;
}

function mismatch(field: string): AppError {
  return new AppError(
    409,
    "provider_response_mismatch",
    `Mercado Pago payment does not match transaction: ${field}`,
  );
}

function validatePayment(
  payment: MercadoPagoPaymentResult,
  account: PaymentProviderAccountRecord,
  transaction: PaymentTransactionRecord,
  dataId: string,
): void {
  if (payment.id !== dataId) throw mismatch("payment_id");
  if (payment.collectorId !== account.externalAccountId) throw mismatch("collector_id");
  if (payment.externalReference !== transaction.id) throw mismatch("external_reference");
  if (transaction.provider !== "mercado_pago") throw mismatch("provider");
  if (transaction.providerAccountId !== account.id) throw mismatch("provider_account_id");
  if (transaction.restaurantId !== account.restaurantId) throw mismatch("restaurant_id");
  if (transaction.externalPaymentId && transaction.externalPaymentId !== payment.id) {
    throw mismatch("external_payment_id");
  }
  if (payment.currency !== transaction.amount.currency) throw mismatch("currency");
  if (minorUnits(payment.transactionAmount) !== minorUnits(transaction.amount.amount)) {
    throw mismatch("amount");
  }
}

function failureCode(error: unknown): string {
  return error instanceof AppError ? error.code : "webhook_processing_failed";
}

export function createMercadoPagoWebhookService(input: {
  webhookSecret: string;
  repository: MercadoPagoWebhookRepository;
  resolveAccessToken: (input: { providerAccountId: string; restaurantId: string }) => Promise<string>;
  client: MercadoPagoPaymentClient;
  now?: () => string;
}): MercadoPagoWebhookService {
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async handle(webhook) {
      if (!verifyMercadoPagoWebhookSignature({
        dataId: webhook.dataId,
        requestId: webhook.requestId,
        signatureHeader: webhook.signatureHeader,
        secret: input.webhookSecret,
      })) {
        throw new AppError(401, "invalid_webhook_signature", "Invalid Mercado Pago webhook signature");
      }

      const envelope = parseWebhookEnvelope(webhook.rawBody, webhook.dataId, webhook.requestId);
      if (
        envelope.eventType !== "payment" ||
        !envelope.externalAccountId ||
        !envelope.environment
      ) {
        const reservation = await input.repository.reserveWebhookEvent({
          provider: "mercado_pago",
          externalEventId: envelope.externalEventId,
          eventType: envelope.eventType,
          restaurantId: null,
          providerAccountId: null,
          paymentTransactionId: null,
          signatureValid: true,
          payload: envelope.payload,
        });
        if (!reservation.duplicate) {
          await input.repository.markWebhookEvent(
            "mercado_pago",
            envelope.externalEventId,
            "ignored",
            null,
          );
        }
        return reservation.duplicate
          ? { received: true, duplicate: true }
          : { received: true, duplicate: false, ignored: true };
      }

      const account = await input.repository.findActiveProviderAccountByExternalAccountId(
        "mercado_pago",
        envelope.externalAccountId,
        envelope.environment,
      );
      const reservation = await input.repository.reserveWebhookEvent({
        provider: "mercado_pago",
        externalEventId: envelope.externalEventId,
        eventType: envelope.action,
        restaurantId: account?.restaurantId ?? null,
        providerAccountId: account?.id ?? null,
        paymentTransactionId: null,
        signatureValid: true,
        payload: envelope.payload,
      });
      if (reservation.duplicate) return { received: true, duplicate: true };
      if (!account) {
        await input.repository.markWebhookEvent(
          "mercado_pago",
          envelope.externalEventId,
          "ignored",
          null,
        );
        return { received: true, duplicate: false, ignored: true };
      }

      try {
        const accessToken = await input.resolveAccessToken({
          providerAccountId: account.id,
          restaurantId: account.restaurantId,
        });
        const payment = await input.client.getPayment({
          accessToken,
          paymentId: envelope.dataId,
        });
        const transaction = payment.externalReference
          ? await input.repository.findTransactionById(payment.externalReference)
          : null;
        if (!transaction) throw mismatch("external_reference");
        validatePayment(payment, account, transaction, envelope.dataId);

        const nextStatus = mapPaymentStatus(payment.status);
        if (!nextStatus || !isPaymentTransitionAllowed(transaction.status, nextStatus)) {
          await input.repository.markWebhookEvent(
            "mercado_pago",
            envelope.externalEventId,
            "ignored",
            null,
          );
          return { received: true, duplicate: false, ignored: true };
        }

        await input.repository.applyPaymentTransition({
          transactionId: transaction.id,
          expectedVersion: transaction.version,
          newStatus: nextStatus,
          providerStatus: payment.statusDetail || payment.status,
          externalPaymentId: payment.id,
          transitionedAt: payment.dateLastUpdated || now(),
          checkoutUrl: transaction.checkoutUrl,
          expiresAt: transaction.expiresAt,
          providerPayload: {
            paymentId: payment.id,
            paymentMethodId: payment.paymentMethodId,
            providerStatus: payment.status,
          },
          effectTypes: nextStatus === "paid" ? ["release_order_to_kitchen"] : null,
        });
        await input.repository.markWebhookEvent(
          "mercado_pago",
          envelope.externalEventId,
          "processed",
          null,
        );
        return { received: true, duplicate: false, status: nextStatus };
      } catch (error) {
        await input.repository.markWebhookEvent(
          "mercado_pago",
          envelope.externalEventId,
          "failed",
          failureCode(error),
        );
        throw error;
      }
    },
  };
}
