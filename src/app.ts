import Fastify from "fastify";
import { Pool } from "pg";

import { createResendAuthEmailService } from "./email/email.service.js";
import { createResendEmailClient } from "./email/resend.client.js";
import type { AppConfig } from "./lib/config.js";
import type { Database } from "./lib/database.js";
import {
  createOwnershipLookup,
  createRestaurantAccessChecker,
  testOwnershipLookup,
} from "./lib/permissions.js";
import { registerStripeBillingRoutes } from "./modules/billing/stripe/routes.js";
import { createStripeBillingRepository } from "./modules/billing/stripe/repository.js";
import type { StripeGateway } from "./modules/billing/stripe/types.js";
import { createStripeClient, createStripeGateway } from "./modules/billing/stripe/client.js";
import { createStripeWebhookRepository } from "./modules/billing/stripe/webhook-repository.js";
import { createStripeWebhookService } from "./modules/billing/stripe/webhook-service.js";
import { registerStripeWebhookRoutes } from "./modules/billing/stripe/webhook-routes.js";
import { createCatalogRepository } from "./modules/catalog/repository.js";
import { registerCatalogRoutes } from "./modules/catalog/routes.js";
import { createBetterAuthRuntime } from "./modules/auth/better-auth.js";
import { registerBetterAuthHandler } from "./modules/auth/fastify-handler.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import type { AuthRuntime, BackgroundTaskRunner } from "./modules/auth/runtime.js";
import { createSessionResolver } from "./modules/auth/session-resolver.js";
import { registerIngestRoutes } from "./modules/ingest/routes.js";
import { createPushSubscriptionRepository } from "./modules/ingest/repository.js";
import { createFeedbackRepository } from "./modules/feedback/repository.js";
import { registerFeedbackRoutes } from "./modules/feedback/routes.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { createKitchenRepository } from "./modules/kitchen/repository.js";
import { registerKitchenRoutes } from "./modules/kitchen/routes.js";
import { createMenuRepository } from "./modules/menu/repository.js";
import { registerMenuRoutes } from "./modules/menu/routes.js";
import type { PaymentProvider } from "./modules/payments/provider.js";
import { createManualPaymentProvider } from "./modules/payments/providers/manual.js";
import {
  createMercadoPagoCheckoutClient,
} from "./modules/payments/providers/mercado-pago/client.js";
import { createMercadoPagoPaymentClient } from "./modules/payments/providers/mercado-pago/payment-client.js";
import {
  createMercadoPagoEnvironmentAccessTokenResolver,
  createMercadoPagoPaymentProvider,
} from "./modules/payments/providers/mercado-pago/payment.js";
import {
  createMercadoPagoOAuthServiceFromConfig,
  registerMercadoPagoOAuthRoutes,
} from "./modules/payments/providers/mercado-pago/routes.js";
import { registerMercadoPagoWebhookRoutes } from "./modules/payments/providers/mercado-pago/webhook-routes.js";
import { createMercadoPagoWebhookService } from "./modules/payments/providers/mercado-pago/webhook.js";
import { registerPaymentEffectRoutes } from "./modules/payments/effects-routes.js";
import {
  createManualPaymentRoutes,
  registerHostedCheckoutRoutes,
  registerMercadoPagoDiagnosticsRoutes,
  registerMercadoPagoReturnRoutes,
} from "./modules/payments/routes.js";
import {
  createMercadoPagoPaymentDiagnosticsService,
  createMercadoPagoReturnReconciliationService,
  registerPaymentModule,
} from "./modules/payments/service.js";
import { createOrderRepository } from "./modules/orders/repository.js";
import { registerOrderRoutes } from "./modules/orders/routes.js";
import { createOrderService } from "./modules/orders/service.js";
import { createOverviewRepository } from "./modules/overview/repository.js";
import { registerOverviewRoutes } from "./modules/overview/routes.js";
import { createRestaurantRepository } from "./modules/restaurants/repository.js";
import { registerRestaurantRoutes } from "./modules/restaurants/routes.js";
import { createMenuItemExists } from "./modules/storage/repository.js";
import { createR2MenuImageGateway } from "./modules/storage/r2.js";
import { registerMenuImageRoutes } from "./modules/storage/routes.js";
import { createMenuImageService } from "./modules/storage/service.js";
import { createTableSessionRepository } from "./modules/table-sessions/repository.js";
import { registerTableSessionRoutes } from "./modules/table-sessions/routes.js";
import { registerCors } from "./plugins/cors.js";
import { registerAuthDecorator } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { createLoggerConfig } from "./plugins/logger.js";
import { registerRateLimit, type RateLimitBackend } from "./plugins/rate-limit.js";
import { registerRawBody } from "./plugins/raw-body.js";

export type BuildAppDependencies = {
  authRuntime?: AuthRuntime;
  database?: Database;
  stripeGateway?: StripeGateway;
  rateLimitBackend?: RateLimitBackend;
  runInBackground?: BackgroundTaskRunner;
  startPaymentReconciliation?: boolean;
  workerId?: string;
};

export async function buildApp(
  config: AppConfig,
  dependencies: BuildAppDependencies = {},
) {
  const app = Fastify({
    logger: createLoggerConfig(config),
    trustProxy: true,
  });

  const ownedDatabase = dependencies.database
    ? null
    : new Pool({ connectionString: config.betterAuth.databaseUrl });
  const database = dependencies.database ?? ownedDatabase!;
  const stripeGateway = dependencies.stripeGateway ?? createStripeGateway(createStripeClient(config.stripe));

  const authRuntime = dependencies.authRuntime ?? createBetterAuthRuntime(
    config.betterAuth,
    {
      emailService: createResendAuthEmailService(
        createResendEmailClient(config.betterAuth.email.resendApiKey),
        config.betterAuth.email,
        {
          info(fields, message) {
            app.log.info(fields, message);
          },
        },
      ),
      runInBackground: dependencies.runInBackground ?? ((task) => {
        void task.catch((error: unknown) => {
          app.log.error({ err: error }, "Better Auth background task failed");
        });
      }),
      pool: database as Pool,
    },
  );
  const sessionResolver = createSessionResolver(authRuntime);

  registerAuthDecorator(app, sessionResolver);
  app.addHook("onClose", async () => {
    try {
      await authRuntime.close();
    } finally {
      await ownedDatabase?.end();
    }
  });
  registerErrorHandler(app);
  registerRateLimit(app, { backend: dependencies.rateLimitBackend });

  const ownershipLookup = config.nodeEnv === "test"
    ? testOwnershipLookup
    : createOwnershipLookup(database);
  const orderRepository = createOrderRepository(database);
  const publicOrderService = createOrderService(
    orderRepository,
    config.security.publicOrderTokenSecret,
  );

  const paymentProviders: PaymentProvider[] = [createManualPaymentProvider()];
  const mercadoPagoOAuth = config.mercadoPago && config.frontendUrl && config.apiPublicUrl
    ? createMercadoPagoOAuthServiceFromConfig(config, database, ownershipLookup)
    : null;
  const mercadoPagoPaymentClient = config.mercadoPago
    ? createMercadoPagoPaymentClient()
    : null;
  const mercadoPagoCheckoutClient = config.mercadoPago
    ? createMercadoPagoCheckoutClient()
    : null;
  const mercadoPagoAccessTokenResolver = config.mercadoPago && mercadoPagoOAuth
    ? createMercadoPagoEnvironmentAccessTokenResolver({
        environment: config.mercadoPago.environment,
        sandboxAccessToken: config.mercadoPago.testAccessToken,
        oauthResolver: (input) => mercadoPagoOAuth.resolveAccessToken(input),
      })
    : null;
  if (config.mercadoPago && config.apiPublicUrl && mercadoPagoAccessTokenResolver) {
    paymentProviders.push(createMercadoPagoPaymentProvider({
      client: mercadoPagoCheckoutClient!,
      resolveAccessToken: mercadoPagoAccessTokenResolver,
      notificationUrl: new URL("/webhooks/payments/mercado-pago", config.apiPublicUrl),
    }));
  }
  const paymentModule = registerPaymentModule(app, config, database, paymentProviders, {
    startPaymentReconciliation: dependencies.startPaymentReconciliation,
    workerId: dependencies.workerId,
  });
  await registerRawBody(app);
  await registerCors(app, config);
  await registerBetterAuthHandler(app, config.betterAuth.url, authRuntime.handler);
  await registerHealthRoutes(app);
  await registerCatalogRoutes(app, createCatalogRepository(database));
  await registerRestaurantRoutes(app, createRestaurantRepository(database));
  await registerMenuRoutes(app, createMenuRepository(database), {
    publicBaseUrl: config.r2?.publicBaseUrl ?? null,
  });
  await registerKitchenRoutes(app, createKitchenRepository(database));
  await registerOverviewRoutes(app, createOverviewRepository(database));
  await registerTableSessionRoutes(
    app,
    createTableSessionRepository(database),
    publicOrderService,
  );
  const feedbackRepository = createFeedbackRepository(database);
  await registerFeedbackRoutes(app, feedbackRepository, publicOrderService);
  await registerAuthRoutes(app, config, ownershipLookup);
  await registerStripeBillingRoutes(
    app,
    config,
    ownershipLookup,
    createStripeBillingRepository(database),
    stripeGateway,
  );
  await registerOrderRoutes(app, config, orderRepository);
  if (config.r2) {
    await registerMenuImageRoutes(
      app,
      config,
      createMenuImageService({
        assertRestaurantAccess: createRestaurantAccessChecker(ownershipLookup),
        menuItemExists: createMenuItemExists(database),
        gateway: createR2MenuImageGateway(config.r2),
        publicBaseUrl: config.r2.publicBaseUrl,
        uploadUrlTtlSeconds: config.r2.uploadUrlTtlSeconds,
      }),
    );
  }
  await createManualPaymentRoutes(app, config, undefined, ownershipLookup);
  if (
    config.mercadoPago &&
    config.frontendUrl &&
    config.apiPublicUrl &&
    mercadoPagoOAuth &&
    mercadoPagoAccessTokenResolver &&
    mercadoPagoPaymentClient
  ) {
    await registerMercadoPagoOAuthRoutes(app, config, mercadoPagoOAuth);
    await registerMercadoPagoReturnRoutes(
      app,
      config,
      createMercadoPagoReturnReconciliationService({
        repository: paymentModule.repository,
        resolveAccessToken: mercadoPagoAccessTokenResolver,
        resolveProviderAccountDiagnostics: (input) =>
          mercadoPagoOAuth.getSafeAccountDiagnostics(input),
        client: mercadoPagoPaymentClient,
      }),
    );
    await registerHostedCheckoutRoutes(app, config, undefined, orderRepository);
    await registerMercadoPagoDiagnosticsRoutes(
      app,
      config,
      createMercadoPagoPaymentDiagnosticsService({
        orderService: createOrderService(
          orderRepository,
          config.security.publicOrderTokenSecret,
        ),
        paymentService: paymentModule.service,
        resolveAccessToken: mercadoPagoAccessTokenResolver,
        resolveProviderAccountDiagnostics: (input) =>
          mercadoPagoOAuth.getSafeAccountDiagnostics(input),
        paymentClient: mercadoPagoPaymentClient,
        checkoutClient: mercadoPagoCheckoutClient!,
      }),
    );
    await registerMercadoPagoWebhookRoutes(
      app,
      createMercadoPagoWebhookService({
        webhookSecret: config.mercadoPago.webhookSecret,
        repository: paymentModule.repository,
        resolveAccessToken: mercadoPagoAccessTokenResolver,
        client: mercadoPagoPaymentClient,
      }),
    );
  }
  await registerPaymentEffectRoutes(app, config);
  await registerIngestRoutes(app, {
    pushSubscriptions: createPushSubscriptionRepository(database),
    feedbackRepository,
    publicOrders: publicOrderService,
  });
  await registerStripeWebhookRoutes(app, config, {
    service: createStripeWebhookService(config.stripe, createStripeWebhookRepository(database), stripeGateway, {
      logger: { info(fields, message) { app.log.info(fields, message); } },
    }),
  });

  return app;
}
