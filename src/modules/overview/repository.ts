import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type {
  OrderFeedbackDto,
  OverviewOrderDto,
  OverviewOrderItemDto,
  OverviewRestaurantDto,
} from "../business/contracts.js";

export type OwnedOverviewData = {
  restaurant: OverviewRestaurantDto;
  orders: OverviewOrderDto[];
  feedback: OrderFeedbackDto[];
};

export interface OverviewRepository {
  getOwnedOverview(userId: string, periodStart: Date): Promise<OwnedOverviewData | null>;
}

type RestaurantRow = {
  id: string;
  name: string;
  payment_mode: "open_tab" | "prepaid";
  onboarding_completed: boolean;
  delivery_enabled: boolean;
};

type OrderRow = {
  id: string;
  display_id: string | number | null;
  total_price: string | number;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
  items: OverviewOrderItemDto[] | null;
};

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

function decimalString(value: string | number): string {
  return typeof value === "string" ? value : value.toFixed(2);
}

function storageFailure(): AppError {
  return new AppError(500, "internal_error", "Failed to load overview data");
}

export function createOverviewRepository(database: Database): OverviewRepository {
  return {
    async getOwnedOverview(userId, periodStart) {
      try {
        const restaurantResult = await database.query<RestaurantRow>(
          `select
            restaurant.id,
            restaurant.name,
            restaurant.payment_mode,
            restaurant.onboarding_completed,
            restaurant.delivery_enabled
          from public.restaurants as restaurant
          where restaurant.owner_id = $1::uuid
          limit 1`,
          [userId],
        );
        const restaurant = restaurantResult.rows[0];
        if (!restaurant) return null;

        const [ordersResult, feedbackResult] = await Promise.all([
          database.query<OrderRow>(
            `select
              order_row.id,
              order_row.display_id,
              order_row.total_price,
              order_row.status,
              order_row.created_at,
              order_row.updated_at,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'productName', order_item.product_name,
                    'quantity', order_item.quantity,
                    'unitPrice', order_item.unit_price::text
                  )
                  order by order_item.created_at asc, order_item.id asc
                ) filter (where order_item.id is not null),
                '[]'::jsonb
              ) as items
            from public.orders as order_row
            join public.restaurants as restaurant
              on restaurant.id = order_row.restaurant_id
            left join public.order_items as order_item
              on order_item.order_id = order_row.id
            where restaurant.owner_id = $1::uuid
              and order_row.created_at >= $2::timestamptz
            group by order_row.id
            order by order_row.created_at asc, order_row.id asc`,
            [userId, periodStart],
          ),
          database.query<FeedbackRow>(
            `select
              feedback.order_id,
              feedback.restaurant_id,
              feedback.rating,
              feedback.reasons,
              feedback.comment,
              feedback.created_at
            from public.order_feedback as feedback
            join public.restaurants as restaurant
              on restaurant.id = feedback.restaurant_id
            where restaurant.owner_id = $1::uuid
              and feedback.created_at >= $2::timestamptz
            order by feedback.created_at asc, feedback.order_id asc`,
            [userId, periodStart],
          ),
        ]);

        return {
          restaurant: {
            id: restaurant.id,
            name: restaurant.name,
            paymentMode: restaurant.payment_mode,
            onboardingCompleted: restaurant.onboarding_completed,
            deliveryEnabled: restaurant.delivery_enabled,
          },
          orders: ordersResult.rows.map((order) => ({
            id: order.id,
            displayId: order.display_id === null ? null : String(order.display_id),
            totalPrice: decimalString(order.total_price),
            status: order.status,
            createdAt: isoString(order.created_at),
            updatedAt: isoString(order.updated_at),
            items: Array.isArray(order.items) ? order.items : [],
          })),
          feedback: feedbackResult.rows.map((feedback) => ({
            orderId: feedback.order_id,
            restaurantId: feedback.restaurant_id,
            rating: feedback.rating,
            reasons: Array.isArray(feedback.reasons) ? feedback.reasons : [],
            comment: feedback.comment,
            createdAt: isoString(feedback.created_at),
          })),
        };
      } catch {
        throw storageFailure();
      }
    },
  };
}
