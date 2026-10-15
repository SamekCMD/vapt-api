import type { FastifyInstance } from "fastify";

import { validateWithSchema } from "../../lib/validation.js";
import { requireAuth } from "../../plugins/auth.js";
import type { FeedbackRepository } from "../feedback/repository.js";
import { requireOrderToken } from "../feedback/routes.js";
import { createFeedbackService } from "../feedback/service.js";
import type { OrderService } from "../orders/service.js";
import type { PushSubscriptionRepository } from "./repository.js";
import { orderFeedbackBodySchema, pushSubscriptionBodySchema } from "./schemas.js";

export type IngestRouteDependencies = {
  pushSubscriptions: PushSubscriptionRepository;
  feedbackRepository: FeedbackRepository;
  publicOrders: Pick<OrderService, "getPublicOrder">;
};

export async function registerIngestRoutes(
  app: FastifyInstance,
  dependencies: IngestRouteDependencies,
) {
  const feedback = createFeedbackService(
    dependencies.feedbackRepository,
    dependencies.publicOrders,
  );

  app.post(
    "/ingest/order-feedback",
    {
      config: {
        rateLimitGroup: "billing",
      },
    },
    async (request) => {
      const body = validateWithSchema(orderFeedbackBodySchema, request.body);
      const token = requireOrderToken(request.headers);
      return feedback.submitOrderFeedback(body.order_id, token, {
        rating: body.rating,
        reasons: body.reasons,
        comment: body.comment,
      });
    },
  );

  app.post(
    "/ingest/push-subscription",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      const body = validateWithSchema(pushSubscriptionBodySchema, request.body);
      return dependencies.pushSubscriptions.upsertOwnedSubscription(
        request.auth!.userId,
        body,
      );
    },
  );
}
