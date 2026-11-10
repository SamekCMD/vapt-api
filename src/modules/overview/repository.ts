import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import type { RestaurantScope } from '../tenancy/contracts.js';
import { authorizeRestaurant,resolveLegacyRestaurant } from '../tenancy/authorization.js';
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
  getOverview(scope:RestaurantScope,periodStart:Date):Promise<OwnedOverviewData|null>;
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
  const repository:OverviewRepository = {
    async getOverview(scope, periodStart) {
      try {
        await authorizeRestaurant(database,scope,'restaurant.read');
        const restaurantResult = await database.query<RestaurantRow>(
          `select
            restaurant.id,
            restaurant.name,
            restaurant.payment_mode,
            restaurant.onboarding_completed,
            restaurant.delivery_enabled
          from public.restaurants as restaurant
          where restaurant.id = $1::uuid and exists(select 1 from public.organization_members member where member.organization_id=restaurant.organization_id and member.user_id=$2::uuid and member.status='active')`,
          [scope.restaurantId,scope.userId],
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
            where restaurant.id = $1::uuid and exists(select 1 from public.organization_members member where member.organization_id=restaurant.organization_id and member.user_id=$3::uuid and member.status='active')
              and order_row.created_at >= $2::timestamptz
            group by order_row.id
            order by order_row.created_at asc, order_row.id asc`,
            [scope.restaurantId, periodStart,scope.userId],
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
            where restaurant.id = $1::uuid and exists(select 1 from public.organization_members member where member.organization_id=restaurant.organization_id and member.user_id=$3::uuid and member.status='active')
              and feedback.created_at >= $2::timestamptz
            order by feedback.created_at asc, feedback.order_id asc`,
            [scope.restaurantId, periodStart,scope.userId],
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
      } catch(error) {
        if(error instanceof AppError) throw error;
        throw storageFailure();
      }
    },
    async getOwnedOverview(userId,periodStart) { return repository.getOverview(await resolveLegacyRestaurant(database,userId),periodStart); },
  };
  return repository;
}
