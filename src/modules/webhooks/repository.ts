import type { Queryable } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";

type GatewayEventStatus = "received" | "processed" | "pending_retry";

type StoredGatewayPayload = {
  raw: unknown;
  gateway: {
    status: GatewayEventStatus;
    receivedAt: string;
    processedAt: string | null;
    lastProcessingError: string | null;
  };
};

type BillingEventInput = {
  providerEventId: string;
  eventType: string;
  rawPayload: unknown;
  restaurantId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
};

function createStoredPayload(
  rawPayload: unknown,
  status: GatewayEventStatus,
  receivedAt: string,
  error: string | null = null,
  processedAt: string | null = null,
): StoredGatewayPayload {
  return {
    raw: rawPayload,
    gateway: {
      status,
      receivedAt,
      processedAt,
      lastProcessingError: error,
    },
  };
}

function normalizeStorageError(message: string): never {
  throw new AppError(500, "internal_error", message);
}

export function createWebhookRepository(database: Queryable) {
  return {
    async reserveBillingEvent(input: BillingEventInput): Promise<{ duplicate: boolean }> {
      const receivedAt = new Date().toISOString();
      try {
        const result = await database.query<{ id: string }>(
          `insert into public.billing_provider_events (
            provider,
            provider_event_id,
            event_type,
            restaurant_id,
            stripe_customer_id,
            stripe_subscription_id,
            payload
          ) values (
            'stripe_gateway',
            $1::text,
            $2::text,
            $3::uuid,
            $4::text,
            $5::text,
            jsonb_build_object(
              'raw', $6::jsonb,
              'gateway', jsonb_build_object(
                'status', 'received',
                'receivedAt', $7::text,
                'processedAt', null,
                'lastProcessingError', null
              )
            )
          )
          on conflict (provider, provider_event_id) do nothing
          returning id`,
          [
            input.providerEventId,
            input.eventType,
            input.restaurantId ?? null,
            input.stripeCustomerId ?? null,
            input.stripeSubscriptionId ?? null,
            input.rawPayload,
            receivedAt,
          ],
        );
        return { duplicate: !result.rows[0] };
      } catch {
        normalizeStorageError("Failed to persist Stripe webhook event");
      }
    },

    async markBillingEventProcessed(input: BillingEventInput) {
      const processedAt = new Date().toISOString();
      const payload = createStoredPayload(
        input.rawPayload,
        "processed",
        processedAt,
        null,
        processedAt,
      );
      try {
        await database.query(
          `update public.billing_provider_events
          set processed_at = $2::timestamptz,
              payload = $1::jsonb
          where provider = 'stripe_gateway'
            and provider_event_id = $3::text`,
          [payload, processedAt, input.providerEventId],
        );
      } catch {
        normalizeStorageError("Failed to mark Stripe webhook as processed");
      }
    },

    async markBillingEventFailed(input: BillingEventInput, errorMessage: string) {
      const failedAt = new Date().toISOString();
      const payload = createStoredPayload(
        input.rawPayload,
        "pending_retry",
        failedAt,
        errorMessage,
        null,
      );
      try {
        await database.query(
          `update public.billing_provider_events
          set payload = $1::jsonb
          where provider = 'stripe_gateway'
            and provider_event_id = $2::text`,
          [payload, input.providerEventId],
        );
      } catch {
        normalizeStorageError("Failed to mark Stripe webhook as failed");
      }
    },
  };
}
