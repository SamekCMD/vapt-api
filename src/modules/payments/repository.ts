import type { SupabaseClient } from "@supabase/supabase-js";

import { AppError } from "../../lib/errors.js";
import type {
  Money,
  PaymentEnvironment,
  PaymentMethod,
  PaymentProcessingMode,
  PaymentProviderCode,
  PaymentStatus,
} from "./types.js";

export type PaymentProviderAccountRecord = {
  id: string;
  restaurantId: string;
  provider: PaymentProviderCode;
  environment: PaymentEnvironment;
  status: "disconnected" | "connecting" | "active" | "error";
  externalAccountId: string | null;
  capabilities: Readonly<Record<string, unknown>>;
  version: number;
};

export type PaymentTransactionRecord = {
  id: string;
  restaurantId: string;
  orderId: string;
  providerAccountId: string | null;
  provider: PaymentProviderCode;
  externalPaymentId: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  amount: Money;
  status: PaymentStatus;
  providerStatus: string | null;
  paymentMethod: PaymentMethod | null;
  processingMode: PaymentProcessingMode;
  manuallyConfirmedBy: string | null;
  checkoutUrl: string | null;
  expiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CreatePaymentTransactionInput = {
  restaurantId: string;
  orderId: string;
  providerAccountId: string | null;
  provider: PaymentProviderCode;
  idempotencyKey: string;
  requestFingerprint: string;
  amount: Money;
  paymentMethod: PaymentMethod | null;
  processingMode: PaymentProcessingMode;
  manuallyConfirmedBy?: string | null;
};

export type ManualPaymentOrderRecord = {
  id: string;
  restaurantId: string;
  displayId: number | null;
  totalPrice: string;
  status: string;
  paymentStatus: string | null;
  paymentConfirmedAt: string | null;
};

export type ApplyPaymentTransitionInput = {
  transactionId: string;
  expectedVersion: number;
  newStatus: PaymentStatus;
  providerStatus: string | null;
  externalPaymentId: string | null;
  transitionedAt: string;
  effectTypes: string[] | null;
};

export type ReservePaymentWebhookEventInput = {
  provider: Exclude<PaymentProviderCode, "manual">;
  externalEventId: string;
  eventType: string;
  restaurantId: string | null;
  providerAccountId: string | null;
  paymentTransactionId: string | null;
  signatureValid: boolean | null;
  payload: unknown;
};

export type PaymentEffectRecord = {
  id: string;
  restaurantId: string;
  paymentTransactionId: string;
  effectType: string;
  status: "pending" | "processing" | "completed" | "failed" | "dead_letter";
  payload: Readonly<Record<string, unknown>>;
  attempts: number;
  availableAt: string;
  lockedUntil: string | null;
};

export type UpdatePaymentEffectStateInput = {
  effectId: string;
  status: PaymentEffectRecord["status"];
  attempts: number;
  availableAt: string;
  lockedAt: string | null;
  lockedUntil: string | null;
  lockedBy: string | null;
  processedAt: string | null;
  lastError: string | null;
};

export interface PaymentRepository {
  findActiveProviderAccount(
    restaurantId: string,
    provider: PaymentProviderCode,
    environment: PaymentEnvironment,
  ): Promise<PaymentProviderAccountRecord | null>;
  findOrderForManualPayment(orderId: string): Promise<ManualPaymentOrderRecord | null>;
  findTransactionById(transactionId: string): Promise<PaymentTransactionRecord | null>;
  findTransactionByIdempotencyKey(
    restaurantId: string,
    idempotencyKey: string,
  ): Promise<PaymentTransactionRecord | null>;
  createTransaction(input: CreatePaymentTransactionInput): Promise<PaymentTransactionRecord>;
  applyPaymentTransition(input: ApplyPaymentTransitionInput): Promise<PaymentTransactionRecord>;
  reserveWebhookEvent(input: ReservePaymentWebhookEventInput): Promise<{ duplicate: boolean }>;
  markWebhookEvent(
    provider: Exclude<PaymentProviderCode, "manual">,
    externalEventId: string,
    status: "processed" | "ignored" | "failed",
    lastError: string | null,
  ): Promise<void>;
  listAvailableEffects(limit: number): Promise<PaymentEffectRecord[]>;
  updateEffectState(input: UpdatePaymentEffectStateInput): Promise<void>;
}

export class PaymentTransactionConflictError extends Error {
  constructor() {
    super("Payment transaction idempotency conflict");
    this.name = "PaymentTransactionConflictError";
  }
}

type RawProviderAccount = {
  id: string;
  restaurant_id: string;
  provider: PaymentProviderCode;
  environment: PaymentEnvironment;
  status: PaymentProviderAccountRecord["status"];
  external_account_id: string | null;
  capabilities: Record<string, unknown> | null;
  version: number;
};

type RawPaymentTransaction = {
  id: string;
  restaurant_id: string;
  order_id: string;
  provider_account_id: string | null;
  provider: PaymentProviderCode;
  external_payment_id: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  amount: string | number;
  currency: string;
  status: PaymentStatus;
  provider_status: string | null;
  payment_method: PaymentMethod | null;
  processing_mode: PaymentProcessingMode;
  manually_confirmed_by: string | null;
  checkout_url: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type RawManualPaymentOrder = {
  id: string;
  restaurant_id: string;
  display_id: number | null;
  total_price: string | number;
  status: string;
  payment_status: string | null;
  payment_confirmed_at: string | null;
};

type RawPaymentEffect = {
  id: string;
  restaurant_id: string;
  payment_transaction_id: string;
  effect_type: string;
  status: PaymentEffectRecord["status"];
  payload: Record<string, unknown> | null;
  attempts: number;
  available_at: string;
  locked_until: string | null;
};

const TRANSACTION_COLUMNS = [
  "id",
  "restaurant_id",
  "order_id",
  "provider_account_id",
  "provider",
  "external_payment_id",
  "idempotency_key",
  "request_fingerprint",
  "amount",
  "currency",
  "status",
  "provider_status",
  "payment_method",
  "processing_mode",
  "manually_confirmed_by",
  "checkout_url",
  "expires_at",
  "version",
  "created_at",
  "updated_at",
].join(", ");

function storageFailure(message: string): never {
  throw new AppError(500, "payment_storage_error", message);
}

function isDuplicateError(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === "23505" || error.message?.toLowerCase().includes("duplicate key") === true;
}

function mapTransaction(row: RawPaymentTransaction): PaymentTransactionRecord {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    orderId: row.order_id,
    providerAccountId: row.provider_account_id,
    provider: row.provider,
    externalPaymentId: row.external_payment_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    amount: {
      amount: String(row.amount),
      currency: row.currency,
    },
    status: row.status,
    providerStatus: row.provider_status,
    paymentMethod: row.payment_method,
    processingMode: row.processing_mode,
    manuallyConfirmedBy: row.manually_confirmed_by,
    checkoutUrl: row.checkout_url,
    expiresAt: row.expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPaymentRepository(client: SupabaseClient): PaymentRepository {
  return {
    async findOrderForManualPayment(orderId) {
      const result = await client
        .from("orders")
        .select("id, restaurant_id, display_id, total_price, status, payment_status, payment_confirmed_at")
        .eq("id", orderId)
        .maybeSingle<RawManualPaymentOrder>();

      if (result.error) {
        storageFailure("Failed to load order for manual payment");
      }
      if (!result.data) return null;

      return {
        id: result.data.id,
        restaurantId: result.data.restaurant_id,
        displayId: result.data.display_id,
        totalPrice: Number(result.data.total_price).toFixed(2),
        status: result.data.status,
        paymentStatus: result.data.payment_status,
        paymentConfirmedAt: result.data.payment_confirmed_at,
      };
    },

    async findActiveProviderAccount(restaurantId, provider, environment) {
      const result = await client
        .from("payment_provider_accounts")
        .select("id, restaurant_id, provider, environment, status, external_account_id, capabilities, version")
        .eq("restaurant_id", restaurantId)
        .eq("provider", provider)
        .eq("status", "active")
        .eq("environment", environment)
        .maybeSingle<RawProviderAccount>();

      if (result.error) {
        storageFailure("Failed to load payment provider account");
      }

      if (!result.data) {
        return null;
      }

      return {
        id: result.data.id,
        restaurantId: result.data.restaurant_id,
        provider: result.data.provider,
        environment: result.data.environment,
        status: result.data.status,
        externalAccountId: result.data.external_account_id,
        capabilities: result.data.capabilities ?? {},
        version: result.data.version,
      };
    },

    async findTransactionById(transactionId) {
      const result = await client
        .from("payment_transactions")
        .select(TRANSACTION_COLUMNS)
        .eq("id", transactionId)
        .maybeSingle<RawPaymentTransaction>();

      if (result.error) {
        storageFailure("Failed to load payment transaction");
      }

      return result.data ? mapTransaction(result.data) : null;
    },

    async findTransactionByIdempotencyKey(restaurantId, idempotencyKey) {
      const result = await client
        .from("payment_transactions")
        .select(TRANSACTION_COLUMNS)
        .eq("restaurant_id", restaurantId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle<RawPaymentTransaction>();

      if (result.error) {
        storageFailure("Failed to load idempotent payment transaction");
      }

      return result.data ? mapTransaction(result.data) : null;
    },

    async createTransaction(input) {
      const result = await client
        .from("payment_transactions")
        .insert({
          restaurant_id: input.restaurantId,
          order_id: input.orderId,
          provider_account_id: input.providerAccountId,
          provider: input.provider,
          idempotency_key: input.idempotencyKey,
          request_fingerprint: input.requestFingerprint,
          amount: input.amount.amount,
          currency: input.amount.currency,
          payment_method: input.paymentMethod,
          processing_mode: input.processingMode,
          manually_confirmed_by: input.manuallyConfirmedBy ?? null,
        })
        .select(TRANSACTION_COLUMNS)
        .single<RawPaymentTransaction>();

      if (result.error) {
        if (isDuplicateError(result.error)) {
          throw new PaymentTransactionConflictError();
        }
        storageFailure("Failed to create payment transaction");
      }

      return mapTransaction(result.data);
    },

    async applyPaymentTransition(input) {
      const result = await client
        .rpc("apply_payment_transition", {
          p_transaction_id: input.transactionId,
          p_expected_version: input.expectedVersion,
          p_new_status: input.newStatus,
          p_provider_status: input.providerStatus,
          p_external_payment_id: input.externalPaymentId,
          p_transitioned_at: input.transitionedAt,
          p_effect_types: input.effectTypes,
        })
        .single<RawPaymentTransaction>();

      if (result.error) {
        storageFailure("Failed to apply payment transition");
      }

      return mapTransaction(result.data);
    },

    async reserveWebhookEvent(input) {
      const result = await client.from("payment_webhook_events").insert({
        provider: input.provider,
        external_event_id: input.externalEventId,
        event_type: input.eventType,
        restaurant_id: input.restaurantId,
        provider_account_id: input.providerAccountId,
        payment_transaction_id: input.paymentTransactionId,
        signature_valid: input.signatureValid,
        payload: input.payload,
      });

      if (!result.error) {
        return { duplicate: false };
      }

      if (isDuplicateError(result.error)) {
        return { duplicate: true };
      }

      storageFailure("Failed to reserve payment webhook event");
    },

    async markWebhookEvent(provider, externalEventId, status, lastError) {
      const result = await client
        .from("payment_webhook_events")
        .update({
          status,
          last_error: lastError,
          processed_at: status === "processed" || status === "ignored"
            ? new Date().toISOString()
            : null,
        })
        .eq("provider", provider)
        .eq("external_event_id", externalEventId);

      if (result.error) {
        storageFailure("Failed to update payment webhook event");
      }
    },

    async listAvailableEffects(limit) {
      const result = await client
        .from("payment_effect_outbox")
        .select("id, restaurant_id, payment_transaction_id, effect_type, status, payload, attempts, available_at, locked_until")
        .in("status", ["pending", "failed"])
        .lte("available_at", new Date().toISOString())
        .order("available_at", { ascending: true })
        .limit(limit)
        .returns<RawPaymentEffect[]>();

      if (result.error) {
        storageFailure("Failed to load payment effects");
      }

      return (result.data ?? []).map((effect) => ({
        id: effect.id,
        restaurantId: effect.restaurant_id,
        paymentTransactionId: effect.payment_transaction_id,
        effectType: effect.effect_type,
        status: effect.status,
        payload: effect.payload ?? {},
        attempts: effect.attempts,
        availableAt: effect.available_at,
        lockedUntil: effect.locked_until,
      }));
    },

    async updateEffectState(input) {
      const result = await client
        .from("payment_effect_outbox")
        .update({
          status: input.status,
          attempts: input.attempts,
          available_at: input.availableAt,
          locked_at: input.lockedAt,
          locked_until: input.lockedUntil,
          locked_by: input.lockedBy,
          processed_at: input.processedAt,
          last_error: input.lastError,
        })
        .eq("id", input.effectId);

      if (result.error) {
        storageFailure("Failed to update payment effect");
      }
    },
  };
}
