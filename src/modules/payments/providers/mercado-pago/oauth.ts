import { createHash, randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SecretCipher } from "../../../../lib/crypto.js";
import { AppError } from "../../../../lib/errors.js";
import {
  createRestaurantAccessChecker,
  type OwnershipLookup,
} from "../../../../lib/permissions.js";
import type { PaymentEnvironment } from "../../types.js";
import type {
  MercadoPagoOAuthClient,
  MercadoPagoTokenResponse,
} from "./client.js";

const AUTHORIZATION_ENDPOINT = "https://auth.mercadopago.com/authorization";

export type OAuthStateRecord = {
  id: string;
  restaurantId: string;
  environment: PaymentEnvironment;
  stateHash: string;
  codeVerifierEncrypted: string;
  credentialKeyId: string;
  redirectUri: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type ProviderCredentialRecord = {
  id: string;
  restaurantId: string;
  environment: PaymentEnvironment;
  status: "disconnected" | "connecting" | "active" | "error";
  externalAccountId: string | null;
  capabilities: Readonly<Record<string, unknown>>;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  credentialKeyId: string | null;
  tokenExpiresAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastError: string | null;
  version: number;
};

export interface MercadoPagoOAuthRepository {
  saveOAuthState(
    input: Omit<OAuthStateRecord, "id" | "consumedAt" | "createdAt">,
  ): Promise<OAuthStateRecord>;
  consumeOAuthState(input: {
    stateHash: string;
    consumedAt: string;
  }): Promise<OAuthStateRecord | null>;
  upsertProviderAccount(
    input: Omit<ProviderCredentialRecord, "id" | "version" | "disconnectedAt" | "lastError">,
  ): Promise<ProviderCredentialRecord>;
  findProviderAccount(
    restaurantId: string,
    environment: PaymentEnvironment,
  ): Promise<ProviderCredentialRecord | null>;
  updateProviderTokens(input: {
    accountId: string;
    expectedVersion: number;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string;
    credentialKeyId: string;
    tokenExpiresAt: string;
  }): Promise<ProviderCredentialRecord | null>;
  disconnectProviderAccount(input: {
    restaurantId: string;
    environment: PaymentEnvironment;
    disconnectedAt: string;
  }): Promise<ProviderCredentialRecord | null>;
}

type RawOAuthState = {
  id: string;
  restaurant_id: string;
  environment: PaymentEnvironment;
  state_hash: string;
  code_verifier_encrypted: string;
  credential_key_id: string;
  redirect_uri: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

type RawProviderCredential = {
  id: string;
  restaurant_id: string;
  environment: PaymentEnvironment;
  status: ProviderCredentialRecord["status"];
  external_account_id: string | null;
  capabilities: Record<string, unknown> | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  credential_key_id: string | null;
  token_expires_at: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
  version: number;
};

const OAUTH_STATE_COLUMNS = [
  "id",
  "restaurant_id",
  "environment",
  "state_hash",
  "code_verifier_encrypted",
  "credential_key_id",
  "redirect_uri",
  "expires_at",
  "consumed_at",
  "created_at",
].join(", ");

const PROVIDER_CREDENTIAL_COLUMNS = [
  "id",
  "restaurant_id",
  "environment",
  "status",
  "external_account_id",
  "capabilities",
  "access_token_encrypted",
  "refresh_token_encrypted",
  "credential_key_id",
  "token_expires_at",
  "connected_at",
  "disconnected_at",
  "last_error",
  "version",
].join(", ");

function oauthStorageFailure(message: string): never {
  throw new AppError(500, "payment_storage_error", message);
}

function mapOAuthState(row: RawOAuthState): OAuthStateRecord {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    environment: row.environment,
    stateHash: row.state_hash,
    codeVerifierEncrypted: row.code_verifier_encrypted,
    credentialKeyId: row.credential_key_id,
    redirectUri: row.redirect_uri,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapProviderCredential(row: RawProviderCredential): ProviderCredentialRecord {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    environment: row.environment,
    status: row.status,
    externalAccountId: row.external_account_id,
    capabilities: row.capabilities ?? {},
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    credentialKeyId: row.credential_key_id,
    tokenExpiresAt: row.token_expires_at,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    lastError: row.last_error,
    version: row.version,
  };
}

export function createMercadoPagoOAuthRepository(
  client: SupabaseClient,
): MercadoPagoOAuthRepository {
  return {
    async saveOAuthState(input) {
      const result = await client
        .from("payment_oauth_states")
        .insert({
          restaurant_id: input.restaurantId,
          provider: "mercado_pago",
          environment: input.environment,
          state_hash: input.stateHash,
          code_verifier_encrypted: input.codeVerifierEncrypted,
          credential_key_id: input.credentialKeyId,
          redirect_uri: input.redirectUri,
          expires_at: input.expiresAt,
        })
        .select(OAUTH_STATE_COLUMNS)
        .single<RawOAuthState>();

      if (result.error) oauthStorageFailure("Failed to save OAuth state");
      return mapOAuthState(result.data);
    },

    async consumeOAuthState(input) {
      const result = await client
        .from("payment_oauth_states")
        .update({ consumed_at: input.consumedAt })
        .eq("state_hash", input.stateHash)
        .is("consumed_at", null)
        .gt("expires_at", input.consumedAt)
        .select(OAUTH_STATE_COLUMNS)
        .maybeSingle<RawOAuthState>();

      if (result.error) oauthStorageFailure("Failed to consume OAuth state");
      return result.data ? mapOAuthState(result.data) : null;
    },

    async upsertProviderAccount(input) {
      const result = await client
        .from("payment_provider_accounts")
        .upsert({
          restaurant_id: input.restaurantId,
          provider: "mercado_pago",
          environment: input.environment,
          status: input.status,
          external_account_id: input.externalAccountId,
          capabilities: input.capabilities,
          access_token_encrypted: input.accessTokenEncrypted,
          refresh_token_encrypted: input.refreshTokenEncrypted,
          credential_key_id: input.credentialKeyId,
          token_expires_at: input.tokenExpiresAt,
          connected_at: input.connectedAt,
          disconnected_at: null,
          last_error: null,
        }, {
          onConflict: "restaurant_id,provider,environment",
        })
        .select(PROVIDER_CREDENTIAL_COLUMNS)
        .single<RawProviderCredential>();

      if (result.error) oauthStorageFailure("Failed to save Mercado Pago connection");
      return mapProviderCredential(result.data);
    },

    async findProviderAccount(restaurantId, environment) {
      const result = await client
        .from("payment_provider_accounts")
        .select(PROVIDER_CREDENTIAL_COLUMNS)
        .eq("restaurant_id", restaurantId)
        .eq("provider", "mercado_pago")
        .eq("environment", environment)
        .maybeSingle<RawProviderCredential>();

      if (result.error) oauthStorageFailure("Failed to load Mercado Pago connection");
      return result.data ? mapProviderCredential(result.data) : null;
    },

    async updateProviderTokens(input) {
      const result = await client
        .from("payment_provider_accounts")
        .update({
          access_token_encrypted: input.accessTokenEncrypted,
          refresh_token_encrypted: input.refreshTokenEncrypted,
          credential_key_id: input.credentialKeyId,
          token_expires_at: input.tokenExpiresAt,
          status: "active",
          last_error: null,
          version: input.expectedVersion + 1,
        })
        .eq("id", input.accountId)
        .eq("version", input.expectedVersion)
        .select(PROVIDER_CREDENTIAL_COLUMNS)
        .maybeSingle<RawProviderCredential>();

      if (result.error) oauthStorageFailure("Failed to rotate Mercado Pago credentials");
      return result.data ? mapProviderCredential(result.data) : null;
    },

    async disconnectProviderAccount(input) {
      const existing = await this.findProviderAccount(
        input.restaurantId,
        input.environment,
      );
      if (!existing) return null;

      const result = await client
        .from("payment_provider_accounts")
        .update({
          status: "disconnected",
          access_token_encrypted: null,
          refresh_token_encrypted: null,
          credential_key_id: null,
          token_expires_at: null,
          disconnected_at: input.disconnectedAt,
          last_error: null,
          version: existing.version + 1,
        })
        .eq("id", existing.id)
        .eq("version", existing.version)
        .select(PROVIDER_CREDENTIAL_COLUMNS)
        .maybeSingle<RawProviderCredential>();

      if (result.error) oauthStorageFailure("Failed to disconnect Mercado Pago");
      return result.data ? mapProviderCredential(result.data) : null;
    },
  };
}

export type MercadoPagoOAuthService = ReturnType<typeof createMercadoPagoOAuthService>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function credentialsAad(restaurantId: string, environment: PaymentEnvironment): string {
  return `${restaurantId}:mercado_pago:${environment}`;
}

function tokenExpiration(now: Date, token: MercadoPagoTokenResponse): string {
  return new Date(now.getTime() + token.expiresIn * 1000).toISOString();
}

export function createMercadoPagoOAuthService(input: {
  repository: MercadoPagoOAuthRepository;
  client: MercadoPagoOAuthClient;
  cipher: SecretCipher;
  ownershipLookup: OwnershipLookup;
  config: {
    clientId: string;
    redirectUri: URL;
    frontendUrl: URL;
    credentialKeyId: string;
    stateTtlMs: number;
  };
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const assertRestaurantAccess = createRestaurantAccessChecker(input.ownershipLookup);

  async function persistTokens(
    state: OAuthStateRecord,
    token: MercadoPagoTokenResponse,
  ): Promise<ProviderCredentialRecord> {
    const connectedAt = now();
    const aad = credentialsAad(state.restaurantId, state.environment);
    return input.repository.upsertProviderAccount({
      restaurantId: state.restaurantId,
      environment: state.environment,
      status: "active",
      externalAccountId: token.userId,
      capabilities: {
        oauthConnection: true,
        scope: token.scope,
        liveMode: token.liveMode,
      },
      accessTokenEncrypted: input.cipher.encrypt(token.accessToken, aad),
      refreshTokenEncrypted: input.cipher.encrypt(token.refreshToken, aad),
      credentialKeyId: input.config.credentialKeyId,
      tokenExpiresAt: tokenExpiration(connectedAt, token),
      connectedAt: connectedAt.toISOString(),
    });
  }

  return {
    async beginConnection(connectionInput: {
      restaurantId: string;
      userId: string;
      environment: PaymentEnvironment;
    }) {
      await assertRestaurantAccess({
        userId: connectionInput.userId,
        restaurantId: connectionInput.restaurantId,
      });

      const state = randomBytes(32).toString("base64url");
      const stateHash = hash(state);
      const codeVerifier = randomBytes(64).toString("base64url");
      const codeChallenge = createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      const createdAt = now();
      await input.repository.saveOAuthState({
        restaurantId: connectionInput.restaurantId,
        environment: connectionInput.environment,
        stateHash,
        codeVerifierEncrypted: input.cipher.encrypt(codeVerifier, stateHash),
        credentialKeyId: input.config.credentialKeyId,
        redirectUri: input.config.redirectUri.toString(),
        expiresAt: new Date(createdAt.getTime() + input.config.stateTtlMs).toISOString(),
      });

      const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
      authorizationUrl.searchParams.set("client_id", input.config.clientId);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("platform_id", "mp");
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("redirect_uri", input.config.redirectUri.toString());
      authorizationUrl.searchParams.set("code_challenge", codeChallenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");

      return { authorizationUrl: authorizationUrl.toString() };
    },

    async handleCallback(callbackInput: {
      state: string;
      code?: string;
      error?: string;
      errorDescription?: string;
    }) {
      if (!callbackInput.state) {
        throw new AppError(400, "oauth_state_invalid", "OAuth state is invalid or expired");
      }

      const stateHash = hash(callbackInput.state);
      const state = await input.repository.consumeOAuthState({
        stateHash,
        consumedAt: now().toISOString(),
      });
      if (!state) {
        throw new AppError(400, "oauth_state_invalid", "OAuth state is invalid or expired");
      }

      if (callbackInput.error) {
        return { restaurantId: state.restaurantId, status: "denied" as const };
      }
      if (!callbackInput.code) {
        throw new AppError(400, "oauth_code_missing", "OAuth authorization code is missing");
      }

      const codeVerifier = input.cipher.decrypt(
        state.codeVerifierEncrypted,
        state.stateHash,
      );
      const token = await input.client.exchangeAuthorizationCode({
        code: callbackInput.code,
        redirectUri: state.redirectUri,
        codeVerifier,
        testToken: state.environment === "sandbox",
      });
      await persistTokens(state, token);

      return { restaurantId: state.restaurantId, status: "connected" as const };
    },

    async refreshConnection(refreshInput: {
      restaurantId: string;
      environment: PaymentEnvironment;
    }) {
      const account = await input.repository.findProviderAccount(
        refreshInput.restaurantId,
        refreshInput.environment,
      );
      if (!account?.refreshTokenEncrypted || account.status !== "active") {
        throw new AppError(409, "oauth_not_connected", "Mercado Pago is not connected");
      }

      const aad = credentialsAad(refreshInput.restaurantId, refreshInput.environment);
      const refreshToken = input.cipher.decrypt(account.refreshTokenEncrypted, aad);
      const token = await input.client.refreshAccessToken({ refreshToken });
      const refreshedAt = now();
      const updated = await input.repository.updateProviderTokens({
        accountId: account.id,
        expectedVersion: account.version,
        accessTokenEncrypted: input.cipher.encrypt(token.accessToken, aad),
        refreshTokenEncrypted: input.cipher.encrypt(token.refreshToken, aad),
        credentialKeyId: input.config.credentialKeyId,
        tokenExpiresAt: tokenExpiration(refreshedAt, token),
      });
      if (!updated) {
        throw new AppError(409, "oauth_refresh_conflict", "OAuth credentials changed concurrently");
      }

      return { status: updated.status, tokenExpiresAt: updated.tokenExpiresAt };
    },

    async getStatus(statusInput: {
      restaurantId: string;
      userId: string;
      environment: PaymentEnvironment;
    }) {
      await assertRestaurantAccess({
        userId: statusInput.userId,
        restaurantId: statusInput.restaurantId,
      });
      const account = await input.repository.findProviderAccount(
        statusInput.restaurantId,
        statusInput.environment,
      );
      return {
        connected: account?.status === "active",
        status: account?.status ?? "disconnected",
        externalAccountId: account?.externalAccountId ?? null,
        environment: statusInput.environment,
        tokenExpiresAt: account?.tokenExpiresAt ?? null,
      };
    },

    async disconnect(disconnectInput: {
      restaurantId: string;
      userId: string;
      environment: PaymentEnvironment;
    }) {
      await assertRestaurantAccess({
        userId: disconnectInput.userId,
        restaurantId: disconnectInput.restaurantId,
      });
      await input.repository.disconnectProviderAccount({
        restaurantId: disconnectInput.restaurantId,
        environment: disconnectInput.environment,
        disconnectedAt: now().toISOString(),
      });
      return { connected: false, status: "disconnected" as const };
    },
  };
}
