import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";

import { AppError } from "./errors.js";
import { createSupabaseJwtVerifier } from "./jwt.js";

const issuer = "https://supabase.example.com/auth/v1";
const audience = "authenticated";
const legacyJwtSecret = "legacy-secret-with-enough-entropy";
const subject = "88440873-a8a0-4b26-8987-421ce96f5f5d";

const primaryKeys = await generateKeyPair("ES256");
const primaryJwk = await exportJWK(primaryKeys.publicKey);
primaryJwk.kid = "primary";
primaryJwk.alg = "ES256";
primaryJwk.use = "sig";

const jwksServer = createServer((request, response) => {
  if (request.url === "/unavailable") {
    response.writeHead(503);
    response.end();
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ keys: [primaryJwk] }));
});

await new Promise<void>((resolve) => {
  jwksServer.listen(0, "127.0.0.1", resolve);
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((error) => error ? reject(error) : resolve());
    jwksServer.closeAllConnections();
  });
});

const address = jwksServer.address();
if (!address || typeof address === "string") {
  throw new Error("JWKS test server did not expose a TCP address");
}

const verifier = createSupabaseJwtVerifier({
  issuer,
  audience,
  jwksUrl: new URL(`http://127.0.0.1:${address.port}/jwks.json`),
  legacyJwtSecret,
});

type TokenOverrides = {
  issuer?: string;
  audience?: string;
  subject?: string;
  expirationTime?: number | string;
};

async function createAsymmetricToken(overrides: TokenOverrides = {}): Promise<string> {
  return new SignJWT({
    email: "owner@example.com",
    role: "authenticated",
  })
    .setProtectedHeader({ alg: "ES256", kid: "primary", typ: "JWT" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(overrides.subject ?? subject)
    .setIssuedAt()
    .setExpirationTime(overrides.expirationTime ?? "1h")
    .sign(primaryKeys.privateKey);
}

async function expectUnauthorized(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, "unauthorized");
    assert.equal(error.message, "Unauthorized");
    return true;
  });
}

test("verifies an asymmetric Supabase token with the remote JWKS", async () => {
  const claims = await verifier(await createAsymmetricToken());

  assert.deepEqual(claims, {
    sub: subject,
    email: "owner@example.com",
    role: "authenticated",
    iss: issuer,
    aud: audience,
    exp: claims.exp,
  });
  assert.equal(typeof claims.exp, "number");
});

test("verifies a legacy HS256 token through JOSE", async () => {
  const token = await new SignJWT({ email: "legacy@example.com", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(legacyJwtSecret));

  const claims = await verifier(token);

  assert.equal(claims.sub, subject);
  assert.equal(claims.email, "legacy@example.com");
});

test("rejects an expired token", async () => {
  await expectUnauthorized(verifier(await createAsymmetricToken({ expirationTime: 0 })));
});

test("rejects a token from another issuer", async () => {
  await expectUnauthorized(verifier(await createAsymmetricToken({
    issuer: "https://attacker.example.com/auth/v1",
  })));
});

test("rejects a token for another audience", async () => {
  await expectUnauthorized(verifier(await createAsymmetricToken({ audience: "service_role" })));
});

test("rejects a malformed audience array", async () => {
  const token = await new SignJWT({
    role: "authenticated",
    aud: [audience, 42] as unknown as string[],
  })
    .setProtectedHeader({ alg: "ES256", kid: "primary", typ: "JWT" })
    .setIssuer(issuer)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(primaryKeys.privateKey);

  await expectUnauthorized(verifier(token));
});

test("rejects a token without a subject", async () => {
  const token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "primary", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(primaryKeys.privateKey);

  await expectUnauthorized(verifier(token));
});

test("rejects a token signed by an unknown key", async () => {
  const unknownKeys = await generateKeyPair("ES256");
  const token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "unknown", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(unknownKeys.privateKey);

  await expectUnauthorized(verifier(token));
});

test("rejects a token with a tampered signature", async () => {
  const token = await createAsymmetricToken();
  const parts = token.split(".");
  const signature = parts[2];
  parts[2] = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;

  await expectUnauthorized(verifier(parts.join(".")));
});

test("reports remote JWKS infrastructure failures as unavailable", async () => {
  const unavailableVerifier = createSupabaseJwtVerifier({
    issuer,
    audience,
    jwksUrl: new URL(`http://127.0.0.1:${address.port}/unavailable`),
    legacyJwtSecret,
  });

  await assert.rejects(unavailableVerifier(await createAsymmetricToken()), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "authentication_unavailable");
    return true;
  });
});
