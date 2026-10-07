import { betterAuth } from "better-auth";
import type { BetterAuthConfig } from "../lib/config.js";
import { createBetterAuthOptions, type BetterAuthOptionDependencies } from "../modules/auth/better-auth.js";
import type { AuthRuntime } from "../modules/auth/runtime.js";
import { createWorkerAuthContext } from "./auth-context.js";

export type WorkerAuthEngine = { ready: Promise<void>; runtime: AuthRuntime };
export type WorkerAuthEngineBuilder = (config: BetterAuthConfig, dependencies: BetterAuthOptionDependencies) => WorkerAuthEngine;

const buildEngine: WorkerAuthEngineBuilder = (config, dependencies) => {
  const auth = betterAuth(createBetterAuthOptions(config, dependencies));
  return {
    ready: auth.$context.then(async context => { await context.checkSchema?.(); }),
    runtime: {
      handler: auth.handler,
      async getSession(headers) { return auth.api.getSession({ headers }); },
      async close() {},
    },
  };
};

function snapshot(config: BetterAuthConfig): BetterAuthConfig {
  return { ...config, url: new URL(config.url.href), trustedOrigins: [...config.trustedOrigins], email: { ...config.email } };
}

function sameConfig(a: BetterAuthConfig, b: BetterAuthConfig): boolean {
  return a.secret === b.secret && a.url.href === b.url.href && a.databaseUrl === b.databaseUrl
    && a.turnstileSecretKey === b.turnstileSecretKey
    && a.trustedOrigins.length === b.trustedOrigins.length && a.trustedOrigins.every((origin, i) => origin === b.trustedOrigins[i])
    && a.email.resendApiKey === b.email.resendApiKey && a.email.from === b.email.from
    && a.email.verifyAccountTemplate === b.email.verifyAccountTemplate && a.email.resetPasswordTemplate === b.email.resetPasswordTemplate;
}

export function createWorkerAuthRuntimeFactory(options: { createEngine?: WorkerAuthEngineBuilder } = {}) {
  const bridge = createWorkerAuthContext();
  const createEngine = options.createEngine ?? buildEngine;
  type Entry = { config: BetterAuthConfig; environment: string; ready: Promise<AuthRuntime> };
  let cached: Entry | undefined;

  // Only configuration/readiness is cached. Real pools/email/runners are never entries.
  function engine(config: BetterAuthConfig, environment: string): Promise<AuthRuntime> {
    if (cached && cached.environment === environment && sameConfig(cached.config, config)) return cached.ready;
    const entry: Entry = {
      config: snapshot(config), environment,
      ready: Promise.resolve().then(async () => {
        const created = createEngine(snapshot(config), bridge.dependencies);
        await created.ready;
        return created.runtime;
      }).catch(error => {
        if (cached === entry) cached = undefined;
        throw error;
      }),
    };
    cached = entry;
    return entry.ready;
  }

  return (config: BetterAuthConfig, dependencies: BetterAuthOptionDependencies, environment: string): AuthRuntime => {
    const identity = snapshot(config);
    return {
      handler(request) {
        return bridge.run(dependencies, async () => (await engine(identity, environment)).handler(request));
      },
      getSession(headers) {
        return bridge.run(dependencies, async () => (await engine(identity, environment)).getSession(headers));
      },
      async close() {},
    };
  };
}
