import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import { createRestaurantAccessChecker, type OwnershipLookup } from "../../lib/permissions.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import type { PaymentProvider } from "./provider.js";
import {
  PaymentTransactionConflictError,
  createPaymentRepository,
  type ManualPaymentOrderRecord,
  type PaymentProviderAccountRecord,
  type PaymentRepository,
  type PaymentTransactionRecord,
} from "./repository.js";
import {
  createPaymentProviderRegistry,
  PaymentProviderNotFoundError,
  type PaymentProviderRegistry,
} from "./registry.js";
import { assertPaymentTransition } from "./state-machine.js";
import type {
  NormalizedPayment,
  PaymentEnvironment,
  PaymentMethod,
  StartPaymentInput,
} from "./types.js";

export class PaymentIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with a different payment payload");
    this.name = "PaymentIdempotencyConflictError";
  }
}

export class PaymentAccountUnavailableError extends Error {
  constructor() {
    super("An active payment provider account is required");
    this.name = "PaymentAccountUnavailableError";
  }
}

export class PaymentProviderResponseMismatchError extends Error {
  constructor(field: string) {
    super(`Payment provider response does not match transaction: ${field}`);
    this.name = "PaymentProviderResponseMismatchError";
  }
}

export interface PaymentService {
  startPayment(input: StartPaymentInput): Promise<PaymentTransactionRecord>;
  getTransaction(transactionId: string): Promise<PaymentTransactionRecord | null>;
}

export type ConfirmManualPaymentInput = {
  orderId: string;
  paymentMethod: Exclude<PaymentMethod, "pix">;
  idempotencyKey: string;
  userId: string;
  authRole: string;
};

export interface ManualPaymentService {
  confirm(input: ConfirmManualPaymentInput): Promise<PaymentTransactionRecord>;
}

type ManualPaymentServiceDependencies = {
  repository: Pick<PaymentRepository, "findOrderForManualPayment">;
  paymentService: PaymentService;
  ownershipLookup: OwnershipLookup;
};

const PAID_ORDER_STATUSES = new Set([
  "paid",
  "confirmed",
  "received",
  "received_in_cash",
  "payment_confirmed",
  "payment_received",
]);

export type PaymentModule = {
  registry: PaymentProviderRegistry;
  repository: PaymentRepository;
  service: PaymentService;
};

function needsProviderAccount(provider: PaymentProvider): boolean {
  const capabilities = provider.getCapabilities();
  return capabilities.onlineCheckout || capabilities.webhooks || capabilities.oauthConnection;
}

function assertProviderResult(
  transaction: PaymentTransactionRecord,
  payment: NormalizedPayment,
): void {
  if (payment.transactionId !== transaction.id) {
    throw new PaymentProviderResponseMismatchError("transactionId");
  }
  if (payment.provider !== transaction.provider) {
    throw new PaymentProviderResponseMismatchError("provider");
  }
  if (payment.amount.amount !== transaction.amount.amount) {
    throw new PaymentProviderResponseMismatchError("amount");
  }
  if (payment.amount.currency !== transaction.amount.currency) {
    throw new PaymentProviderResponseMismatchError("currency");
  }
}

async function loadProviderAccount(
  provider: PaymentProvider,
  repository: PaymentRepository,
  restaurantId: string,
  environment: PaymentEnvironment,
): Promise<PaymentProviderAccountRecord | null> {
  if (!needsProviderAccount(provider)) {
    return null;
  }

  const account = await repository.findActiveProviderAccount(restaurantId, provider.code, environment);
  if (!account) {
    throw new PaymentAccountUnavailableError();
  }
  return account;
}

function assertSameIdempotentRequest(
  transaction: PaymentTransactionRecord,
  input: StartPaymentInput,
): void {
  if (transaction.requestFingerprint !== input.requestFingerprint) {
    throw new PaymentIdempotencyConflictError();
  }
}

export function createPaymentService(
  registry: PaymentProviderRegistry,
  repository: PaymentRepository,
): PaymentService {
  return {
    async startPayment(input) {
      const existing = await repository.findTransactionByIdempotencyKey(
        input.restaurantId,
        input.idempotencyKey,
      );
      if (existing) {
        assertSameIdempotentRequest(existing, input);
        return existing;
      }

      const provider = registry.get(input.provider);
      const account = await loadProviderAccount(
        provider,
        repository,
        input.restaurantId,
        input.environment,
      );
      let transaction: PaymentTransactionRecord;

      try {
        transaction = await repository.createTransaction({
          restaurantId: input.restaurantId,
          orderId: input.orderId,
          providerAccountId: account?.id ?? null,
          provider: input.provider,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          amount: input.amount,
          paymentMethod: input.paymentMethod,
          processingMode: input.processingMode,
          manuallyConfirmedBy: input.confirmedByUserId ?? null,
        });
      } catch (error) {
        if (!(error instanceof PaymentTransactionConflictError)) {
          throw error;
        }

        const concurrent = await repository.findTransactionByIdempotencyKey(
          input.restaurantId,
          input.idempotencyKey,
        );
        if (!concurrent) {
          throw error;
        }
        assertSameIdempotentRequest(concurrent, input);
        return concurrent;
      }

      let payment: NormalizedPayment;
      try {
        payment = await provider.createPayment({
          transactionId: transaction.id,
          restaurantId: transaction.restaurantId,
          orderId: transaction.orderId,
          providerAccountId: transaction.providerAccountId,
          amount: transaction.amount,
          paymentMethod: transaction.paymentMethod,
          description: input.description,
          idempotencyKey: transaction.idempotencyKey,
          returnUrls: input.returnUrls,
        });
      } catch (error) {
        await repository.applyPaymentTransition({
          transactionId: transaction.id,
          expectedVersion: transaction.version,
          newStatus: "failed",
          providerStatus: "provider_error",
          externalPaymentId: null,
          transitionedAt: new Date().toISOString(),
          effectTypes: null,
        });
        throw error;
      }

      assertProviderResult(transaction, payment);
      assertPaymentTransition(transaction.status, payment.status);

      return repository.applyPaymentTransition({
        transactionId: transaction.id,
        expectedVersion: transaction.version,
        newStatus: payment.status,
        providerStatus: payment.providerStatus,
        externalPaymentId: payment.externalPaymentId,
        transitionedAt: payment.occurredAt,
        effectTypes: null,
      });
    },

    getTransaction(transactionId) {
      return repository.findTransactionById(transactionId);
    },
  };
}

function isOrderPaid(order: ManualPaymentOrderRecord): boolean {
  return order.paymentConfirmedAt !== null ||
    PAID_ORDER_STATUSES.has(order.paymentStatus?.trim().toLowerCase() ?? "");
}

function manualFingerprint(orderId: string, paymentMethod: PaymentMethod): string {
  return createHash("sha256")
    .update(JSON.stringify({ orderId, paymentMethod, provider: "manual" }))
    .digest("hex");
}

export function createManualPaymentService({
  repository,
  paymentService,
  ownershipLookup,
}: ManualPaymentServiceDependencies): ManualPaymentService {
  const assertRestaurantAccess = createRestaurantAccessChecker(ownershipLookup);

  return {
    async confirm(input) {
      if (input.authRole !== "authenticated") {
        throw new AppError(403, "forbidden", "Forbidden");
      }

      const order = await repository.findOrderForManualPayment(input.orderId);
      if (!order) {
        throw new AppError(404, "order_not_found", "Order not found");
      }

      await assertRestaurantAccess({
        userId: input.userId,
        restaurantId: order.restaurantId,
      });

      if (isOrderPaid(order)) {
        throw new AppError(409, "order_already_paid", "Order is already paid");
      }

      const normalizedAmount = Number(order.totalPrice);
      if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new AppError(409, "order_not_payable", "Order does not have a payable total");
      }

      try {
        const transaction = await paymentService.startPayment({
          restaurantId: order.restaurantId,
          orderId: order.id,
          provider: "manual",
          environment: "production",
          amount: { amount: normalizedAmount.toFixed(2), currency: "BRL" },
          paymentMethod: input.paymentMethod,
          processingMode: "manual",
          description: order.displayId === null ? `Pedido ${order.id}` : `Pedido ${order.displayId}`,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: manualFingerprint(order.id, input.paymentMethod),
          confirmedByUserId: input.userId,
          returnUrls: null,
        });

        if (transaction.status !== "paid") {
          throw new AppError(409, "payment_processing", "Payment confirmation is still processing");
        }
        return transaction;
      } catch (error) {
        if (
          error instanceof PaymentTransactionConflictError ||
          error instanceof PaymentIdempotencyConflictError ||
          error instanceof PaymentProviderNotFoundError
        ) {
          throw new AppError(409, "payment_conflict", "Payment confirmation conflicts with another request");
        }
        throw error;
      }
    },
  };
}

export function registerPaymentModule(
  app: FastifyInstance,
  config: AppConfig,
  providers: readonly PaymentProvider[] = [],
): PaymentModule {
  const registry = createPaymentProviderRegistry(providers);
  const repository = createPaymentRepository(createSupabaseAdminClient(config));
  const service = createPaymentService(registry, repository);
  const module = { registry, repository, service };

  app.decorate("payments", module);
  return module;
}
