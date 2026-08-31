import type { SupabaseClient } from "@supabase/supabase-js";

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

function isDuplicateError(error: { code?: string | null; message?: string | null }) {
  return error.code === "23505" || error.message?.toLowerCase().includes("duplicate key") === true;
}

function normalizeStorageError(message: string): never {
  throw new AppError(500, "internal_error", message);
}

export function createWebhookRepository(client: SupabaseClient) {
  return {
    async reserveBillingEvent(input: BillingEventInput): Promise<{ duplicate: boolean }> {
      const receivedAt = new Date().toISOString();
      const result = await client.from("billing_provider_events").insert({
        provider: "stripe_gateway",
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        restaurant_id: input.restaurantId ?? null,
        stripe_customer_id: input.stripeCustomerId ?? null,
        stripe_subscription_id: input.stripeSubscriptionId ?? null,
        payload: createStoredPayload(input.rawPayload, "received", receivedAt),
      });

      if (!result.error) {
        return { duplicate: false };
      }

      if (isDuplicateError(result.error)) {
        return { duplicate: true };
      }

      normalizeStorageError("Failed to persist Stripe webhook event");
    },

    async markBillingEventProcessed(input: BillingEventInput) {
      const processedAt = new Date().toISOString();
      const result = await client
        .from("billing_provider_events")
        .update({
          processed_at: processedAt,
          payload: createStoredPayload(input.rawPayload, "processed", processedAt, null, processedAt),
        })
        .eq("provider", "stripe_gateway")
        .eq("provider_event_id", input.providerEventId);

      if (result.error) {
        normalizeStorageError("Failed to mark Stripe webhook as processed");
      }
    },

    async markBillingEventFailed(input: BillingEventInput, errorMessage: string) {
      const result = await client
        .from("billing_provider_events")
        .update({
          payload: createStoredPayload(
            input.rawPayload,
            "pending_retry",
            new Date().toISOString(),
            errorMessage,
            null,
          ),
        })
        .eq("provider", "stripe_gateway")
        .eq("provider_event_id", input.providerEventId);

      if (result.error) {
        normalizeStorageError("Failed to mark Stripe webhook as failed");
      }
    },

  };
}
