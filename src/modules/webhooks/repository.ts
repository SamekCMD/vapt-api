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

type AsaasWebhookContext = {
  orderId: string;
  restaurantId: string;
  webhookToken: string | null;
};

type BillingEventInput = {
  providerEventId: string;
  eventType: string;
  rawPayload: unknown;
  restaurantId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
};

type PaymentEventInput = {
  providerEventId: string;
  eventType: string;
  rawPayload: unknown;
  restaurantId: string;
  orderId: string;
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
    async findAsaasWebhookContext(orderId: string): Promise<AsaasWebhookContext | null> {
      const orderResult = await client
        .from("orders")
        .select("id, restaurant_id")
        .eq("id", orderId)
        .maybeSingle<{ id: string; restaurant_id: string }>();

      if (orderResult.error) {
        normalizeStorageError("Failed to load Asaas webhook order");
      }

      if (!orderResult.data) {
        return null;
      }

      const restaurantResult = await client
        .from("restaurants")
        .select("asaas_webhook_token")
        .eq("id", orderResult.data.restaurant_id)
        .maybeSingle<{ asaas_webhook_token: string | null }>();

      if (restaurantResult.error) {
        normalizeStorageError("Failed to load Asaas webhook restaurant");
      }

      return {
        orderId: orderResult.data.id,
        restaurantId: orderResult.data.restaurant_id,
        webhookToken: restaurantResult.data?.asaas_webhook_token ?? null,
      };
    },

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

    async reservePaymentEvent(input: PaymentEventInput): Promise<{ duplicate: boolean }> {
      const receivedAt = new Date().toISOString();
      const result = await client.from("payment_provider_events").insert({
        provider: "asaas_gateway",
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        restaurant_id: input.restaurantId,
        order_id: input.orderId,
        payload: createStoredPayload(input.rawPayload, "received", receivedAt),
      });

      if (!result.error) {
        return { duplicate: false };
      }

      if (isDuplicateError(result.error)) {
        return { duplicate: true };
      }

      normalizeStorageError("Failed to persist Asaas webhook event");
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

    async markPaymentEventProcessed(input: PaymentEventInput) {
      const processedAt = new Date().toISOString();
      const result = await client
        .from("payment_provider_events")
        .update({
          processed_at: processedAt,
          payload: createStoredPayload(input.rawPayload, "processed", processedAt, null, processedAt),
        })
        .eq("provider", "asaas_gateway")
        .eq("provider_event_id", input.providerEventId);

      if (result.error) {
        normalizeStorageError("Failed to mark Asaas webhook as processed");
      }
    },

    async markPaymentEventFailed(input: PaymentEventInput, errorMessage: string) {
      const result = await client
        .from("payment_provider_events")
        .update({
          payload: createStoredPayload(
            input.rawPayload,
            "pending_retry",
            new Date().toISOString(),
            errorMessage,
            null,
          ),
        })
        .eq("provider", "asaas_gateway")
        .eq("provider_event_id", input.providerEventId);

      if (result.error) {
        normalizeStorageError("Failed to mark Asaas webhook as failed");
      }
    },
  };
}
