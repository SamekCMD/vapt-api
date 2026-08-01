import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../lib/config.js";
import type { PaymentEffectReconciliation } from "./reconciliation.js";

function validAdminSecret(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function registerPaymentEffectRoutes(
  app: FastifyInstance,
  config: AppConfig,
  reconciliation: PaymentEffectReconciliation = app.payments.reconciliation,
) {
  app.post(
    "/admin/payments/effects/reprocess",
    { config: { rateLimitGroup: "billing" } },
    async (request, reply) => {
      if (!validAdminSecret(request.headers["x-vapt-admin-key"], config.n8n.secrets.admin)) {
        return reply.code(401).send({
          error: { code: "unauthorized", message: "Unauthorized" },
        });
      }

      const payload = request.body as { limit?: unknown } | null;
      const requestedLimit = payload?.limit;
      if (
        requestedLimit !== undefined &&
        (!Number.isInteger(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > 100)
      ) {
        return reply.code(400).send({
          error: { code: "invalid_request", message: "Limit must be an integer from 1 to 100" },
        });
      }

      return reconciliation.runOnce(requestedLimit === undefined ? undefined : Number(requestedLimit));
    },
  );
}
