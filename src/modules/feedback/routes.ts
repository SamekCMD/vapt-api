import type { FastifyInstance } from "fastify";

import { validateWithSchema } from "../../lib/validation.js";
import type { OrderService } from "../orders/service.js";
import type { FeedbackRepository } from "./repository.js";
import { feedbackBodySchema, feedbackParamsSchema } from "./schemas.js";
import { createFeedbackService } from "./service.js";
import { requireOrderToken } from "./token.js";

export { requireOrderToken } from "./token.js";

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
