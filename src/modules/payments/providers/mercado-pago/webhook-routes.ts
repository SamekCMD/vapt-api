import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "../../../../lib/errors.js";
import type { MercadoPagoWebhookService } from "./webhook.js";

type WebhookQuery = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

async function handleWebhook(
  request: FastifyRequest<{ Querystring: WebhookQuery }>,
  reply: FastifyReply,
  service: MercadoPagoWebhookService,
) {
  const dataId = first(request.query["data.id"] ?? request.query.data_id);
  const requestId = first(request.headers["x-request-id"]);
  const signatureHeader = first(request.headers["x-signature"]);
  if (!dataId) {
    throw new AppError(400, "invalid_request", "Mercado Pago data.id is required");
  }
  if (!requestId || !signatureHeader) {
    throw new AppError(401, "invalid_webhook_signature", "Invalid Mercado Pago webhook signature");
  }

  const response = await service.handle({
    rawBody: request.rawBody ?? JSON.stringify(request.body ?? {}),
    dataId,
    requestId,
    signatureHeader,
  });
  reply.status(200).send(response);
}

export async function registerMercadoPagoWebhookRoutes(
  app: FastifyInstance,
  service: MercadoPagoWebhookService,
) {
  const options = {
    config: {
      rawBody: true,
      rateLimitGroup: "webhooks",
    },
  } as const;

  app.post<{ Querystring: WebhookQuery }>(
    "/webhooks/payments/mercado-pago",
    options,
    (request, reply) => handleWebhook(request, reply, service),
  );

  // Mantem preferencias ja abertas funcionando durante a janela de compatibilidade.
  app.post<{ Querystring: WebhookQuery }>(
    "/payments/mercado-pago/webhook",
    options,
    (request, reply) => handleWebhook(request, reply, service),
  );
}
