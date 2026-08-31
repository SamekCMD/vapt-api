import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { CipherGCM, DecipherGCM } from "node:crypto";

const ENVELOPE_VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export type SecretCipher = {
  encrypt: (plaintext: string, associatedData?: string) => string;
  decrypt: (envelope: string, associatedData?: string) => string;
};

function assertEncryptionKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("Secret encryption key must contain exactly 32 bytes");
  }
}

function setAssociatedData(
  cipher: CipherGCM | DecipherGCM,
  associatedData?: string,
): void {
  if (associatedData !== undefined) {
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
  }
}

export function parseSecretEncryptionKey(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("Secret encryption key must be valid base64");
  }

  const key = Buffer.from(normalized, "base64");
  assertEncryptionKey(key);
  return key;
}

export function createSecretCipher(key: Buffer): SecretCipher {
  assertEncryptionKey(key);

  return {
    encrypt(plaintext, associatedData) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      setAssociatedData(cipher, associatedData);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      return [
        ENVELOPE_VERSION,
        iv.toString("base64url"),
        authTag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },

    decrypt(envelope, associatedData) {
      try {
        const [version, encodedIv, encodedAuthTag, encodedCiphertext, extra] =
          envelope.split(".");

        if (
          version !== ENVELOPE_VERSION ||
          !encodedIv ||
          !encodedAuthTag ||
          !encodedCiphertext ||
          extra !== undefined
        ) {
          throw new Error("invalid envelope");
        }

        const iv = Buffer.from(encodedIv, "base64url");
        const authTag = Buffer.from(encodedAuthTag, "base64url");
        const ciphertext = Buffer.from(encodedCiphertext, "base64url");
        if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
          throw new Error("invalid envelope");
        }

        const decipher = createDecipheriv("aes-256-gcm", key, iv, {
          authTagLength: AUTH_TAG_LENGTH,
        });
        setAssociatedData(decipher, associatedData);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        return plaintext.toString("utf8");
      } catch {
        throw new Error("Encrypted secret could not be authenticated");
      }
    },
  };
}
