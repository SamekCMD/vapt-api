import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../../../lib/config.js";
import { AppError } from "../../../../lib/errors.js";
import { validateWithSchema } from "../../../../lib/validation.js";
import { requireAuth } from "../../../../plugins/auth.js";
import type { MercadoPagoOAuthService } from "./oauth.js";
import {
  callbackQuerySchema,
  connectBodySchema,
  createMercadoPagoOAuthRedirect,
  environmentQuerySchema,
  resolveReturnOrigin,
  restaurantParamsSchema,
} from "./http-contract.js";
export { createMercadoPagoOAuthServiceFromConfig } from "./composition.js";
export { resolveReturnOrigin } from "./http-contract.js";

export type MercadoPagoOAuthRouteService = Pick<
  MercadoPagoOAuthService,
  "beginConnection" | "handleCallback" | "getStatus" | "disconnect"
>;

export async function registerMercadoPagoOAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service?: MercadoPagoOAuthRouteService,
) {
  const resolvedService = service ?? (() => {
    throw new AppError(500, "internal_error", "Mercado Pago OAuth service is not configured");
  })();
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
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
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
      const redirect = createMercadoPagoOAuthRedirect(config, result.status, result.returnOrigin);
      return reply.redirect(redirect.toString());
    },
  );

  app.get(
    "/restaurants/:restaurantId/payments/mercado-pago/status",
    {
      config: { rateLimitGroup: "billing" },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
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
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
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
