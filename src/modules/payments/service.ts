import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import type { OrderService } from "../orders/service.js";
import { createRestaurantAccessChecker, type OwnershipLookup } from "../../lib/permissions.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import type { PaymentProvider } from "./provider.js";
import type { MercadoPagoPaymentClient } from "./providers/mercado-pago/payment-client.js";
import type {
  MercadoPagoCheckoutClient,
  MercadoPagoPersistedPreferenceDiagnostics,
} from "./providers/mercado-pago/client.js";
import { createPaymentEffectProcessor, type PaymentEffectProcessor } from "./effects.js";
import {
  createPaymentEffectReconciliation,
  type PaymentEffectReconciliation,
} from "./reconciliation.js";
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
  CreatePaymentResult,
  NormalizedPayment,
  PaymentEnvironment,
  PaymentMethod,
  PaymentReturnUrls,
  PaymentStatus,
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

export type StartHostedCheckoutInput = {
  orderId: string;
  publicOrderToken: string;
  idempotencyKey: string;
};

export interface HostedCheckoutService {
  start(input: StartHostedCheckoutInput): Promise<PaymentTransactionRecord>;
}

export type MercadoPagoPaymentDiagnostics = {
  transactionId: string;
  transactionStatus: PaymentStatus;
  found: boolean;
  preference: MercadoPagoPersistedPreferenceDiagnostics | null;
  attempt: {
    paymentId: string;
    status: string;
    statusDetail: string;
    paymentMethodId: string | null;
    amount: string;
    currency: string;
    collectorId: string;
    dateLastUpdated: string | null;
  } | null;
};

export interface MercadoPagoPaymentDiagnosticsService {
  inspect(input: {
    orderId: string;
    transactionId: string;
    publicOrderToken: string;
  }): Promise<MercadoPagoPaymentDiagnostics>;
}

type HostedCheckoutServiceDependencies = {
  orderService: Pick<OrderService, "getPublicOrder">;
  paymentService: PaymentService;
  environment: PaymentEnvironment;
  returnUrls: PaymentReturnUrls;
};

type MercadoPagoPaymentDiagnosticsDependencies = {
  orderService: Pick<OrderService, "getPublicOrder">;
  paymentService: Pick<PaymentService, "getTransaction">;
  resolveAccessToken(input: {
    providerAccountId: string;
    restaurantId: string;
  }): Promise<string>;
  resolvePreferenceAccessToken(): Promise<string>;
  paymentClient: Pick<MercadoPagoPaymentClient, "searchPayments">;
  checkoutClient: Pick<MercadoPagoCheckoutClient, "getPreference">;
};

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

function extractProviderStatusCode(message: string): number | null {
  const match = message.match(/\bstatus (\d{3})\b/i);
  if (!match) return null;

  const statusCode = Number(match[1]);
  return statusCode >= 400 && statusCode <= 599 ? statusCode : null;
}

function optionalDiagnosticString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCreatedPreferenceDiagnostics(
  providerPayload: Record<string, unknown>,
  preferenceId: string | null,
) {
  const rawDiagnostics = providerPayload.checkoutDiagnostics;
  if (!preferenceId || !rawDiagnostics || typeof rawDiagnostics !== "object" || Array.isArray(rawDiagnostics)) {
    return null;
  }

  const diagnostics = rawDiagnostics as Record<string, unknown>;
  return {
    preferenceId,
    collectorId: optionalDiagnosticString(diagnostics.collectorId),
    clientId: optionalDiagnosticString(diagnostics.clientId),
    marketplace: optionalDiagnosticString(diagnostics.marketplace),
    siteId: optionalDiagnosticString(diagnostics.siteId),
    operationType: optionalDiagnosticString(diagnostics.operationType),
    checkoutHost: optionalDiagnosticString(diagnostics.checkoutHost),
    sandboxCheckoutHost: optionalDiagnosticString(diagnostics.sandboxCheckoutHost),
  };
}

export type PaymentModule = {
  registry: PaymentProviderRegistry;
  repository: PaymentRepository;
  service: PaymentService;
  effects: PaymentEffectProcessor;
  reconciliation: PaymentEffectReconciliation;
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

      let payment: CreatePaymentResult;
      try {
        payment = await provider.createPayment({
          transactionId: transaction.id,
          restaurantId: transaction.restaurantId,
          orderId: transaction.orderId,
          providerAccountId: transaction.providerAccountId,
          environment: input.environment,
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
          checkoutUrl: null,
          expiresAt: null,
          providerPayload: {},
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
        checkoutUrl: payment.checkoutUrl?.toString() ?? null,
        expiresAt: payment.expiresAt,
        providerPayload: payment.metadata,
        effectTypes:
          payment.status === "paid" ? ["release_order_to_kitchen"] : null,
      });
    },

    getTransaction(transactionId) {
      return repository.findTransactionById(transactionId);
    },
  };
}

function hostedCheckoutFingerprint(
  orderId: string,
  amount: string,
  environment: PaymentEnvironment,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      orderId,
      provider: "mercado_pago",
      amount,
      currency: "BRL",
      environment,
    }))
    .digest("hex");
}

export function createHostedCheckoutService({
  orderService,
  paymentService,
  environment,
  returnUrls,
}: HostedCheckoutServiceDependencies): HostedCheckoutService {
  return {
    async start(input) {
      const order = await orderService.getPublicOrder(input.orderId, input.publicOrderToken);
      if (
        PAID_ORDER_STATUSES.has(order.paymentStatus?.trim().toLowerCase() ?? "")
      ) {
        throw new AppError(409, "order_already_paid", "Order is already paid");
      }

      const amount = Number(order.totalPrice);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new AppError(409, "order_not_payable", "Order does not have a payable total");
      }
      const normalizedAmount = amount.toFixed(2);
      const transaction = await paymentService.startPayment({
        restaurantId: order.restaurantId,
        orderId: order.orderId,
        provider: "mercado_pago",
        environment,
        amount: { amount: normalizedAmount, currency: "BRL" },
        paymentMethod: null,
        processingMode: "online",
        description: order.displayId === null ? `Pedido ${order.orderId}` : `Pedido ${order.displayId}`,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: hostedCheckoutFingerprint(order.orderId, normalizedAmount, environment),
        returnUrls,
      });

      if (!transaction.checkoutUrl) {
        throw new AppError(502, "checkout_unavailable", "Checkout is not available");
      }
      return transaction;
    },
  };
}

export function createMercadoPagoPaymentDiagnosticsService({
  orderService,
  paymentService,
  resolveAccessToken,
  resolvePreferenceAccessToken,
  paymentClient,
  checkoutClient,
}: MercadoPagoPaymentDiagnosticsDependencies): MercadoPagoPaymentDiagnosticsService {
  return {
    async inspect(input) {
      const order = await orderService.getPublicOrder(input.orderId, input.publicOrderToken);
      const transaction = await paymentService.getTransaction(input.transactionId);
      if (
        !transaction ||
        transaction.orderId !== order.orderId ||
        transaction.restaurantId !== order.restaurantId ||
        transaction.provider !== "mercado_pago" ||
        !transaction.providerAccountId
      ) {
        throw new AppError(404, "not_found", "Payment transaction not found");
      }

      const accessToken = await resolveAccessToken({
        providerAccountId: transaction.providerAccountId,
        restaurantId: transaction.restaurantId,
      });
      const payments = await paymentClient.searchPayments({
        accessToken,
        externalReference: transaction.id,
      });
      const attempt = payments.find(
        (payment) => payment.externalReference === transaction.id,
      ) ?? null;
      const preferenceId = typeof transaction.providerPayload.preferenceId === "string"
        ? transaction.providerPayload.preferenceId
        : null;
      const createdPreference = readCreatedPreferenceDiagnostics(
        transaction.providerPayload,
        preferenceId,
      );
      let preference = null;
      let preferenceLookup: "available" | "unavailable" | null = null;
      let preferenceLookupError: {
        code: string;
        statusCode: number;
        providerStatusCode?: number;
      } | null = null;
      if (preferenceId) {
        try {
          const preferenceAccessToken = await resolvePreferenceAccessToken();
          preference = await checkoutClient.getPreference({
            accessToken: preferenceAccessToken,
            preferenceId,
          });
          preferenceLookup = "available";
        } catch (error) {
          // A falha da preferência não deve ocultar a tentativa de pagamento.
          preferenceLookup = "unavailable";
          if (error instanceof AppError) {
            const providerStatusCode = extractProviderStatusCode(error.message);
            preferenceLookupError = {
              code: error.code,
              statusCode: error.statusCode,
              ...(providerStatusCode ? { providerStatusCode } : {}),
            };
          }
        }
      }

      return {
        transactionId: transaction.id,
        transactionStatus: transaction.status,
        found: attempt !== null,
        createdPreference,
        preference,
        ...(preferenceLookup === "unavailable" ? { preferenceLookup } : {}),
        ...(preferenceLookupError ? { preferenceLookupError } : {}),
        attempt: attempt
          ? {
              paymentId: attempt.id,
              status: attempt.status,
              statusDetail: attempt.statusDetail,
              paymentMethodId: attempt.paymentMethodId,
              amount: attempt.transactionAmount,
              currency: attempt.currency,
              collectorId: attempt.collectorId,
              dateLastUpdated: attempt.dateLastUpdated,
            }
          : null,
      };
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
  const effectsConfig = config.paymentEffects ?? {
    pollIntervalMs: 5_000,
    batchSize: 25,
    leaseMs: 60_000,
    maxAttempts: 5,
    retryBaseMs: 30_000,
  };
  const effects = createPaymentEffectProcessor({
    repository,
    workerId: "payment-effects-" + process.pid + "-" + randomUUID(),
    maxAttempts: effectsConfig.maxAttempts,
    leaseMs: effectsConfig.leaseMs,
    baseRetryDelayMs: effectsConfig.retryBaseMs,
  });
  const reconciliation = createPaymentEffectReconciliation({
    processor: effects,
    batchSize: effectsConfig.batchSize,
    pollIntervalMs: effectsConfig.pollIntervalMs,
    onError: (error) => app.log.error({ err: error }, "Payment effect reconciliation failed"),
  });
  const module = { registry, repository, service, effects, reconciliation };

  app.decorate("payments", module);
  app.addHook("onReady", () => {
    if (config.nodeEnv !== "test") reconciliation.start();
  });
  app.addHook("onClose", () => reconciliation.stop());
  return module;
}
