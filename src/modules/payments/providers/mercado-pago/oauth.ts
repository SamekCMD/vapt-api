import { createHash, randomBytes } from "node:crypto";

import type { SecretCipher } from "../../../../lib/crypto.js";
import type { Queryable } from "../../../../lib/database.js";
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
const STATE_RETURN_ORIGIN_SEPARATOR = ".";

function createOAuthState(returnOrigin?: string): string {
  const nonce = randomBytes(32).toString("base64url");
  if (!returnOrigin) return nonce;

  const encodedOrigin = Buffer.from(returnOrigin, "utf8").toString("base64url");
  return `${nonce}${STATE_RETURN_ORIGIN_SEPARATOR}${encodedOrigin}`;
}

function readReturnOriginFromState(state: string): string | undefined {
  const separatorIndex = state.indexOf(STATE_RETURN_ORIGIN_SEPARATOR);
  if (separatorIndex === -1) return undefined;

  try {
    const encodedOrigin = state.slice(separatorIndex + 1);
    const decodedOrigin = Buffer.from(encodedOrigin, "base64url").toString("utf8");
    const url = new URL(decodedOrigin);
    return url.origin === decodedOrigin ? decodedOrigin : undefined;
  } catch {
    return undefined;
  }
}

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
  findProviderAccountById(
    accountId: string,
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
  expires_at: string | Date;
  consumed_at: string | Date | null;
  created_at: string | Date;
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
  token_expires_at: string | Date | null;
  connected_at: string | Date | null;
  disconnected_at: string | Date | null;
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

function isoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoNullable(value: string | Date | null): string | null {
  return value === null ? null : isoString(value);
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
    expiresAt: isoString(row.expires_at),
    consumedAt: isoNullable(row.consumed_at),
    createdAt: isoString(row.created_at),
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
    tokenExpiresAt: isoNullable(row.token_expires_at),
    connectedAt: isoNullable(row.connected_at),
    disconnectedAt: isoNullable(row.disconnected_at),
    lastError: row.last_error,
    version: row.version,
  };
}

export function createMercadoPagoOAuthRepository(
  database: Queryable,
): MercadoPagoOAuthRepository {
  return {
    async saveOAuthState(input) {
      try {
        const result = await database.query<RawOAuthState>(
          `insert into public.payment_oauth_states (
            restaurant_id,
            provider,
            environment,
            state_hash,
            code_verifier_encrypted,
            credential_key_id,
            redirect_uri,
            expires_at
          ) values (
            $1::uuid, 'mercado_pago', $2::text, $3::text,
            $4::text, $5::text, $6::text, $7::timestamptz
          )
          returning ${OAUTH_STATE_COLUMNS}`,
          [
            input.restaurantId,
            input.environment,
            input.stateHash,
            input.codeVerifierEncrypted,
            input.credentialKeyId,
            input.redirectUri,
            input.expiresAt,
          ],
        );
        const row = result.rows[0];
        if (!row) oauthStorageFailure("Failed to save OAuth state");
        return mapOAuthState(row);
      } catch (error) {
        if (error instanceof AppError) throw error;
        oauthStorageFailure("Failed to save OAuth state");
      }
    },

    async consumeOAuthState(input) {
      try {
        const result = await database.query<RawOAuthState>(
          `update public.payment_oauth_states
          set consumed_at = $2::timestamptz
          where state_hash = $1::text
            and consumed_at is null
            and expires_at > $2::timestamptz
          returning ${OAUTH_STATE_COLUMNS}`,
          [input.stateHash, input.consumedAt],
        );
        return result.rows[0] ? mapOAuthState(result.rows[0]) : null;
      } catch {
        oauthStorageFailure("Failed to consume OAuth state");
      }
    },

    async upsertProviderAccount(input) {
      try {
        const result = await database.query<RawProviderCredential>(
          `insert into public.payment_provider_accounts (
            restaurant_id,
            provider,
            environment,
            status,
            external_account_id,
            capabilities,
            access_token_encrypted,
            refresh_token_encrypted,
            credential_key_id,
            token_expires_at,
            connected_at,
            disconnected_at,
            last_error
          ) values (
            $1::uuid, 'mercado_pago', $2::text, $3::text, $4::text,
            $5::jsonb, $6::text, $7::text, $8::text, $9::timestamptz,
            $10::timestamptz, null, null
          )
          on conflict (restaurant_id, provider, environment) do update
          set status = excluded.status,
              external_account_id = excluded.external_account_id,
              capabilities = excluded.capabilities,
              access_token_encrypted = excluded.access_token_encrypted,
              refresh_token_encrypted = excluded.refresh_token_encrypted,
              credential_key_id = excluded.credential_key_id,
              token_expires_at = excluded.token_expires_at,
              connected_at = excluded.connected_at,
              disconnected_at = null,
              last_error = null,
              version = payment_provider_accounts.version + 1,
              updated_at = now()
          returning ${PROVIDER_CREDENTIAL_COLUMNS}`,
          [
            input.restaurantId,
            input.environment,
            input.status,
            input.externalAccountId,
            input.capabilities,
            input.accessTokenEncrypted,
            input.refreshTokenEncrypted,
            input.credentialKeyId,
            input.tokenExpiresAt,
            input.connectedAt,
          ],
        );
        const row = result.rows[0];
        if (!row) oauthStorageFailure("Failed to save Mercado Pago connection");
        return mapProviderCredential(row);
      } catch (error) {
        if (error instanceof AppError) throw error;
        oauthStorageFailure("Failed to save Mercado Pago connection");
      }
    },

    async findProviderAccount(restaurantId, environment) {
      try {
        const result = await database.query<RawProviderCredential>(
          `select ${PROVIDER_CREDENTIAL_COLUMNS}
          from public.payment_provider_accounts
          where restaurant_id = $1::uuid
            and provider = 'mercado_pago'
            and environment = $2::text
          limit 1`,
          [restaurantId, environment],
        );
        return result.rows[0] ? mapProviderCredential(result.rows[0]) : null;
      } catch {
        oauthStorageFailure("Failed to load Mercado Pago connection");
      }
    },

    async findProviderAccountById(accountId) {
      try {
        const result = await database.query<RawProviderCredential>(
          `select ${PROVIDER_CREDENTIAL_COLUMNS}
          from public.payment_provider_accounts
          where id = $1::uuid and provider = 'mercado_pago'
          limit 1`,
          [accountId],
        );
        return result.rows[0] ? mapProviderCredential(result.rows[0]) : null;
      } catch {
        oauthStorageFailure("Failed to load Mercado Pago connection");
      }
    },

    async updateProviderTokens(input) {
      try {
        const result = await database.query<RawProviderCredential>(
          `update public.payment_provider_accounts
          set access_token_encrypted = $1::text,
              refresh_token_encrypted = $2::text,
              credential_key_id = $3::text,
              token_expires_at = $4::timestamptz,
              status = 'active',
              last_error = null,
              version = version + 1,
              updated_at = now()
          where id = $5::uuid
            and provider = 'mercado_pago'
            and version = $6::integer
          returning ${PROVIDER_CREDENTIAL_COLUMNS}`,
          [
            input.accessTokenEncrypted,
            input.refreshTokenEncrypted,
            input.credentialKeyId,
            input.tokenExpiresAt,
            input.accountId,
            input.expectedVersion,
          ],
        );
        return result.rows[0] ? mapProviderCredential(result.rows[0]) : null;
      } catch {
        oauthStorageFailure("Failed to rotate Mercado Pago credentials");
      }
    },

    async disconnectProviderAccount(input) {
      try {
        const result = await database.query<RawProviderCredential>(
          `update public.payment_provider_accounts
          set status = 'disconnected',
              access_token_encrypted = null,
              refresh_token_encrypted = null,
              credential_key_id = null,
              token_expires_at = null,
              disconnected_at = $3::timestamptz,
              last_error = null,
              version = version + 1,
              updated_at = now()
          where restaurant_id = $1::uuid
            and provider = 'mercado_pago'
            and environment = $2::text
          returning ${PROVIDER_CREDENTIAL_COLUMNS}`,
          [input.restaurantId, input.environment, input.disconnectedAt],
        );
        return result.rows[0] ? mapProviderCredential(result.rows[0]) : null;
      } catch {
        oauthStorageFailure("Failed to disconnect Mercado Pago");
      }
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

function unavailableAccount(): AppError {
  return new AppError(
    409,
    "payment_account_unavailable",
    "An active Mercado Pago account is required",
  );
}

function decryptCredential(cipher: SecretCipher, encrypted: string, aad: string): string {
  try {
    return cipher.decrypt(encrypted, aad);
  } catch {
    throw unavailableAccount();
  }
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
      returnOrigin?: string;
    }) {
      await assertRestaurantAccess({
        userId: connectionInput.userId,
        restaurantId: connectionInput.restaurantId,
      });

      const state = createOAuthState(connectionInput.returnOrigin);
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

      const returnOrigin = readReturnOriginFromState(callbackInput.state);

      if (callbackInput.error) {
        return {
          restaurantId: state.restaurantId,
          status: "denied" as const,
          ...(returnOrigin ? { returnOrigin } : {}),
        };
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

      return {
        restaurantId: state.restaurantId,
        status: "connected" as const,
        ...(returnOrigin ? { returnOrigin } : {}),
      };
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

    async resolveAccessToken(resolveInput: {
      providerAccountId: string;
      restaurantId: string;
    }) {
      let account = await input.repository.findProviderAccountById(
        resolveInput.providerAccountId,
      );
      if (
        !account ||
        account.restaurantId !== resolveInput.restaurantId ||
        account.status !== "active" ||
        !account.accessTokenEncrypted ||
        !account.refreshTokenEncrypted ||
        !account.tokenExpiresAt
      ) {
        throw unavailableAccount();
      }

      const expiration = Date.parse(account.tokenExpiresAt);
      if (!Number.isFinite(expiration)) throw unavailableAccount();
      if (expiration <= now().getTime() + 60_000) {
        await this.refreshConnection({
          restaurantId: account.restaurantId,
          environment: account.environment,
        });
        account = await input.repository.findProviderAccountById(account.id);
        if (!account?.accessTokenEncrypted || account.status !== "active") {
          throw unavailableAccount();
        }
      }

      return decryptCredential(
        input.cipher,
        account.accessTokenEncrypted,
        credentialsAad(account.restaurantId, account.environment),
      );
    },

    async getSafeAccountDiagnostics(diagnosticsInput: {
      providerAccountId: string;
      restaurantId: string;
    }) {
      const account = await input.repository.findProviderAccountById(
        diagnosticsInput.providerAccountId,
      );
      if (!account || account.restaurantId !== diagnosticsInput.restaurantId) {
        return null;
      }

      return {
        externalAccountId: account.externalAccountId,
        environment: account.environment,
        scope: typeof account.capabilities.scope === "string"
          ? account.capabilities.scope
          : null,
        liveMode: typeof account.capabilities.liveMode === "boolean"
          ? account.capabilities.liveMode
          : null,
      };
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
