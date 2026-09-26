import type { FastifyInstance } from "fastify";

import { AppError } from "../../lib/errors.js";
import { validateWithSchema } from "../../lib/validation.js";
import type { OrderService } from "../orders/service.js";
import type { FeedbackRepository } from "./repository.js";
import { feedbackBodySchema, feedbackParamsSchema } from "./schemas.js";
import { createFeedbackService } from "./service.js";

export function requireOrderToken(headers: Record<string, unknown>): string {
  const token = headers["x-vapt-order-token"];
  if (typeof token !== "string" || token.trim().length < 32 || token.length > 256) {
    throw new AppError(401, "invalid_order_token", "Invalid order token");
  }
  return token.trim();
}

export async function registerFeedbackRoutes(
  app: FastifyInstance,
  repository: FeedbackRepository,
  publicOrders: Pick<OrderService, "getPublicOrder">,
) {
  const service = createFeedbackService(repository, publicOrders);

  app.put(
    "/public/orders/:orderId/feedback",
    { config: { rateLimitGroup: "orders" } },
    async (request) => {
      const params = validateWithSchema(feedbackParamsSchema, request.params);
      const body = validateWithSchema(feedbackBodySchema, request.body);
      const token = requireOrderToken(request.headers);
      return service.submitOrderFeedback(params.orderId, token, body);
    },
  );
}
