import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import type { PaymentProvider } from "./provider.js";
import {
  PaymentTransactionConflictError,
  createPaymentRepository,
  type PaymentProviderAccountRecord,
  type PaymentRepository,
  type PaymentTransactionRecord,
} from "./repository.js";
import {
  createPaymentProviderRegistry,
  type PaymentProviderRegistry,
} from "./registry.js";
import { assertPaymentTransition } from "./state-machine.js";
import type { NormalizedPayment, PaymentEnvironment, StartPaymentInput } from "./types.js";

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
