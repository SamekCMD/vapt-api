import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { PushSubscriptionBody } from "./schemas.js";

export type PushSubscriptionResult = {
  restaurantId: string;
  endpoint: string;
  status: "subscribed";
};

export interface PushSubscriptionRepository {
  upsertOwnedSubscription(
    userId: string,
    input: PushSubscriptionBody,
  ): Promise<PushSubscriptionResult>;
}

type PushSubscriptionRow = {
  restaurant_id: string;
  endpoint: string;
};

export function createPushSubscriptionRepository(
  database: Queryable,
): PushSubscriptionRepository {
  return {
    async upsertOwnedSubscription(userId, input) {
      try {
        const result = await database.query<PushSubscriptionRow>(
          `insert into public.push_subscriptions (
            restaurant_id,
            endpoint,
            subscription,
            origin,
            user_agent
          )
          select
            r.id,
            $2::text,
            $3::jsonb,
            $4::text,
            $5::text
          from public.restaurants r
          where r.owner_id = $1::uuid
          order by r.created_at asc, r.id asc
          limit 1
          on conflict (endpoint) do update
          set subscription = excluded.subscription,
              origin = excluded.origin,
              user_agent = excluded.user_agent,
              updated_at = now()
          where public.push_subscriptions.restaurant_id = excluded.restaurant_id
          returning restaurant_id, endpoint`,
          [
            userId,
            input.endpoint,
            input.subscription,
            input.origin,
            input.user_agent,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          throw new AppError(
            409,
            "push_subscription_conflict",
            "Push subscription could not be associated with the owned restaurant",
          );
        }
        return {
          restaurantId: row.restaurant_id,
          endpoint: row.endpoint,
          status: "subscribed",
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(500, "internal_error", "Failed to persist push subscription");
      }
    },
  };
}
