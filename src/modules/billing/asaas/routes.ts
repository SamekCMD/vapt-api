import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import {
  createSupabaseOwnershipLookup,
  testOwnershipLookup,
  type OwnershipLookup,
} from "../../../lib/permissions.js";
import { createSupabaseAdminClient } from "../../../lib/supabase.js";
import { validateWithSchema } from "../../../lib/validation.js";
import { requireAuth } from "../../../plugins/auth.js";
import { createN8nClient } from "../../n8n/client.js";
import {
  asaasPixBodySchema,
  asaasPixPublicBodySchema,
  asaasSetupBodySchema,
  asaasSetupStatusQuerySchema,
} from "./schemas.js";
import { createAsaasBillingService } from "./service.js";

export async function registerAsaasBillingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  ownershipLookup?: OwnershipLookup,
) {
  const resolvedOwnershipLookup =
    ownershipLookup ??
    (config.nodeEnv === "test"
      ? testOwnershipLookup
      : createSupabaseOwnershipLookup(createSupabaseAdminClient(config) as never));
  const client = createN8nClient(config);
  const service = createAsaasBillingService(client, resolvedOwnershipLookup);

  app.post(
    "/billing/asaas/setup",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = validateWithSchema(asaasSetupBodySchema, request.body);

      return service.setup({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
        asaasApiKey: body.asaasApiKey,
        asaasEnvironment: body.asaasEnvironment,
        asaasBillingDocument: body.asaasBillingDocument,
      });
    },
  );

  app.get(
    "/billing/asaas/setup/status",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const query = validateWithSchema(asaasSetupStatusQuerySchema, request.query);

      return service.getSetupStatus({
        userId: request.auth!.userId,
        restaurantId: query.restaurantId,
      });
    },
  );

  app.post(
    "/billing/asaas/pix",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) => requireAuth(request, reply, config),
    },
    async (request) => {
      const body = validateWithSchema(asaasPixBodySchema, request.body);

      return service.createPix({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
        orderId: body.orderId,
        totalPrice: body.totalPrice,
      });
    },
  );

  app.post(
    "/billing/asaas/pix/public",
    {
      config: {
        rateLimitGroup: "billing",
      },
    },
    async (request) => {
      const body = validateWithSchema(asaasPixPublicBodySchema, request.body);
      const admin = createSupabaseAdminClient(config);
      const { data, error } = await admin
        .from("orders")
        .select("id, restaurant_id, status, total_price")
        .eq("id", body.orderId)
        .eq("public_access_token_hash", createHash("sha256").update(body.publicToken).digest("hex"))
        .maybeSingle<{ id: string; restaurant_id: string; status: string; total_price: number }>();

      if (error) {
        throw new AppError(500, "internal_error", "Failed to load order");
      }

      if (!data || data.restaurant_id !== body.restaurantId) {
        throw new AppError(404, "not_found", "Order not found");
      }

      if (data.status !== "waiting_payment") {
        throw new AppError(409, "invalid_request", "Order is not awaiting payment");
      }

      const totalPrice = Number(data.total_price);

      return service.createPixPublic({
        restaurantId: body.restaurantId,
        orderId: body.orderId,
        totalPrice,
      });
    },
  );
}
