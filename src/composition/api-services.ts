import type { Pool } from "pg";

import { createResendAuthEmailService } from "../email/email.service.js";
import { createResendEmailClient } from "../email/resend.client.js";
import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import { createOwnershipLookup, testOwnershipLookup, type OwnershipLookup } from "../lib/permissions.js";
import { createBetterAuthRuntime } from "../modules/auth/better-auth.js";
import type { AuthRuntime, BackgroundTaskRunner } from "../modules/auth/runtime.js";
import { createStripeClient, createStripeGateway } from "../modules/billing/stripe/client.js";
import type { StripeGateway } from "../modules/billing/stripe/types.js";
import { createPaymentModule } from "../modules/payments/composition.js";
import type { PaymentProvider } from "../modules/payments/provider.js";
import { createManualPaymentProvider } from "../modules/payments/providers/manual.js";
import type { PaymentModule } from "../modules/payments/service.js";

export type ApiServiceDependencies = {
  database: Database;
  authRuntime?: AuthRuntime;
  ownershipLookup?: OwnershipLookup;
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
  database: Database;
  authRuntime: AuthRuntime;
  ownershipLookup: OwnershipLookup;
  stripeGateway: StripeGateway;
  payments: PaymentModule;
};

export function createApiServices(config: AppConfig, dependencies: ApiServiceDependencies): ApiServices {
  let authRuntime = dependencies.authRuntime;
  let stripeGateway = dependencies.stripeGateway;
  let payments: PaymentModule | undefined;

  return {
    database: dependencies.database,
    get ownershipLookup() {
      return dependencies.ownershipLookup ?? (config.nodeEnv === "test"
        ? testOwnershipLookup
        : createOwnershipLookup(dependencies.database));
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
      payments ??= createPaymentModule(
        config,
        dependencies.database,
        dependencies.paymentProviders ?? [createManualPaymentProvider()],
        {
          workerId: dependencies.workerId ?? "payment-effects-manual",
          onError: dependencies.onError ?? (() => undefined),
        },
      );
      return payments;
    },
  };
}
