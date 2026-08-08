import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import { AppError } from "../../lib/errors.js";
import {
  createSupabaseOwnershipLookup,
  testOwnershipLookup,
} from "../../lib/permissions.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import { validateWithSchema } from "../../lib/validation.js";
import { createOrderRepository } from "../orders/repository.js";
import { createOrderService } from "../orders/service.js";
import { requireAuth } from "../../plugins/auth.js";
import {
  hostedCheckoutBodySchema,
  hostedCheckoutHeadersSchema,
  hostedCheckoutParamsSchema,
  manualPaymentBodySchema,
  manualPaymentHeadersSchema,
  manualPaymentParamsSchema,
} from "./schemas.js";
import {
  createHostedCheckoutService,
  createManualPaymentService,
  type HostedCheckoutService,
  type ManualPaymentService,
} from "./service.js";

export async function createManualPaymentRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service?: ManualPaymentService,
) {
  const resolvedService = service ?? createManualPaymentService({
    repository: app.payments.repository,
    paymentService: app.payments.service,
    ownershipLookup: config.nodeEnv === "test"
      ? testOwnershipLookup
      : createSupabaseOwnershipLookup(createSupabaseAdminClient(config) as never),
  });

  app.post(
    "/orders/:orderId/payments/manual-confirmation",
    {
      config: { rateLimitGroup: "billing" },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
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
) {
  if (!config.mercadoPago || !config.frontendUrl) {
    throw new AppError(
      503,
      "mercado_pago_not_configured",
      "Mercado Pago checkout is not configured",
    );
  }

  const supabase = service ? null : createSupabaseAdminClient(config);
  const resolvedService = service ?? createHostedCheckoutService({
    orderService: createOrderService(
      createOrderRepository(supabase!),
      config.supabase.jwtSecret,
    ),
    paymentService: app.payments.service,
    environment: config.mercadoPago.environment,
    returnUrls: {
      success: new URL("/payment/return?result=success", config.frontendUrl),
      pending: new URL("/payment/return?result=pending", config.frontendUrl),
      failure: new URL("/payment/return?result=failure", config.frontendUrl),
    },
  });

  app.post(
    "/public/orders/:orderId/payments/checkout",
    { config: { rateLimitGroup: "billing" } },
    async (request) => {
      const params = validateWithSchema(hostedCheckoutParamsSchema, request.params);
      const headers = validateWithSchema(hostedCheckoutHeadersSchema, request.headers);
      validateWithSchema(hostedCheckoutBodySchema, request.body ?? {});
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
      };
    },
  );
}
