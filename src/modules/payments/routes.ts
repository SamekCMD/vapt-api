import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import {
  createSupabaseOwnershipLookup,
  testOwnershipLookup,
} from "../../lib/permissions.js";
import { createSupabaseAdminClient } from "../../lib/supabase.js";
import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import {
  manualPaymentBodySchema,
  manualPaymentHeadersSchema,
  manualPaymentParamsSchema,
} from "./schemas.js";
import {
  createManualPaymentService,
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
