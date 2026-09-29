import type { Pool } from "pg";

import { createResendAuthEmailService } from "../email/email.service.js";
import { createResendEmailClient } from "../email/resend.client.js";
import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import { createOwnershipLookup, testOwnershipLookup, type OwnershipLookup } from "../lib/permissions.js";
import { createBetterAuthRuntime } from "../modules/auth/better-auth.js";
import type { AuthRuntime, BackgroundTaskRunner } from "../modules/auth/runtime.js";
import { createStripeClient, createStripeGateway } from "../modules/billing/stripe/client.js";
import { createStripeBillingRepository } from "../modules/billing/stripe/repository.js";
import { createStripeBillingService } from "../modules/billing/stripe/service.js";
import type { StripeGateway } from "../modules/billing/stripe/types.js";
import { createStripeWebhookRepository } from "../modules/billing/stripe/webhook-repository.js";
import { createStripeWebhookService } from "../modules/billing/stripe/webhook-service.js";
import { createCatalogRepository } from "../modules/catalog/repository.js";
import { createCatalogService } from "../modules/catalog/service.js";
import { createFeedbackRepository } from "../modules/feedback/repository.js";
import { createFeedbackService } from "../modules/feedback/service.js";
import { createKitchenRepository } from "../modules/kitchen/repository.js";
import { createKitchenService } from "../modules/kitchen/service.js";
import { createMenuRepository } from "../modules/menu/repository.js";
import { createMenuService } from "../modules/menu/service.js";
import { createOrderRepository } from "../modules/orders/repository.js";
import { createOrderService, type OrderService } from "../modules/orders/service.js";
import { createOverviewRepository } from "../modules/overview/repository.js";
import { createOverviewService } from "../modules/overview/service.js";
import { createPaymentModule } from "../modules/payments/composition.js";
import type { PaymentProvider } from "../modules/payments/provider.js";
import { createManualPaymentProvider } from "../modules/payments/providers/manual.js";
import { createMercadoPagoCheckoutClient } from "../modules/payments/providers/mercado-pago/client.js";
import { createMercadoPagoOAuthServiceFromConfig } from "../modules/payments/providers/mercado-pago/composition.js";
import type { MercadoPagoOAuthService } from "../modules/payments/providers/mercado-pago/oauth.js";
import { createMercadoPagoPaymentClient } from "../modules/payments/providers/mercado-pago/payment-client.js";
import {
  createMercadoPagoEnvironmentAccessTokenResolver,
  createMercadoPagoPaymentProvider,
} from "../modules/payments/providers/mercado-pago/payment.js";
import { createMercadoPagoWebhookService, type MercadoPagoWebhookService } from "../modules/payments/providers/mercado-pago/webhook.js";
import {
  createMercadoPagoPaymentDiagnosticsService,
  createMercadoPagoReturnReconciliationService,
  type MercadoPagoReturnReconciliationService,
} from "../modules/payments/service.js";
import { createManualPaymentService, type ManualPaymentService, type PaymentModule } from "../modules/payments/service.js";
import { createRestaurantRepository } from "../modules/restaurants/repository.js";
import { createRestaurantService } from "../modules/restaurants/service.js";
import { createTableSessionRepository } from "../modules/table-sessions/repository.js";
import { createTableSessionService } from "../modules/table-sessions/service.js";

export type CatalogService = ReturnType<typeof createCatalogService>;
export type FeedbackService = ReturnType<typeof createFeedbackService>;
export type TableSessionService = ReturnType<typeof createTableSessionService>;
export type RestaurantService = ReturnType<typeof createRestaurantService>;
export type MenuService = ReturnType<typeof createMenuService>;
export type KitchenService = ReturnType<typeof createKitchenService>;
export type OverviewService = ReturnType<typeof createOverviewService>;
export type StripeBillingService = ReturnType<typeof createStripeBillingService>;
export type StripeWebhookService = ReturnType<typeof createStripeWebhookService>;
export type MercadoPagoServices = {
  oauth: MercadoPagoOAuthService;
  returnReconciliation: MercadoPagoReturnReconciliationService;
  diagnostics: ReturnType<typeof createMercadoPagoPaymentDiagnosticsService>;
  webhook: MercadoPagoWebhookService;
};

export type ApiServiceDependencies = {
  database: Database;
  authRuntime?: AuthRuntime;
  ownershipLookup?: OwnershipLookup;
  catalog?: CatalogService;
  orders?: OrderService;
  feedback?: FeedbackService;
  tableSessions?: TableSessionService;
  restaurants?: RestaurantService;
  menu?: MenuService;
  kitchen?: KitchenService;
  overview?: OverviewService;
  stripeBilling?: StripeBillingService;
  stripeWebhooks?: StripeWebhookService;
  manualPayments?: ManualPaymentService;
  mercadoPago?: MercadoPagoServices;
  payments?: PaymentModule;
  stripeGateway?: StripeGateway;
  paymentProviders?: readonly PaymentProvider[];
  runInBackground?: BackgroundTaskRunner;
  workerId?: string;
  onError?: (error: unknown) => void;
  onBackgroundError?: (error: unknown) => void;
  onInfo?: (fields: Record<string, unknown>, message: string) => void;
  startPaymentReconciliation?: boolean;
};

export type ApiServices = {
  config: AppConfig;
  database: Database;
  authRuntime: AuthRuntime;
  ownershipLookup: OwnershipLookup;
  catalog: CatalogService;
  orders: OrderService;
  feedback: FeedbackService;
  tableSessions: TableSessionService;
  restaurants: RestaurantService;
  menu: MenuService;
  kitchen: KitchenService;
  overview: OverviewService;
  stripeBilling: StripeBillingService;
  stripeWebhooks: StripeWebhookService;
  manualPayments: ManualPaymentService;
  mercadoPago: MercadoPagoServices | null;
  stripeGateway: StripeGateway;
  payments: PaymentModule;
};

export function createApiServices(config: AppConfig, dependencies: ApiServiceDependencies): ApiServices {
  let authRuntime = dependencies.authRuntime;
  let stripeGateway = dependencies.stripeGateway;
  let payments = dependencies.payments;
  let catalog = dependencies.catalog;
  let orders = dependencies.orders;
  let feedback = dependencies.feedback;
  let tableSessions = dependencies.tableSessions;
  let restaurants = dependencies.restaurants;
  let menu = dependencies.menu;
  let kitchen = dependencies.kitchen;
  let overview = dependencies.overview;
  let stripeBilling = dependencies.stripeBilling;
  let stripeWebhooks = dependencies.stripeWebhooks;
  let manualPayments = dependencies.manualPayments;
  let mercadoPago = dependencies.mercadoPago;
  let mercadoPagoCore: {
    oauth: MercadoPagoOAuthService;
    paymentClient: ReturnType<typeof createMercadoPagoPaymentClient>;
    checkoutClient: ReturnType<typeof createMercadoPagoCheckoutClient>;
    resolveAccessToken: ReturnType<typeof createMercadoPagoEnvironmentAccessTokenResolver>;
  } | null | undefined;
  const getMercadoPagoCore = () => {
    if (mercadoPagoCore !== undefined) return mercadoPagoCore;
    if (!config.mercadoPago || !config.frontendUrl || !config.apiPublicUrl) {
      mercadoPagoCore = null;
      return null;
    }
    const oauth = createMercadoPagoOAuthServiceFromConfig(
      config, dependencies.database, dependencies.ownershipLookup ??
        (config.nodeEnv === "test" ? testOwnershipLookup : createOwnershipLookup(dependencies.database)),
    );
    mercadoPagoCore = {
      oauth,
      paymentClient: createMercadoPagoPaymentClient(),
      checkoutClient: createMercadoPagoCheckoutClient(),
      resolveAccessToken: createMercadoPagoEnvironmentAccessTokenResolver({
        environment: config.mercadoPago.environment,
        sandboxAccessToken: config.mercadoPago.testAccessToken,
        oauthResolver: (input) => oauth.resolveAccessToken(input),
      }),
    };
    return mercadoPagoCore;
  };

  return {
    config,
    database: dependencies.database,
    get ownershipLookup() {
      return dependencies.ownershipLookup ?? (config.nodeEnv === "test"
        ? testOwnershipLookup
        : createOwnershipLookup(dependencies.database));
    },
    get catalog() {
      catalog ??= createCatalogService(createCatalogRepository(dependencies.database));
      return catalog;
    },
    get orders() {
      orders ??= createOrderService(
        createOrderRepository(dependencies.database),
        config.security.publicOrderTokenSecret,
      );
      return orders;
    },
    get feedback() {
      feedback ??= createFeedbackService(createFeedbackRepository(dependencies.database), this.orders);
      return feedback;
    },
    get tableSessions() {
      tableSessions ??= createTableSessionService(createTableSessionRepository(dependencies.database));
      return tableSessions;
    },
    get restaurants() {
      restaurants ??= createRestaurantService(createRestaurantRepository(dependencies.database));
      return restaurants;
    },
    get menu() {
      menu ??= createMenuService(createMenuRepository(dependencies.database), {
        publicBaseUrl: config.r2?.publicBaseUrl ?? null,
      });
      return menu;
    },
    get kitchen() {
      kitchen ??= createKitchenService(createKitchenRepository(dependencies.database));
      return kitchen;
    },
    get overview() {
      overview ??= createOverviewService(createOverviewRepository(dependencies.database));
      return overview;
    },
    get stripeBilling() {
      stripeBilling ??= createStripeBillingService(
        this.stripeGateway,
        this.ownershipLookup,
        createStripeBillingRepository(dependencies.database),
        config,
      );
      return stripeBilling;
    },
    get stripeWebhooks() {
      stripeWebhooks ??= createStripeWebhookService(
        config.stripe,
        createStripeWebhookRepository(dependencies.database),
        this.stripeGateway,
        { logger: { info: dependencies.onInfo ?? (() => undefined) } },
      );
      return stripeWebhooks;
    },
    get manualPayments() {
      manualPayments ??= createManualPaymentService({
        repository: this.payments.repository,
        paymentService: this.payments.service,
        ownershipLookup: this.ownershipLookup,
      });
      return manualPayments;
    },
    get mercadoPago() {
      if (mercadoPago) return mercadoPago;
      const core = getMercadoPagoCore();
      if (!core || !config.mercadoPago) return null;
      const resolveProviderAccountDiagnostics = (input: { providerAccountId: string; restaurantId: string }) =>
        core.oauth.getSafeAccountDiagnostics(input);
      mercadoPago = {
        oauth: core.oauth,
        returnReconciliation: createMercadoPagoReturnReconciliationService({
          repository: this.payments.repository,
          resolveAccessToken: core.resolveAccessToken,
          resolveProviderAccountDiagnostics,
          client: core.paymentClient,
        }),
        diagnostics: createMercadoPagoPaymentDiagnosticsService({
          orderService: this.orders,
          paymentService: this.payments.service,
          resolveAccessToken: core.resolveAccessToken,
          resolveProviderAccountDiagnostics,
          paymentClient: core.paymentClient,
          checkoutClient: core.checkoutClient,
        }),
        webhook: createMercadoPagoWebhookService({
          webhookSecret: config.mercadoPago.webhookSecret,
          repository: this.payments.repository,
          resolveAccessToken: core.resolveAccessToken,
          client: core.paymentClient,
        }),
      };
      return mercadoPago;
    },
    get authRuntime() {
      authRuntime ??= createBetterAuthRuntime(config.betterAuth, {
        pool: dependencies.database as Pool,
        emailService: createResendAuthEmailService(
          createResendEmailClient(config.betterAuth.email.resendApiKey),
          config.betterAuth.email,
          { info: dependencies.onInfo ?? (() => undefined) },
        ),
        runInBackground: dependencies.runInBackground ?? ((task) => {
          void task.catch(dependencies.onBackgroundError ?? (() => undefined));
        }),
      });
      return authRuntime;
    },
    get stripeGateway() {
      stripeGateway ??= createStripeGateway(createStripeClient(config.stripe));
      return stripeGateway;
    },
    get payments() {
      if (payments) return payments;
      const core = dependencies.paymentProviders ? null : getMercadoPagoCore();
      const providers = dependencies.paymentProviders ?? [
        createManualPaymentProvider(),
        ...(core && config.apiPublicUrl ? [createMercadoPagoPaymentProvider({
          client: core.checkoutClient,
          resolveAccessToken: core.resolveAccessToken,
          notificationUrl: new URL("/webhooks/payments/mercado-pago", config.apiPublicUrl),
        })] : []),
      ];
      payments ??= createPaymentModule(
        config,
        dependencies.database,
        providers,
        {
          workerId: dependencies.workerId ?? "payment-effects-manual",
          onError: dependencies.onError ?? (() => undefined),
        },
      );
      return payments;
    },
  };
}
