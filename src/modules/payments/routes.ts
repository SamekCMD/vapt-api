import type { FastifyInstance, FastifyReply } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import {
  testOwnershipLookup,
  type OwnershipLookup,
} from "../../lib/permissions.js";
import { validateWithSchema } from "../../lib/validation.js";
import type { OrderRepository } from "../orders/repository.js";
import { createOrderService } from "../orders/service.js";
import { requireAuth } from "../../plugins/auth.js";
import {
  createMercadoPagoBrowserReturnUrl,
  createMercadoPagoReturnUrls,
  queryStringValue,
} from "./return-urls.js";
import {
  hostedCheckoutBodySchema,
  hostedCheckoutHeadersSchema,
  hostedCheckoutParamsSchema,
  manualPaymentBodySchema,
  manualPaymentHeadersSchema,
  manualPaymentParamsSchema,
  paymentDiagnosticsHeadersSchema,
  paymentDiagnosticsParamsSchema,
} from "./schemas.js";
import {
  createHostedCheckoutService,
  createManualPaymentService,
  type HostedCheckoutService,
  type ManualPaymentService,
  type MercadoPagoReturnReconciliationService,
} from "./service.js";

export type MercadoPagoPaymentDiagnosticsService = {
  inspect(input: {
    orderId: string;
    transactionId: string;
    publicOrderToken: string;
  }): Promise<Readonly<Record<string, unknown>>>;
};

export { createMercadoPagoReturnUrls } from "./return-urls.js";

export async function registerMercadoPagoReturnRoutes(
  app: FastifyInstance,
  config: AppConfig,
  reconciliationService?: MercadoPagoReturnReconciliationService,
) {
  if (!config.frontendUrl) {
    throw new AppError(503, "mercado_pago_not_configured", "Mercado Pago frontend return is not configured");
  }

  app.get(
    "/payments/mercado-pago/return",
    async (request, reply: FastifyReply) => {
      const query = request.query as Record<string, unknown>;
      const requestedResult = queryStringValue(query.result);
      let result: "success" | "pending" | "failure" = requestedResult === "success" || requestedResult === "pending"
        ? requestedResult
        : "failure";
      const paymentId = queryStringValue(query.payment_id);
      const externalReference = queryStringValue(query.external_reference);

      if (reconciliationService && paymentId && externalReference) {
        try {
          const transaction = await reconciliationService.reconcile({
            transactionId: externalReference,
            paymentId,
          });
          result = transaction.status === "paid"
            ? "success"
            : transaction.status === "pending" || transaction.status === "processing"
              ? "pending"
              : "failure";
          request.log.info({
            transactionId: transaction.id,
            transactionStatus: transaction.status,
            paymentId,
          }, "Mercado Pago browser return reconciled");
        } catch (error) {
          result = "pending";
          request.log.error({ err: error, paymentId, externalReference },
            "Mercado Pago browser return reconciliation failed");
        }
      }

      const destination = createMercadoPagoBrowserReturnUrl(config, query, result);

      request.log.info({
        result,
        paymentId: destination.searchParams.get("payment_id"),
        status: destination.searchParams.get("status"),
        externalReference: destination.searchParams.get("external_reference"),
        preferenceId: destination.searchParams.get("preference_id"),
      }, "Mercado Pago browser returned from checkout");

      return reply.redirect(destination.toString());
    },
  );
}

export async function createManualPaymentRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service?: ManualPaymentService,
  ownershipLookup?: OwnershipLookup,
) {
  const resolvedService = service ?? createManualPaymentService({
    repository: app.payments.repository,
    paymentService: app.payments.service,
    ownershipLookup: config.nodeEnv === "test"
      ? testOwnershipLookup
      : ownershipLookup ?? (() => {
          throw new AppError(500, "internal_error", "Ownership lookup is not configured");
        })(),
  });

  app.post(
    "/orders/:orderId/payments/manual-confirmation",
    {
      config: { rateLimitGroup: "billing" },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      const params = validateWithSchema(manualPaymentParamsSchema, request.params);
      const headers = validateWithSchema(manualPaymentHeadersSchema, request.headers);
      const body = validateWithSchema(manualPaymentBodySchema, request.body);
      const auth = request.auth!;
      const transaction = await resolvedService.confirm({
        orderId: params.orderId,
        paymentMethod: body.paymentMethod,
        idempotencyKey: headers["idempotency-key"],
        userId: auth.userId,
        authRole: auth.role,
      });

      return {
        transactionId: transaction.id,
        orderId: transaction.orderId,
        status: transaction.status,
        amount: transaction.amount,
        paymentMethod: transaction.paymentMethod,
        confirmedAt: transaction.updatedAt,
      };
    },
  );
}

export async function registerHostedCheckoutRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service?: HostedCheckoutService,
  orderRepository?: OrderRepository,
) {
  if (!config.mercadoPago || !config.frontendUrl || !config.apiPublicUrl) {
    throw new AppError(
      503,
      "mercado_pago_not_configured",
      "Mercado Pago checkout is not configured",
    );
  }
  const mercadoPago = config.mercadoPago;

  const orderService = service
    ? null
    : createOrderService(
      orderRepository ?? (() => {
        throw new AppError(500, "internal_error", "Order repository is not configured");
      })(),
      config.security.publicOrderTokenSecret,
    );

  app.post(
    "/public/orders/:orderId/payments/checkout",
    { config: { rateLimitGroup: "billing" } },
    async (request) => {
      const params = validateWithSchema(hostedCheckoutParamsSchema, request.params);
      const headers = validateWithSchema(hostedCheckoutHeadersSchema, request.headers);
      const body = validateWithSchema(hostedCheckoutBodySchema, request.body ?? {});
      const resolvedService = service ?? createHostedCheckoutService({
        orderService: orderService!,
        paymentService: app.payments.service,
        environment: mercadoPago.environment,
        returnUrls: createMercadoPagoReturnUrls(config, body.returnOrigin),
      });
      const transaction = await resolvedService.start({
        orderId: params.orderId,
        publicOrderToken: headers["x-vapt-order-token"],
        idempotencyKey: headers["idempotency-key"],
      });

      request.log.info({
        transactionId: transaction.id,
        orderId: transaction.orderId,
        preferenceId: transaction.providerPayload.preferenceId ?? null,
        checkoutDiagnostics: transaction.providerPayload.checkoutDiagnostics ?? null,
      }, "Mercado Pago hosted checkout created");

      return {
        transactionId: transaction.id,
        orderId: transaction.orderId,
        status: transaction.status,
        amount: transaction.amount,
        checkoutUrl: transaction.checkoutUrl,
        expiresAt: transaction.expiresAt,
        ...(config.mercadoPago?.environment === "sandbox"
          ? { diagnostics: transaction.providerPayload.checkoutDiagnostics ?? null }
          : {}),
      };
    },
  );
}

export async function registerMercadoPagoDiagnosticsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: MercadoPagoPaymentDiagnosticsService,
) {
  if (config.mercadoPago?.environment !== "sandbox") return;

  app.get(
    "/public/orders/:orderId/payments/:transactionId/diagnostics",
    { config: { rateLimitGroup: "billing" } },
    async (request) => {
      const params = validateWithSchema(paymentDiagnosticsParamsSchema, request.params);
      const headers = validateWithSchema(paymentDiagnosticsHeadersSchema, request.headers);
      return service.inspect({
        orderId: params.orderId,
        transactionId: params.transactionId,
        publicOrderToken: headers["x-vapt-order-token"],
      });
    },
  );
}
