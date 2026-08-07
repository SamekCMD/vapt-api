import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";

import type { AppConfig } from "../../../../lib/config.js";

import { AppError } from "../../../../lib/errors.js";
import { createSecretCipher } from "../../../../lib/crypto.js";
import type { OwnershipLookup } from "../../../../lib/permissions.js";
import { registerAuthDecorator } from "../../../../plugins/auth.js";
import { registerErrorHandler } from "../../../../plugins/error-handler.js";
import {
  createMercadoPagoOAuthClient,
  type MercadoPagoTokenResponse,
} from "./client.js";
import {
  createMercadoPagoOAuthService,
  type MercadoPagoOAuthRepository,
  type OAuthStateRecord,
  type ProviderCredentialRecord,
} from "./oauth.js";
import {
  registerMercadoPagoOAuthRoutes,
  type MercadoPagoOAuthRouteService,
} from "./routes.js";

const RESTAURANT_ID = "10000000-0000-4000-8000-000000000001";
const encryptionKey = Buffer.alloc(32, 9);
const cipher = createSecretCipher(encryptionKey);
const now = new Date("2026-08-06T12:00:00.000Z");

function tokenResponse(overrides: Partial<MercadoPagoTokenResponse> = {}): MercadoPagoTokenResponse {
  return {
    accessToken: "APP_USR-access-token",
    refreshToken: "TG-refresh-token",
    tokenType: "bearer",
    expiresIn: 15_552_000,
    scope: "read write offline_access",
    userId: "seller-123",
    liveMode: true,
    ...overrides,
  };
}

function createMemoryRepository() {
  const states = new Map<string, OAuthStateRecord>();
  let account: ProviderCredentialRecord | null = null;

  const repository: MercadoPagoOAuthRepository = {
    async saveOAuthState(input) {
      const record: OAuthStateRecord = {
        id: `state-${states.size + 1}`,
        consumedAt: null,
        createdAt: now.toISOString(),
        ...input,
      };
      states.set(record.stateHash, record);
      return record;
    },
    async consumeOAuthState(input) {
      const record = states.get(input.stateHash);
      if (!record || record.consumedAt || record.expiresAt <= input.consumedAt) {
        return null;
      }
      const consumed = { ...record, consumedAt: input.consumedAt };
      states.set(input.stateHash, consumed);
      return consumed;
    },
    async upsertProviderAccount(input) {
      account = {
        id: account?.id ?? "account-1",
        version: (account?.version ?? 0) + 1,
        disconnectedAt: null,
        lastError: null,
        ...input,
      };
      return account;
    },
    async findProviderAccount(restaurantId, environment) {
      return account?.restaurantId === restaurantId && account.environment === environment
        ? account
        : null;
    },
    async updateProviderTokens(input) {
      if (!account || account.id !== input.accountId || account.version !== input.expectedVersion) {
        return null;
      }
      account = {
        ...account,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: input.refreshTokenEncrypted,
        tokenExpiresAt: input.tokenExpiresAt,
        credentialKeyId: input.credentialKeyId,
        status: "active",
        lastError: null,
        version: account.version + 1,
      };
      return account;
    },
    async disconnectProviderAccount(input) {
      if (!account || account.restaurantId !== input.restaurantId) return null;
      account = {
        ...account,
        status: "disconnected",
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        disconnectedAt: input.disconnectedAt,
        version: account.version + 1,
      };
      return account;
    },
  };

  return {
    repository,
    states,
    get account() {
      return account;
    },
  };
}

function createService(options: {
  repository?: MercadoPagoOAuthRepository;
  ownershipLookup?: OwnershipLookup;
  exchange?: (input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    testToken: boolean;
  }) => Promise<MercadoPagoTokenResponse>;
  refresh?: (refreshToken: string) => Promise<MercadoPagoTokenResponse>;
} = {}) {
  const memory = createMemoryRepository();
  const repository = options.repository ?? memory.repository;
  let exchangeCalls = 0;
  let refreshCalls = 0;

  const service = createMercadoPagoOAuthService({
    repository,
    client: {
      async exchangeAuthorizationCode(input) {
        exchangeCalls += 1;
        return options.exchange?.(input) ?? tokenResponse();
      },
      async refreshAccessToken(input) {
        refreshCalls += 1;
        return options.refresh?.(input.refreshToken) ?? tokenResponse();
      },
    },
    cipher,
    ownershipLookup: options.ownershipLookup ?? (async () => true),
    config: {
      clientId: "app-123",
      redirectUri: new URL("https://api.vapt.test/payments/mercado-pago/oauth/callback"),
      frontendUrl: new URL("https://app.vapt.test"),
      credentialKeyId: "env-v1",
      stateTtlMs: 10 * 60 * 1000,
    },
    now: () => new Date(now),
  });

  return {
    service,
    memory,
    get exchangeCalls() {
      return exchangeCalls;
    },
    get refreshCalls() {
      return refreshCalls;
    },
  };
}

test("beginConnection creates a one-time state and S256 PKCE challenge", async () => {
  const fixture = createService();
  const result = await fixture.service.beginConnection({
    restaurantId: RESTAURANT_ID,
    userId: "owner-1",
    environment: "sandbox",
  });

  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin, "https://auth.mercadopago.com");
  assert.equal(url.pathname, "/authorization");
  assert.equal(url.searchParams.get("client_id"), "app-123");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.vapt.test/payments/mercado-pago/oauth/callback");

  const state = url.searchParams.get("state");
  assert.ok(state);
  const stateHash = createHash("sha256").update(state).digest("hex");
  const stored = fixture.memory.states.get(stateHash);
  assert.ok(stored);
  assert.equal(stored.restaurantId, RESTAURANT_ID);
  assert.equal(stored.environment, "sandbox");
  assert.equal(stored.codeVerifierEncrypted.includes(state), false);

  const verifier = cipher.decrypt(stored.codeVerifierEncrypted, stateHash);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(url.searchParams.get("code_challenge"), expectedChallenge);
});

test("beginConnection rejects access to another restaurant tenant", async () => {
  const fixture = createService({ ownershipLookup: async () => false });

  await assert.rejects(
    fixture.service.beginConnection({
      restaurantId: RESTAURANT_ID,
      userId: "not-owner",
      environment: "production",
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 403,
  );
  assert.equal(fixture.memory.states.size, 0);
});

test("callback rejects an absent, expired, or reused state without exchanging tokens", async () => {
  const fixture = createService();

  await assert.rejects(
    fixture.service.handleCallback({ state: "", code: "code-1" }),
    (error: unknown) => error instanceof AppError && error.code === "oauth_state_invalid",
  );

  await assert.rejects(
    fixture.service.handleCallback({ state: "unknown-state", code: "code-1" }),
    (error: unknown) => error instanceof AppError && error.code === "oauth_state_invalid",
  );

  const connection = await fixture.service.beginConnection({
    restaurantId: RESTAURANT_ID,
    userId: "owner-1",
    environment: "production",
  });
  const state = new URL(connection.authorizationUrl).searchParams.get("state")!;
  await fixture.service.handleCallback({ state, code: "code-1" });
  await assert.rejects(
    fixture.service.handleCallback({ state, code: "code-1" }),
    (error: unknown) => error instanceof AppError && error.code === "oauth_state_invalid",
  );
  assert.equal(fixture.exchangeCalls, 1);
});

test("denied callback consumes state and never exchanges a token", async () => {
  const fixture = createService();
  const connection = await fixture.service.beginConnection({
    restaurantId: RESTAURANT_ID,
    userId: "owner-1",
    environment: "production",
  });
  const state = new URL(connection.authorizationUrl).searchParams.get("state")!;

  const result = await fixture.service.handleCallback({
    state,
    error: "access_denied",
    errorDescription: "seller denied access",
  });

  assert.deepEqual(result, {
    restaurantId: RESTAURANT_ID,
    status: "denied",
  });
  assert.equal(fixture.exchangeCalls, 0);
  await assert.rejects(
    fixture.service.handleCallback({ state, code: "late-code" }),
    (error: unknown) => error instanceof AppError && error.code === "oauth_state_invalid",
  );
});

test("successful callback exchanges PKCE code and stores only encrypted rotating credentials", async () => {
  let exchangeInput: Record<string, unknown> | null = null;
  const fixture = createService({
    exchange: async (input) => {
      exchangeInput = input;
      return tokenResponse();
    },
  });
  const connection = await fixture.service.beginConnection({
    restaurantId: RESTAURANT_ID,
    userId: "owner-1",
    environment: "sandbox",
  });
  const state = new URL(connection.authorizationUrl).searchParams.get("state")!;

  const result = await fixture.service.handleCallback({ state, code: "authorization-code" });

  assert.deepEqual(result, { restaurantId: RESTAURANT_ID, status: "connected" });
  const capturedExchangeInput = exchangeInput as unknown as {
    code: string;
    testToken: boolean;
    codeVerifier: string;
  };
  assert.equal(capturedExchangeInput.code, "authorization-code");
  assert.equal(capturedExchangeInput.testToken, true);
  assert.ok(capturedExchangeInput.codeVerifier.length >= 43);
  const connectedAccount = fixture.memory.account;
  assert.ok(connectedAccount?.accessTokenEncrypted);
  assert.ok(connectedAccount.refreshTokenEncrypted);
  assert.equal(connectedAccount.externalAccountId, "seller-123");
  assert.equal(connectedAccount.status, "active");
  assert.equal(connectedAccount.accessTokenEncrypted.includes("APP_USR-access-token"), false);
  assert.equal(connectedAccount.refreshTokenEncrypted.includes("TG-refresh-token"), false);
  assert.equal(result && "accessToken" in result, false);
});

test("refreshConnection replaces both access and refresh tokens atomically", async () => {
  const fixture = createService({
    refresh: async (refreshToken) => {
      assert.equal(refreshToken, "TG-refresh-token");
      return tokenResponse({
        accessToken: "APP_USR-new-access",
        refreshToken: "TG-new-refresh",
      });
    },
  });
  const connection = await fixture.service.beginConnection({
    restaurantId: RESTAURANT_ID,
    userId: "owner-1",
    environment: "production",
  });
  const state = new URL(connection.authorizationUrl).searchParams.get("state")!;
  await fixture.service.handleCallback({ state, code: "authorization-code" });

  const refreshed = await fixture.service.refreshConnection({
    restaurantId: RESTAURANT_ID,
    environment: "production",
  });

  assert.equal(refreshed.status, "active");
  assert.equal(fixture.refreshCalls, 1);
  const account = fixture.memory.account!;
  const aad = `${RESTAURANT_ID}:mercado_pago:production`;
  assert.equal(cipher.decrypt(account.accessTokenEncrypted!, aad), "APP_USR-new-access");
  assert.equal(cipher.decrypt(account.refreshTokenEncrypted!, aad), "TG-new-refresh");
});

test("status and disconnect never expose credentials", async () => {
  const fixture = createService();
  const connection = await fixture.service.beginConnection({
    restaurantId: RESTAURANT_ID,
    userId: "owner-1",
    environment: "production",
  });
  const state = new URL(connection.authorizationUrl).searchParams.get("state")!;
  await fixture.service.handleCallback({ state, code: "authorization-code" });

  const status = await fixture.service.getStatus({
    restaurantId: RESTAURANT_ID,
    userId: "owner-1",
    environment: "production",
  });
  assert.deepEqual(status, {
    connected: true,
    status: "active",
    externalAccountId: "seller-123",
    environment: "production",
    tokenExpiresAt: "2027-02-02T12:00:00.000Z",
  });
  assert.equal(JSON.stringify(status).includes("APP_USR"), false);

  const disconnected = await fixture.service.disconnect({
    restaurantId: RESTAURANT_ID,
    userId: "owner-1",
    environment: "production",
  });
  assert.deepEqual(disconnected, { connected: false, status: "disconnected" });
  assert.equal(fixture.memory.account?.accessTokenEncrypted, null);
  assert.equal(fixture.memory.account?.refreshTokenEncrypted, null);
});

test("Mercado Pago client sends authorization code and refresh grants only to the token endpoint", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = createMercadoPagoOAuthClient({
    clientId: "app-123",
    clientSecret: "client-secret",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        access_token: "APP_USR-token",
        refresh_token: "TG-token",
        token_type: "bearer",
        expires_in: 3600,
        scope: "read write offline_access",
        user_id: 42,
        live_mode: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await client.exchangeAuthorizationCode({
    code: "authorization-code",
    redirectUri: "https://api.vapt.test/callback",
    codeVerifier: "verifier",
    testToken: true,
  });
  await client.refreshAccessToken({ refreshToken: "TG-token" });

  assert.equal(requests[0]?.url, "https://api.mercadopago.com/oauth/token");
  assert.deepEqual(requests[0]?.body, {
    client_id: "app-123",
    client_secret: "client-secret",
    grant_type: "authorization_code",
    code: "authorization-code",
    redirect_uri: "https://api.vapt.test/callback",
    code_verifier: "verifier",
    test_token: true,
  });
  assert.deepEqual(requests[1]?.body, {
    client_id: "app-123",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "TG-token",
  });
});

test("Mercado Pago client sanitizes provider errors without leaking credentials", async () => {
  const client = createMercadoPagoOAuthClient({
    clientId: "app-123",
    clientSecret: "super-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      message: "invalid super-secret and APP_USR-sensitive-token",
      error: "invalid_grant",
    }), { status: 400, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    client.refreshAccessToken({ refreshToken: "TG-sensitive" }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "mercado_pago_oauth_failed" &&
      error.statusCode === 424 &&
      error.message === "Mercado Pago OAuth request failed (invalid_grant)" &&
      !error.message.includes("super-secret") &&
      !error.message.includes("APP_USR") &&
      !error.message.includes("TG-sensitive"),
  );
});

const routeConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  host: "127.0.0.1",
  corsOrigins: ["https://app.vapt.test"],
  logLevel: "silent",
  n8n: {
    baseUrl: new URL("https://n8n.example.com"),
    timeoutMs: 5000,
    secrets: { app: "app", webhookSetup: "setup", admin: "admin" },
  },
  webhooks: {
    stripe: { signingSecret: "whsec_test", toleranceSeconds: 300 },
  },
  supabase: {
    url: new URL("https://supabase.example.com"),
    serviceRoleKey: "service-role-key",
    jwtSecret: "jwt-secret",
  },
  frontendUrl: new URL("https://app.vapt.test"),
  apiPublicUrl: new URL("https://api.vapt.test"),
  mercadoPago: {
    clientId: "app-123",
    clientSecret: "client-secret",
    redirectUri: new URL("https://api.vapt.test/payments/mercado-pago/oauth/callback"),
    webhookSecret: "webhook-secret",
    tokenEncryptionKey: encryptionKey,
    credentialKeyId: "env-v1",
  },
};

function routeToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    sub: "user-1",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const signature = createHmac("sha256", routeConfig.supabase.jwtSecret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function fakeRouteService(): MercadoPagoOAuthRouteService {
  return {
    beginConnection: async () => ({
      authorizationUrl: "https://auth.mercadopago.com/authorization?state=safe-state-1234567890",
    }),
    handleCallback: async (input) => ({
      restaurantId: RESTAURANT_ID,
      status: input.error ? "denied" : "connected",
    }),
    getStatus: async () => ({
      connected: true,
      status: "active",
      externalAccountId: "seller-123",
      environment: "production",
      tokenExpiresAt: "2027-02-02T12:00:00.000Z",
    }),
    disconnect: async () => ({ connected: false, status: "disconnected" }),
  };
}

test("connect route requires authentication and forwards only the tenant context", async () => {
  let received: unknown = null;
  const service = fakeRouteService();
  service.beginConnection = async (input) => {
    received = input;
    return { authorizationUrl: "https://auth.mercadopago.com/authorization?state=safe-state-1234567890" };
  };
  const app = Fastify({ logger: false });
  registerAuthDecorator(app);
  registerErrorHandler(app);
  await registerMercadoPagoOAuthRoutes(app, routeConfig, service);

  const missingAuth = await app.inject({
    method: "POST",
    url: `/restaurants/${RESTAURANT_ID}/payments/mercado-pago/connect`,
    payload: { environment: "sandbox" },
  });
  assert.equal(missingAuth.statusCode, 401);

  const response = await app.inject({
    method: "POST",
    url: `/restaurants/${RESTAURANT_ID}/payments/mercado-pago/connect`,
    headers: { authorization: `Bearer ${routeToken()}` },
    payload: { environment: "sandbox" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(received, {
    restaurantId: RESTAURANT_ID,
    userId: "user-1",
    environment: "sandbox",
  });
  assert.deepEqual(response.json(), {
    authorizationUrl: "https://auth.mercadopago.com/authorization?state=safe-state-1234567890",
  });
  await app.close();
});

test("OAuth callback validates state and redirects without returning credentials", async () => {
  const app = Fastify({ logger: false });
  registerAuthDecorator(app);
  registerErrorHandler(app);
  await registerMercadoPagoOAuthRoutes(app, routeConfig, fakeRouteService());

  const missingState = await app.inject({
    method: "GET",
    url: "/payments/mercado-pago/oauth/callback?code=authorization-code",
  });
  assert.equal(missingState.statusCode, 400);

  const connected = await app.inject({
    method: "GET",
    url: "/payments/mercado-pago/oauth/callback?state=safe-state-1234567890&code=authorization-code",
  });
  assert.equal(connected.statusCode, 302);
  assert.equal(
    connected.headers.location,
    "https://app.vapt.test/dashboard/settings?payment_provider=mercado_pago&connection=connected",
  );
  assert.equal(connected.body.includes("token"), false);
  await app.close();
});

test("status and disconnect routes are authenticated and never serialize tokens", async () => {
  const app = Fastify({ logger: false });
  registerAuthDecorator(app);
  registerErrorHandler(app);
  await registerMercadoPagoOAuthRoutes(app, routeConfig, fakeRouteService());
  const headers = { authorization: `Bearer ${routeToken()}` };

  const status = await app.inject({
    method: "GET",
    url: `/restaurants/${RESTAURANT_ID}/payments/mercado-pago/status?environment=production`,
    headers,
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.includes("accessToken"), false);
  assert.equal(status.body.includes("refreshToken"), false);

  const disconnected = await app.inject({
    method: "DELETE",
    url: `/restaurants/${RESTAURANT_ID}/payments/mercado-pago/connection?environment=production`,
    headers,
  });
  assert.equal(disconnected.statusCode, 200);
  assert.deepEqual(disconnected.json(), { connected: false, status: "disconnected" });
  await app.close();
});