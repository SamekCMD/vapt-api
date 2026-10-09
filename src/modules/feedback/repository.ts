import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { OrderFeedbackDto } from "../business/contracts.js";

export type UpsertOrderFeedbackInput = {
  orderId: string;
  restaurantId: string;
  rating: number;
  reasons: string[];
  comment: string | null;
};

export interface FeedbackRepository {
  upsertOrderFeedback(input: UpsertOrderFeedbackInput): Promise<OrderFeedbackDto>;
}

type FeedbackRow = {
  order_id: string;
  restaurant_id: string;
  rating: number;
  reasons: string[] | null;
  comment: string | null;
  created_at: string | Date;
};

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function createFeedbackRepository(database: Queryable): FeedbackRepository {
  return {
    async upsertOrderFeedback(input) {
      try {
        const result = await database.query<FeedbackRow>(
          `insert into public.order_feedback
            (order_id, restaurant_id, rating, reasons, comment)
          values ($1::uuid, $2::uuid, $3::integer, $4::text[], $5::text)
          on conflict (order_id) do update
          set restaurant_id = excluded.restaurant_id,
              rating = excluded.rating,
              reasons = excluded.reasons,
              comment = excluded.comment
          returning order_id, restaurant_id, rating, reasons, comment, created_at`,
          [
            input.orderId,
            input.restaurantId,
            input.rating,
            input.reasons,
            input.comment,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("missing feedback row");
        return {
          orderId: row.order_id,
          restaurantId: row.restaurant_id,
          rating: row.rating,
          reasons: Array.isArray(row.reasons) ? row.reasons : [],
          comment: row.comment,
          createdAt: isoString(row.created_at),
        };
      } catch {
        throw new AppError(500, "internal_error", "Failed to persist order feedback");
      }
    },
  };
}
