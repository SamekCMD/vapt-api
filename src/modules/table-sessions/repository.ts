import type { Database, Queryable } from "../../lib/database.js";
import { withTransaction } from "../../lib/database.js";
import { emitCommittedChange, requireManagedObserverPool, type CommittedChangeOptions } from "../realtime/committed-changes.js";
import type { CommittedChange } from "../realtime/contracts.js";
import { AppError } from "../../lib/errors.js";
import type {
  CloseTableSessionDto,
  RequestCheckTableSessionDto,
  TableSessionDetailDto,
  TableSessionOrderDto,
  TableSessionOrderItemDto,
  TableSessionStatus,
  TableSessionSummaryDto,
  TransferTableSessionDto,
} from "../business/contracts.js";

type TableSessionSummaryRow = {
  id: string;
  restaurant_id: string;
  table_number: string;
  status: TableSessionStatus;
  opened_at: string | Date;
  closed_at: string | Date | null;
  session_total: string | number;
  order_count: string | number;
};

type TableSessionOrderRow = {
  id: string;
  display_id: string | number | null;
  total_price: string | number;
  status: string;
  created_at: string | Date;
  payment_status: string | null;
  payment_confirmed_at: string | Date | null;
  items: TableSessionOrderItemDto[] | null;
};

type LockedSessionRow = {
  restaurant_id: string;
  status: TableSessionStatus;
  closed_at: string | Date | null;
  table_number: string;
};

export type TransferOwnedSessionResult = TransferTableSessionDto | "closed" | null;
export type RequestPublicCheckResult = RequestCheckTableSessionDto | "closed" | null;

export interface TableSessionRepository {
  listActiveOwnedSessions(userId: string): Promise<TableSessionSummaryDto[]>;
  getOwnedSession(userId: string, sessionId: string): Promise<TableSessionDetailDto | null>;
  closeOwnedSession(userId: string, sessionId: string): Promise<CloseTableSessionDto | null>;
  transferOwnedSession(
    userId: string,
    sessionId: string,
    tableNumber: string,
  ): Promise<TransferOwnedSessionResult>;
  requestPublicCheck(
    sessionId: string,
    orderId: string,
  ): Promise<RequestPublicCheckResult>;
}

const SUMMARY_SELECT = `
  session_row.id,
  session_row.restaurant_id,
  session_row.table_number,
  session_row.status,
  session_row.opened_at,
  session_row.closed_at,
  coalesce(sum(order_row.total_price), 0)::text as session_total,
  count(order_row.id)::int as order_count
`;

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIsoString(value: string | Date | null): string | null {
  return value === null ? null : isoString(value);
}

function decimalString(value: string | number): string {
  return typeof value === "string" ? value : value.toFixed(2);
}

function mapSummary(row: TableSessionSummaryRow): TableSessionSummaryDto {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    tableNumber: row.table_number,
    status: row.status,
    openedAt: isoString(row.opened_at),
    closedAt: nullableIsoString(row.closed_at),
    sessionTotal: decimalString(row.session_total),
    orderCount: Number(row.order_count),
  };
}

function mapOrder(row: TableSessionOrderRow): TableSessionOrderDto {
  return {
    id: row.id,
    displayId: row.display_id === null ? null : String(row.display_id),
    totalPrice: decimalString(row.total_price),
    status: row.status,
    createdAt: isoString(row.created_at),
    paymentStatus: row.payment_status,
    paymentConfirmedAt: nullableIsoString(row.payment_confirmed_at),
    items: Array.isArray(row.items) ? row.items : [],
  };
}

function storageFailure(): AppError {
  return new AppError(500, "internal_error", "Failed to persist table session data");
}

async function loadOwnedSummary(
  queryable: Queryable,
  userId: string,
  sessionId: string,
): Promise<TableSessionSummaryDto | null> {
  const result = await queryable.query<TableSessionSummaryRow>(
    `select ${SUMMARY_SELECT}
    from public.table_sessions as session_row
    join public.restaurants as restaurant
      on restaurant.id = session_row.restaurant_id
    left join public.orders as order_row
      on order_row.table_session_id = session_row.id
    where session_row.id = $1::uuid
      and restaurant.owner_id = $2::uuid
    group by session_row.id
    limit 1`,
    [sessionId, userId],
  );
  const row = result.rows[0];
  return row ? mapSummary(row) : null;
}

async function loadSessionOrders(
  queryable: Queryable,
  userId: string,
  sessionId: string,
): Promise<TableSessionOrderDto[]> {
  const result = await queryable.query<TableSessionOrderRow>(
    `select
      order_row.id,
      order_row.display_id,
      order_row.total_price,
      order_row.status,
      order_row.created_at,
      order_row.payment_status,
      order_row.payment_confirmed_at,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', order_item.id,
            'productName', order_item.product_name,
            'quantity', order_item.quantity,
            'unitPrice', order_item.unit_price::text,
            'notes', order_item.notes
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
    where order_row.table_session_id = $1::uuid
      and restaurant.owner_id = $2::uuid
    group by order_row.id
    order by order_row.created_at asc, order_row.id asc`,
    [sessionId, userId],
  );
  return result.rows.map(mapOrder);
}

async function lockOwnedSession(
  queryable: Queryable,
  userId: string,
  sessionId: string,
): Promise<LockedSessionRow | null> {
  const result = await queryable.query<LockedSessionRow>(
    `select session_row.status, session_row.closed_at, session_row.table_number, session_row.restaurant_id
    from public.table_sessions as session_row
    join public.restaurants as restaurant
      on restaurant.id = session_row.restaurant_id
    where session_row.id = $1::uuid
      and restaurant.owner_id = $2::uuid
    for update of session_row, restaurant`,
    [sessionId, userId],
  );
  return result.rows[0] ?? null;
}

export function createTableSessionRepository(database: Database, options: CommittedChangeOptions = {}): TableSessionRepository {
  requireManagedObserverPool(database, options);
  return {
    async listActiveOwnedSessions(userId) {
      try {
        const result = await database.query<TableSessionSummaryRow>(
          `select ${SUMMARY_SELECT}
          from public.table_sessions as session_row
          join public.restaurants as restaurant
            on restaurant.id = session_row.restaurant_id
          left join public.orders as order_row
            on order_row.table_session_id = session_row.id
          where restaurant.owner_id = $1::uuid
            and session_row.status in ('open', 'check_requested')
          group by session_row.id
          order by session_row.opened_at asc, session_row.id asc`,
          [userId],
        );
        return result.rows.map(mapSummary);
      } catch {
        throw storageFailure();
      }
    },

    async getOwnedSession(userId, sessionId) {
      try {
        const session = await loadOwnedSummary(database, userId, sessionId);
        if (!session) return null;
        return {
          session,
          orders: await loadSessionOrders(database, userId, sessionId),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw storageFailure();
      }
    },

    async closeOwnedSession(userId, sessionId) {
      try {
        let change: CommittedChange | undefined;
        const result = await withTransaction(database, async (client) => {
          const session = await lockOwnedSession(client, userId, sessionId);
          if (!session) return null;

          if (session.status === "closed") {
            const delivered = await client.query<{ id: string }>(
              `select order_row.id
              from public.orders as order_row
              join public.restaurants as restaurant
                on restaurant.id = order_row.restaurant_id
              where order_row.table_session_id = $1::uuid
                and restaurant.owner_id = $2::uuid
                and order_row.status = 'delivered'
              order by order_row.created_at asc, order_row.id asc`,
              [sessionId, userId],
            );
            if (!session.closed_at) throw storageFailure();
            return {
              sessionId,
              status: "closed" as const,
              closedAt: isoString(session.closed_at),
              deliveredOrderIds: delivered.rows.map((row) => row.id),
            };
          }

          const delivered = await client.query<{ id: string }>(
            `update public.orders as order_row
            set status = $1::text,
                updated_at = now()
            from public.restaurants as restaurant
            where order_row.table_session_id = $2::uuid
              and restaurant.id = order_row.restaurant_id
              and restaurant.owner_id = $3::uuid
              and order_row.status in ('pending', 'paid', 'preparing', 'ready', 'waiting_payment')
            returning order_row.id`,
            ["delivered", sessionId, userId],
          );
          const closed = await client.query<{ closed_at: string | Date }>(
            `update public.table_sessions as session_row
            set status = 'closed',
                closed_at = now()
            from public.restaurants as restaurant
            where session_row.id = $1::uuid
              and restaurant.id = session_row.restaurant_id
              and restaurant.owner_id = $2::uuid
            returning session_row.closed_at`,
            [sessionId, userId],
          );
          const closedAt = closed.rows[0]?.closed_at;
          if (!closedAt) throw storageFailure();
          change = { restaurantId: session.restaurant_id,
            topics: delivered.rows.length ? ["table_sessions", "orders", "kitchen"] : ["table_sessions"],
            orderIds: delivered.rows.map(row => row.id), entityId: sessionId, reason: "closed" };
          return {
            sessionId,
            status: "closed" as const,
            closedAt: isoString(closedAt),
            deliveredOrderIds: delivered.rows.map((row) => row.id),
          };
        });
        await emitCommittedChange(options, change);
        return result;
      } catch (error) {
        if (error instanceof AppError && error.code !== "internal_error") throw error;
        throw storageFailure();
      }
    },

    async transferOwnedSession(userId, sessionId, tableNumber) {
      try {
        let change: CommittedChange | undefined;
        const result = await withTransaction(database, async (client) => {
          const session = await lockOwnedSession(client, userId, sessionId);
          if (!session) return null;
          if (session.status === "closed") return "closed";

          if (session.table_number !== tableNumber) {
            const updatedSession = await client.query<{ id: string }>(
              `update public.table_sessions as session_row
              set table_number = $1::text
              from public.restaurants as restaurant
              where session_row.id = $2::uuid
                and restaurant.id = session_row.restaurant_id
                and restaurant.owner_id = $3::uuid
              returning session_row.id`,
              [tableNumber, sessionId, userId],
            );
            if (!updatedSession.rows[0]) throw storageFailure();
          }

          const updatedOrders = await client.query<{ id: string }>(
            `update public.orders as order_row
            set table_number = $1::text,
                updated_at = now()
            from public.restaurants as restaurant
            where order_row.table_session_id = $2::uuid
              and restaurant.id = order_row.restaurant_id
              and restaurant.owner_id = $3::uuid
              and order_row.table_number is distinct from $1::text
            returning order_row.id`,
            [tableNumber, sessionId, userId],
          );
          if (session.table_number !== tableNumber || updatedOrders.rows.length) change = {
            restaurantId: session.restaurant_id, topics: updatedOrders.rows.length ? ["table_sessions", "orders", "kitchen"] : ["table_sessions"],
            orderIds: updatedOrders.rows.map(row => row.id), entityId: sessionId, reason: "transferred",
          };
          return {
            sessionId,
            tableNumber,
            updatedOrderIds: updatedOrders.rows.map((row) => row.id),
          };
        });
        await emitCommittedChange(options, change);
        return result;
      } catch (error) {
        if (error instanceof AppError && error.code !== "internal_error") throw error;
        throw storageFailure();
      }
    },

    async requestPublicCheck(sessionId, orderId) {
      try {
        let change: CommittedChange | undefined;
        const result = await withTransaction(database, async (client) => {
          const locked = await client.query<{ status: TableSessionStatus; restaurant_id: string }>(
            `select session_row.status, session_row.restaurant_id
            from public.table_sessions as session_row
            join public.orders as order_row
              on order_row.table_session_id = session_row.id
            where session_row.id = $1::uuid
              and order_row.id = $2::uuid
            for update of session_row`,
            [sessionId, orderId],
          );
          const session = locked.rows[0];
          if (!session) return null;
          if (session.status === "closed") return "closed";
          if (session.status === "check_requested") {
            return { sessionId, status: "check_requested" as const };
          }

          const updated = await client.query<{ id: string }>(
            `update public.table_sessions as session_row
            set status = 'check_requested'
            from public.orders as order_row
            where session_row.id = $1::uuid
              and order_row.id = $2::uuid
              and order_row.table_session_id = session_row.id
              and session_row.status = 'open'
            returning session_row.id`,
            [sessionId, orderId],
          );
          if (!updated.rows[0]) throw storageFailure();
          change = { restaurantId: session.restaurant_id, topics: ["table_sessions"], orderIds: [], entityId: sessionId, reason: "check_requested" };
          return { sessionId, status: "check_requested" as const };
        });
        await emitCommittedChange(options, change);
        return result;
      } catch (error) {
        if (error instanceof AppError && error.code !== "internal_error") throw error;
        throw storageFailure();
      }
    },
  };
}
