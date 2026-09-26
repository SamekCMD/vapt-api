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
import { createCatalogRepository } from "./modules/catalog/repository.js";
import { registerCatalogRoutes } from "./modules/catalog/routes.js";
import { createBetterAuthRuntime } from "./modules/auth/better-auth.js";
import { registerBetterAuthHandler } from "./modules/auth/fastify-handler.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import type { AuthRuntime } from "./modules/auth/runtime.js";
import { createSessionResolver } from "./modules/auth/session-resolver.js";
import { registerIngestRoutes } from "./modules/ingest/routes.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
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
import { createRestaurantRepository } from "./modules/restaurants/repository.js";
import { registerRestaurantRoutes } from "./modules/restaurants/routes.js";
import { registerWebhookRoutes } from "./modules/webhooks/routes.js";
import { createMenuItemExists } from "./modules/storage/repository.js";
import { createR2MenuImageGateway } from "./modules/storage/r2.js";
import { registerMenuImageRoutes } from "./modules/storage/routes.js";
import { createMenuImageService } from "./modules/storage/service.js";
import { registerCors } from "./plugins/cors.js";
import { registerAuthDecorator } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { createLoggerConfig } from "./plugins/logger.js";
import { registerRateLimit } from "./plugins/rate-limit.js";
import { registerRawBody } from "./plugins/raw-body.js";

export type BuildAppDependencies = {
  authRuntime?: AuthRuntime;
  database?: Database;
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
      runInBackground(task) {
        void task.catch((error: unknown) => {
          app.log.error({ err: error }, "Better Auth background task failed");
        });
      },
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
  registerRateLimit(app);

  const ownershipLookup = config.nodeEnv === "test"
    ? testOwnershipLookup
    : createOwnershipLookup(database);
  const orderRepository = createOrderRepository(database);

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
  const paymentModule = registerPaymentModule(app, config, database, paymentProviders);
  await registerRawBody(app);
  await registerCors(app, config);
  await registerBetterAuthHandler(app, config.betterAuth.url, authRuntime.handler);
  await registerHealthRoutes(app);
  await registerCatalogRoutes(app, createCatalogRepository(database));
  await registerRestaurantRoutes(app, createRestaurantRepository(database));
  await registerAuthRoutes(app, config, ownershipLookup);
  await registerStripeBillingRoutes(app, config, ownershipLookup);
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
  await registerIngestRoutes(app, config);
  await registerWebhookRoutes(app, config, { database });

  return app;
}
