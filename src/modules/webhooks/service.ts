import { AppError } from "../../lib/errors.js";
import { N8nClientError } from "../n8n/errors.js";
import {
  extractAsaasEventType,
  extractAsaasExternalReference,
  parseAsaasWebhookPayload,
  verifyStripeWebhookSignature,
} from "./signature.js";

type WebhookRepository = {
  findAsaasWebhookContext: (orderId: string) => Promise<{
    orderId: string;
    restaurantId: string;
    webhookToken: string | null;
  } | null>;
  reserveBillingEvent: (input: {
    providerEventId: string;
    eventType: string;
    rawPayload: unknown;
    restaurantId?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  }) => Promise<{ duplicate: boolean }>;
  reservePaymentEvent: (input: {
    providerEventId: string;
    eventType: string;
    rawPayload: unknown;
    restaurantId: string;
    orderId: string;
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
  markPaymentEventProcessed: (input: {
    providerEventId: string;
    eventType: string;
    rawPayload: unknown;
    restaurantId: string;
    orderId: string;
  }) => Promise<void>;
  markPaymentEventFailed: (input: {
    providerEventId: string;
    eventType: string;
    rawPayload: unknown;
    restaurantId: string;
    orderId: string;
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
  asaas: {
    forwardWebhook: (input: {
      rawBody: string;
      accessToken: string;
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

    async handleAsaasWebhook(input: {
      rawBody: string;
      accessToken: string | undefined;
      contentType?: string;
    }) {
      const payload = parseAsaasWebhookPayload(input.rawBody);
      const externalReference = extractAsaasExternalReference(payload);
      const eventType = extractAsaasEventType(payload);
      const context = await repository.findAsaasWebhookContext(externalReference);

      if (!context) {
        throw new AppError(404, "not_found", "Webhook order was not found");
      }

      if (!input.accessToken || context.webhookToken !== input.accessToken) {
        throw new AppError(401, "unauthorized", "Invalid Asaas webhook token");
      }

      const eventRecord = {
        providerEventId: `asaas:${externalReference}:${eventType}`,
        eventType,
        rawPayload: payload,
        restaurantId: context.restaurantId,
        orderId: context.orderId,
      };
      const reservation = await repository.reservePaymentEvent(eventRecord);

      if (reservation.duplicate) {
        return {
          received: true,
          duplicate: true,
          providerEventId: eventRecord.providerEventId,
        };
      }

      try {
        await n8nClient.asaas.forwardWebhook({
          rawBody: input.rawBody,
          accessToken: input.accessToken,
          contentType: input.contentType,
        });
        await repository.markPaymentEventProcessed(eventRecord);

        return {
          received: true,
          duplicate: false,
          providerEventId: eventRecord.providerEventId,
        };
      } catch (error) {
        await repository.markPaymentEventFailed(eventRecord, getForwardingErrorMessage(error));
        throw mapForwardingError(error);
      }
    },
  };
}
