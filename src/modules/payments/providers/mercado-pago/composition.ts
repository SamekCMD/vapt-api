import type { AppConfig } from "../../../../lib/config.js";
import { createSecretCipher } from "../../../../lib/crypto.js";
import type { Queryable } from "../../../../lib/database.js";
import { AppError } from "../../../../lib/errors.js";
import type { OwnershipLookup } from "../../../../lib/permissions.js";
import { createMercadoPagoOAuthClient } from "./client.js";
import { createMercadoPagoOAuthRepository, createMercadoPagoOAuthService, type MercadoPagoOAuthService } from "./oauth.js";

export function createMercadoPagoOAuthServiceFromConfig(
  config: AppConfig,
  database: Queryable,
  ownershipLookup: OwnershipLookup,
): MercadoPagoOAuthService {
  if (!config.mercadoPago || !config.frontendUrl) {
    throw new AppError(503, "mercado_pago_not_configured", "Mercado Pago OAuth is not configured");
  }
  return createMercadoPagoOAuthService({
    repository: createMercadoPagoOAuthRepository(database),
    client: createMercadoPagoOAuthClient({
      clientId: config.mercadoPago.clientId,
      clientSecret: config.mercadoPago.clientSecret,
    }),
    cipher: createSecretCipher(config.mercadoPago.tokenEncryptionKey),
    ownershipLookup,
    config: {
      clientId: config.mercadoPago.clientId,
      redirectUri: config.mercadoPago.redirectUri,
      frontendUrl: config.frontendUrl,
      credentialKeyId: config.mercadoPago.credentialKeyId,
      stateTtlMs: 10 * 60 * 1000,
    },
  });
}
