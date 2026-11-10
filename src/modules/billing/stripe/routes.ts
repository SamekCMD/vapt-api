import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../../lib/config.js";
import { validateWithSchema } from "../../../lib/validation.js";
import {actorFromAuth,requireAuth} from "../../../plugins/auth.js";
import type { StripeGateway } from "./types.js";
import {
  stripeCheckoutBodySchema,
  stripePortalBodySchema,
  stripeSubscriptionStatusQuerySchema,
} from "./schemas.js";
import { createStripeBillingService } from "./service.js";
import type { StripeBillingStore } from "./repository.js";

export async function registerStripeBillingRoutes(
  app: FastifyInstance,
  config: AppConfig,
  repository:StripeBillingStore,
  gateway:StripeGateway,
  resolveOrganization:(input:{userId:string;organizationId?:string;restaurantId?:string},capability:import('../../tenancy/contracts.js').Capability)=>Promise<import('../../tenancy/contracts.js').OrganizationScope>,
) {
  const service=createStripeBillingService(gateway,repository,config);

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

      const scope=await resolveOrganization({userId:request.auth!.userId,...body},'billing.manage');
      return service.createCheckout({
        ...actorFromAuth(request.auth!),...scope,
        planType: body.planType,
        idempotencyKey: typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"] : "",
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
      const scope=await resolveOrganization({userId:request.auth!.userId,...body},'billing.manage');
      return service.createPortal({...actorFromAuth(request.auth!),...scope});
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

      return service.getSubscriptionStatus(await resolveOrganization({userId:request.auth!.userId,...query},'billing.read'));
    },
  );
}
