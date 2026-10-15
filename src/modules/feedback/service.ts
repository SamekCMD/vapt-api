import { AppError } from "../../lib/errors.js";
import type { OrderService } from "../orders/service.js";
import type { FeedbackRepository } from "./repository.js";
import type { FeedbackBody } from "./schemas.js";

export function createFeedbackService(
  repository: FeedbackRepository,
  publicOrders: Pick<OrderService, "getPublicOrder">,
) {
  return {
    async submitOrderFeedback(orderId: string, publicToken: string, body: FeedbackBody) {
      let order;
      try {
        order = await publicOrders.getPublicOrder(orderId, publicToken);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) {
          throw new AppError(401, "invalid_order_token", "Invalid order token");
        }
        throw error;
      }
      return repository.upsertOrderFeedback({
        orderId: order.orderId,
        restaurantId: order.restaurantId,
        rating: body.rating,
        reasons: body.reasons,
        comment: body.comment,
      });
    },
  };
}
