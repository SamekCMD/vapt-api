import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../../../../lib/config.js";
import { createSecretCipher } from "../../../../lib/crypto.js";
import { AppError } from "../../../../lib/errors.js";
import {
  createSupabaseOwnershipLookup,
  testOwnershipLookup,
} from "../../../../lib/permissions.js";
import { createSupabaseAdminClient } from "../../../../lib/supabase.js";
import { validateWithSchema } from "../../../../lib/validation.js";
import { requireAuth } from "../../../../plugins/auth.js";
import { isAllowedOrigin } from "../../../../plugins/cors.js";
import { createMercadoPagoOAuthClient } from "./client.js";
import {
  createMercadoPagoOAuthRepository,
  createMercadoPagoOAuthService,
  type MercadoPagoOAuthService,
} from "./oauth.js";

const restaurantParamsSchema = z.object({
  restaurantId: z.string().uuid(),
}).strict();

const environmentSchema = z.enum(["sandbox", "production"]);

const connectBodySchema = z.object({
  environment: environmentSchema,
  returnOrigin: z.string().trim().min(1).max(255).optional(),
}).strict();

const environmentQuerySchema = z.object({
  environment: environmentSchema,
}).strict();

const callbackQuerySchema = z.object({
  state: z.string().min(16).max(512),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().min(1).max(128).optional(),
  error_description: z.string().max(512).optional(),
}).strict().refine((value) => Boolean(value.code || value.error));

export type MercadoPagoOAuthRouteService = Pick<
  MercadoPagoOAuthService,
  "beginConnection" | "handleCallback" | "getStatus" | "disconnect"
>;

function resolveReturnOrigin(value: string | undefined, config: AppConfig): string {
  const fallbackOrigin = config.frontendUrl!.origin;
  if (!value) return fallbackOrigin;

  let origin: string;
  try {
    const parsed = new URL(value);
    origin = parsed.origin;
    if (value !== origin) throw new Error("origin_only");
  } catch {
    throw new AppError(400, "oauth_return_origin_invalid", "OAuth return origin is invalid");
  }

  if (origin !== fallbackOrigin && !isAllowedOrigin(origin, config.corsOrigins)) {
    throw new AppError(400, "oauth_return_origin_invalid", "OAuth return origin is not allowed");
  }

  return origin;
}

export function createMercadoPagoOAuthServiceFromConfig(config: AppConfig): MercadoPagoOAuthService {
  if (!config.mercadoPago || !config.frontendUrl) {
    throw new AppError(
      503,
      "mercado_pago_not_configured",
      "Mercado Pago OAuth is not configured",
    );
  }

  const supabase = createSupabaseAdminClient(config);
  return createMercadoPagoOAuthService({
    repository: createMercadoPagoOAuthRepository(supabase),
    client: createMercadoPagoOAuthClient({
      clientId: config.mercadoPago.clientId,
      clientSecret: config.mercadoPago.clientSecret,
    }),
    cipher: createSecretCipher(config.mercadoPago.tokenEncryptionKey),
    ownershipLookup: config.nodeEnv === "test"
      ? testOwnershipLookup
      : createSupabaseOwnershipLookup(supabase as never),
    config: {
      clientId: config.mercadoPago.clientId,
      redirectUri: config.mercadoPago.redirectUri,
      frontendUrl: config.frontendUrl,
      credentialKeyId: config.mercadoPago.credentialKeyId,
      stateTtlMs: 10 * 60 * 1000,
    },
  });
}

export async function registerMercadoPagoOAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service?: MercadoPagoOAuthRouteService,
) {
  const resolvedService = service ?? createMercadoPagoOAuthServiceFromConfig(config);
  if (!config.frontendUrl) {
    throw new AppError(
      503,
      "mercado_pago_not_configured",
      "Mercado Pago OAuth is not configured",
    );
  }

  app.post(
    "/restaurants/:restaurantId/payments/mercado-pago/connect",
    {
      config: { rateLimitGroup: "billing" },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const params = validateWithSchema(restaurantParamsSchema, request.params);
      const body = validateWithSchema(connectBodySchema, request.body);
      const returnOrigin = resolveReturnOrigin(body.returnOrigin, config);
      return resolvedService.beginConnection({
        restaurantId: params.restaurantId,
        userId: request.auth!.userId,
        environment: body.environment,
        returnOrigin,
      });
    },
  );

  app.get(
    "/payments/mercado-pago/oauth/callback",
    { config: { rateLimitGroup: "billing" } },
    async (request, reply) => {
      const query = validateWithSchema(callbackQuerySchema, request.query);
      const result = await resolvedService.handleCallback({
        state: query.state,
        code: query.code,
        error: query.error,
        errorDescription: query.error_description,
      });
      const redirect = new URL(
        "/dashboard/settings",
        result.returnOrigin ?? config.frontendUrl,
      );
      redirect.searchParams.set("payment_provider", "mercado_pago");
      redirect.searchParams.set("connection", result.status);
      return reply.redirect(redirect.toString());
    },
  );

  app.get(
    "/restaurants/:restaurantId/payments/mercado-pago/status",
    {
      config: { rateLimitGroup: "billing" },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const params = validateWithSchema(restaurantParamsSchema, request.params);
      const query = validateWithSchema(environmentQuerySchema, request.query);
      return resolvedService.getStatus({
        restaurantId: params.restaurantId,
        userId: request.auth!.userId,
        environment: query.environment,
      });
    },
  );

  app.delete(
    "/restaurants/:restaurantId/payments/mercado-pago/connection",
    {
      config: { rateLimitGroup: "billing" },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const params = validateWithSchema(restaurantParamsSchema, request.params);
      const query = validateWithSchema(environmentQuerySchema, request.query);
      return resolvedService.disconnect({
        restaurantId: params.restaurantId,
        userId: request.auth!.userId,
        environment: query.environment,
      });
    },
  );
}
