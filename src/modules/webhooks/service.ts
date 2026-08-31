import { AppError } from "../../lib/errors.js";
import { N8nClientError } from "../n8n/errors.js";
import { verifyStripeWebhookSignature } from "./signature.js";

type WebhookRepository = {
  reserveBillingEvent: (input: {
    providerEventId: string;
    eventType: string;
    rawPayload: unknown;
    restaurantId?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  }) => Promise<{ duplicate: boolean }>;
  markBillingEventProcessed: (input: {
    providerEventId: string;
    eventType: string;
    rawPayload: unknown;
    restaurantId?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  }) => Promise<void>;
  markBillingEventFailed: (input: {
    providerEventId: string;
    eventType: string;
    rawPayload: unknown;
    restaurantId?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  }, errorMessage: string) => Promise<void>;
};

type WebhookN8nClient = {
  stripe: {
    forwardWebhook: (input: {
      rawBody: string;
      signatureHeader: string;
      contentType?: string;
    }) => Promise<unknown>;
  };
};

type WebhookServiceConfig = {
  stripeSigningSecret: string;
  stripeToleranceSeconds: number;
};

function getForwardingErrorMessage(error: unknown) {
  if (error instanceof N8nClientError) {
    return `${error.code}${error.upstreamStatus ? `:${error.upstreamStatus}` : ""}`;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "unknown_forwarding_error";
}

function mapForwardingError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(502, "provider_unreachable", "Failed to forward webhook to n8n");
}

export function createWebhookService(
  config: WebhookServiceConfig,
  repository: WebhookRepository,
  n8nClient: WebhookN8nClient,
) {
  return {
    async handleStripeWebhook(input: {
      rawBody: string;
      signatureHeader: string | undefined;
      contentType?: string;
    }) {
      const event = verifyStripeWebhookSignature({
        rawBody: input.rawBody,
        signatureHeader: input.signatureHeader,
        signingSecret: config.stripeSigningSecret,
        toleranceSeconds: config.stripeToleranceSeconds,
      });
      const eventObject =
        event.data?.object && typeof event.data.object === "object" ? event.data.object : {};
      const eventRecord = {
        providerEventId: event.id,
        eventType: event.type,
        rawPayload: event,
        restaurantId: null,
        stripeCustomerId:
          typeof eventObject.customer === "string" ? eventObject.customer : null,
        stripeSubscriptionId:
          typeof eventObject.subscription === "string"
            ? eventObject.subscription
            : typeof eventObject.id === "string"
              ? eventObject.id
              : null,
      };
      const reservation = await repository.reserveBillingEvent(eventRecord);

      if (reservation.duplicate) {
        return {
          received: true,
          duplicate: true,
          providerEventId: event.id,
        };
      }

      try {
        await n8nClient.stripe.forwardWebhook({
          rawBody: input.rawBody,
          signatureHeader: input.signatureHeader ?? "",
          contentType: input.contentType,
        });
        await repository.markBillingEventProcessed(eventRecord);

        return {
          received: true,
          duplicate: false,
          providerEventId: event.id,
        };
      } catch (error) {
        await repository.markBillingEventFailed(eventRecord, getForwardingErrorMessage(error));
        throw mapForwardingError(error);
      }
    },
  };
}
