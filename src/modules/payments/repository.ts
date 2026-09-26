import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type {
  ClaimPaymentEffectsInput,
  CompletePaymentEffectInput,
  FailPaymentEffectInput,
} from "./effects.js";
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
  providerPayload: Readonly<Record<string, unknown>>;
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
  displayId: string | null;
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
  checkoutUrl: string | null;
  expiresAt: string | null;
  providerPayload: Readonly<Record<string, unknown>>;
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

export interface PaymentRepository {
  findActiveProviderAccount(
    restaurantId: string,
    provider: PaymentProviderCode,
    environment: PaymentEnvironment,
  ): Promise<PaymentProviderAccountRecord | null>;
  findActiveProviderAccountByExternalAccountId(
    provider: PaymentProviderCode,
    externalAccountId: string,
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
  claimEffects(input: ClaimPaymentEffectsInput): Promise<PaymentEffectRecord[]>;
  completeEffect(input: CompletePaymentEffectInput): Promise<void>;
  failEffect(input: FailPaymentEffectInput): Promise<void>;
  releaseOrderToProduction(input: {
    paymentTransactionId: string;
    restaurantId: string;
  }): Promise<void>;
  countPendingEffects(): Promise<number>;
}

export class PaymentTransactionConflictError extends Error {
  constructor() {
    super("Payment transaction idempotency conflict");
    this.name = "PaymentTransactionConflictError";
  }
}

type DbTimestamp = string | Date;

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
  provider_payload: Record<string, unknown> | null;
  checkout_url: string | null;
  expires_at: DbTimestamp | null;
  version: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
};

type RawManualPaymentOrder = {
  id: string;
  restaurant_id: string;
  display_id: string | number | null;
  total_price: string | number;
  status: string;
  payment_status: string | null;
  payment_confirmed_at: DbTimestamp | null;
};

type RawPaymentEffect = {
  id: string;
  restaurant_id: string;
  payment_transaction_id: string;
  effect_type: string;
  status: PaymentEffectRecord["status"];
  payload: Record<string, unknown> | null;
  attempts: number;
  available_at: DbTimestamp;
  locked_until: DbTimestamp | null;
};

const TRANSACTION_COLUMNS = `
  id,
  restaurant_id,
  order_id,
  provider_account_id,
  provider,
  external_payment_id,
  idempotency_key,
  request_fingerprint,
  amount,
  currency,
  status,
  provider_status,
  payment_method,
  processing_mode,
  manually_confirmed_by,
  provider_payload,
  checkout_url,
  expires_at,
  version,
  created_at,
  updated_at
`;

const PROVIDER_ACCOUNT_COLUMNS = `
  id,
  restaurant_id,
  provider,
  environment,
  status,
  external_account_id,
  capabilities,
  version
`;

function storageFailure(message: string): never {
  throw new AppError(500, "payment_storage_error", message);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "") || null
    : null;
}

function isDuplicateError(error: unknown): boolean {
  return errorCode(error) === "23505";
}

function decimalString(value: string | number): string {
  return typeof value === "string" ? value : value.toFixed(2);
}

function bigintString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

function isoString(value: DbTimestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoNullable(value: DbTimestamp | null): string | null {
  return value === null ? null : isoString(value);
}

function mapProviderAccount(row: RawProviderAccount): PaymentProviderAccountRecord {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    provider: row.provider,
    environment: row.environment,
    status: row.status,
    externalAccountId: row.external_account_id,
    capabilities: row.capabilities ?? {},
    version: row.version,
  };
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
      amount: decimalString(row.amount),
      currency: row.currency,
    },
    status: row.status,
    providerStatus: row.provider_status,
    paymentMethod: row.payment_method,
    processingMode: row.processing_mode,
    providerPayload: row.provider_payload ?? {},
    manuallyConfirmedBy: row.manually_confirmed_by,
    checkoutUrl: row.checkout_url,
    expiresAt: isoNullable(row.expires_at),
    version: row.version,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

function mapEffect(row: RawPaymentEffect): PaymentEffectRecord {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    paymentTransactionId: row.payment_transaction_id,
    effectType: row.effect_type,
    status: row.status,
    payload: row.payload ?? {},
    attempts: row.attempts,
    availableAt: isoString(row.available_at),
    lockedUntil: isoNullable(row.locked_until),
  };
}

export function createPaymentRepository(database: Queryable): PaymentRepository {
  return {
    async findOrderForManualPayment(orderId) {
      try {
        const result = await database.query<RawManualPaymentOrder>(
          `select
            id,
            restaurant_id,
            display_id,
            total_price,
            status,
            payment_status,
            payment_confirmed_at
          from public.orders
          where id = $1::uuid
          limit 1`,
          [orderId],
        );
        const row = result.rows[0];
        return row ? {
          id: row.id,
          restaurantId: row.restaurant_id,
          displayId: bigintString(row.display_id),
          totalPrice: decimalString(row.total_price),
          status: row.status,
          paymentStatus: row.payment_status,
          paymentConfirmedAt: isoNullable(row.payment_confirmed_at),
        } : null;
      } catch {
        storageFailure("Failed to load order for manual payment");
      }
    },

    async findActiveProviderAccount(restaurantId, provider, environment) {
      try {
        const result = await database.query<RawProviderAccount>(
          `select ${PROVIDER_ACCOUNT_COLUMNS}
          from public.payment_provider_accounts
          where restaurant_id = $1::uuid
            and provider = $2::text
            and status = 'active'
            and environment = $3::text
          limit 1`,
          [restaurantId, provider, environment],
        );
        return result.rows[0] ? mapProviderAccount(result.rows[0]) : null;
      } catch {
        storageFailure("Failed to load payment provider account");
      }
    },

    async findActiveProviderAccountByExternalAccountId(provider, externalAccountId, environment) {
      try {
        const result = await database.query<RawProviderAccount>(
          `select ${PROVIDER_ACCOUNT_COLUMNS}
          from public.payment_provider_accounts
          where provider = $1::text
            and external_account_id = $2::text
            and status = 'active'
            and environment = $3::text
          limit 1`,
          [provider, externalAccountId, environment],
        );
        return result.rows[0] ? mapProviderAccount(result.rows[0]) : null;
      } catch {
        storageFailure("Failed to load payment provider account");
      }
    },

    async findTransactionById(transactionId) {
      try {
        const result = await database.query<RawPaymentTransaction>(
          `select ${TRANSACTION_COLUMNS}
          from public.payment_transactions
          where id = $1::uuid
          limit 1`,
          [transactionId],
        );
        return result.rows[0] ? mapTransaction(result.rows[0]) : null;
      } catch {
        storageFailure("Failed to load payment transaction");
      }
    },

    async findTransactionByIdempotencyKey(restaurantId, idempotencyKey) {
      try {
        const result = await database.query<RawPaymentTransaction>(
          `select ${TRANSACTION_COLUMNS}
          from public.payment_transactions
          where restaurant_id = $1::uuid
            and idempotency_key = $2::text
          limit 1`,
          [restaurantId, idempotencyKey],
        );
        return result.rows[0] ? mapTransaction(result.rows[0]) : null;
      } catch {
        storageFailure("Failed to load idempotent payment transaction");
      }
    },

    async createTransaction(input) {
      try {
        const result = await database.query<RawPaymentTransaction>(
          `insert into public.payment_transactions (
            restaurant_id,
            order_id,
            provider_account_id,
            provider,
            idempotency_key,
            request_fingerprint,
            amount,
            currency,
            payment_method,
            processing_mode,
            manually_confirmed_by
          ) values (
            $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
            $7::numeric, $8::text, $9::text, $10::text, $11::uuid
          )
          returning ${TRANSACTION_COLUMNS}`,
          [
            input.restaurantId,
            input.orderId,
            input.providerAccountId,
            input.provider,
            input.idempotencyKey,
            input.requestFingerprint,
            input.amount.amount,
            input.amount.currency,
            input.paymentMethod,
            input.processingMode,
            input.manuallyConfirmedBy ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) storageFailure("Failed to create payment transaction");
        return mapTransaction(row);
      } catch (error) {
        if (isDuplicateError(error)) throw new PaymentTransactionConflictError();
        if (error instanceof AppError) throw error;
        storageFailure("Failed to create payment transaction");
      }
    },

    async applyPaymentTransition(input) {
      try {
        const result = await database.query<RawPaymentTransaction>(
          `select * from public.apply_payment_transition_v2(
            $1::uuid,
            $2::integer,
            $3::text,
            $4::text,
            $5::text,
            $6::timestamptz,
            $7::text,
            $8::timestamptz,
            $9::jsonb,
            $10::text[]
          )`,
          [
            input.transactionId,
            input.expectedVersion,
            input.newStatus,
            input.providerStatus,
            input.externalPaymentId,
            input.transitionedAt,
            input.checkoutUrl,
            input.expiresAt,
            input.providerPayload,
            input.effectTypes,
          ],
        );
        const row = result.rows[0];
        if (!row) storageFailure("Failed to apply payment transition");
        return mapTransaction(row);
      } catch (error) {
        if (error instanceof AppError) throw error;
        storageFailure("Failed to apply payment transition");
      }
    },

    async reserveWebhookEvent(input) {
      try {
        const inserted = await database.query<{ id: string }>(
          `insert into public.payment_webhook_events (
            provider,
            external_event_id,
            event_type,
            restaurant_id,
            provider_account_id,
            payment_transaction_id,
            signature_valid,
            payload,
            attempts
          ) values (
            $1::text, $2::text, $3::text, $4::uuid, $5::uuid,
            $6::uuid, $7::boolean, $8::jsonb, 1
          )
          on conflict (provider, external_event_id) do nothing
          returning id`,
          [
            input.provider,
            input.externalEventId,
            input.eventType,
            input.restaurantId,
            input.providerAccountId,
            input.paymentTransactionId,
            input.signatureValid,
            input.payload,
          ],
        );
        if (inserted.rows[0]) return { duplicate: false };

        const existing = await database.query<{ status: string; attempts: number }>(
          `select status, attempts
          from public.payment_webhook_events
          where provider = $1::text and external_event_id = $2::text
          limit 1`,
          [input.provider, input.externalEventId],
        );
        const row = existing.rows[0];
        if (!row || row.status !== "failed") return { duplicate: true };

        const retried = await database.query<{ id: string }>(
          `update public.payment_webhook_events
          set status = 'received',
              attempts = attempts + 1,
              last_error = null,
              processed_at = null,
              updated_at = now()
          where provider = $1::text
            and external_event_id = $2::text
            and status = 'failed'
            and attempts = $3::integer
          returning id`,
          [input.provider, input.externalEventId, row.attempts],
        );
        return { duplicate: !retried.rows[0] };
      } catch {
        storageFailure("Failed to reserve payment webhook event");
      }
    },

    async markWebhookEvent(provider, externalEventId, status, lastError) {
      try {
        await database.query(
          `update public.payment_webhook_events
          set status = $3::text,
              last_error = $4::text,
              processed_at = case
                when $3::text in ('processed', 'ignored') then $5::timestamptz
                else null
              end,
              updated_at = now()
          where provider = $1::text and external_event_id = $2::text`,
          [provider, externalEventId, status, lastError, new Date().toISOString()],
        );
      } catch {
        storageFailure("Failed to update payment webhook event");
      }
    },

    async claimEffects(input) {
      try {
        const result = await database.query<RawPaymentEffect>(
          `select * from public.claim_payment_effects(
            $1::text, $2::integer, $3::timestamptz, $4::timestamptz
          )`,
          [input.workerId, input.limit, input.lockedAt, input.lockedUntil],
        );
        return result.rows.map(mapEffect);
      } catch {
        storageFailure("Failed to claim payment effects");
      }
    },

    async completeEffect(input) {
      try {
        await database.query(
          "select public.complete_payment_effect($1::uuid, $2::text, $3::timestamptz)",
          [input.effectId, input.workerId, input.processedAt],
        );
      } catch {
        storageFailure("Failed to complete payment effect");
      }
    },

    async failEffect(input) {
      try {
        await database.query(
          `select public.fail_payment_effect(
            $1::uuid, $2::text, $3::text, $4::integer, $5::timestamptz, $6::text
          )`,
          [
            input.effectId,
            input.workerId,
            input.status,
            input.attempts,
            input.availableAt,
            input.lastError,
          ],
        );
      } catch {
        storageFailure("Failed to schedule payment effect retry");
      }
    },

    async releaseOrderToProduction(input) {
      try {
        await database.query(
          "select public.release_paid_order_to_production($1::uuid, $2::uuid)",
          [input.paymentTransactionId, input.restaurantId],
        );
      } catch {
        storageFailure("Failed to release paid order to production");
      }
    },

    async countPendingEffects() {
      try {
        const result = await database.query<{ count: string | number }>(
          "select public.count_pending_payment_effects() as count",
        );
        return Number(result.rows[0]?.count ?? 0);
      } catch {
        storageFailure("Failed to count pending payment effects");
      }
    },
  };
}
