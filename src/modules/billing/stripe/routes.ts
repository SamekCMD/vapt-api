import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../../lib/config.js";
import { AppError } from "../../../lib/errors.js";
import {
  testOwnershipLookup,
  type OwnershipLookup,
} from "../../../lib/permissions.js";
import { validateWithSchema } from "../../../lib/validation.js";
import { requireAuth } from "../../../plugins/auth.js";
import { createStripeClient, createStripeGateway } from "./client.js";
import type { StripeGateway } from "./types.js";
import {
  stripeCancelSubscriptionBodySchema,
  stripeChangeSubscriptionBodySchema,
  stripeCheckoutBodySchema,
  stripePortalBodySchema,
  stripeSubscriptionStatusQuerySchema,
} from "./schemas.js";
import { createStripeBillingService } from "./service.js";
import type { StripeBillingStore } from "./repository.js";

export async function registerStripeBillingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  ownershipLookup?: OwnershipLookup,
  repository?: StripeBillingStore,
  gateway?: StripeGateway,
) {
  const resolvedOwnershipLookup =
    ownershipLookup ??
    (config.nodeEnv === "test"
      ? testOwnershipLookup
      : (() => {
          throw new AppError(500, "internal_error", "Ownership lookup is not configured");
        })());
  if (!repository) {
    throw new AppError(500, "internal_error", "Stripe billing repository is not configured");
  }
  const service = createStripeBillingService(
    gateway ?? createStripeGateway(createStripeClient(config.stripe)),
    resolvedOwnershipLookup,
    repository,
    config,
  );

  app.post(
    "/billing/stripe/checkout",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      const body = validateWithSchema(stripeCheckoutBodySchema, request.body);

      return service.createCheckout({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
        email: request.auth!.email ?? (() => {
          throw new AppError(400, "invalid_request", "Authenticated email is required");
        })(),
        planType: body.planType,
        idempotencyKey: typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"] : "",
      });
    },
  );

  app.post(
    "/billing/stripe/subscription/change",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      const body = validateWithSchema(stripeChangeSubscriptionBodySchema, request.body);

      return service.retiredMutation({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
      });
    },
  );

  app.post(
    "/billing/stripe/subscription/cancel",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      const body = validateWithSchema(stripeCancelSubscriptionBodySchema, request.body);

      return service.retiredMutation({
        userId: request.auth!.userId,
        restaurantId: body.restaurantId,
      });
    },
  );

  app.post(
    "/billing/stripe/portal",
    {
      config: { rateLimitGroup: "billing" },
      preHandler: async (request, reply) => requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      const body = validateWithSchema(stripePortalBodySchema, request.body);
      return service.createPortal({ userId: request.auth!.userId, restaurantId: body.restaurantId });
    },
  );

  app.get(
    "/billing/stripe/subscription",
    {
      config: {
        rateLimitGroup: "billing",
      },
      preHandler: async (request, reply) =>
        requireAuth(request, reply, app.authSessionResolver),
    },
    async (request) => {
      const query = validateWithSchema(stripeSubscriptionStatusQuerySchema, request.query);

      return service.getSubscriptionStatus({
        userId: request.auth!.userId,
        restaurantId: query.restaurantId,
      });
    },
  );
}
