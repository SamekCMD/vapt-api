# JWKS Authentication Transition Design

## Goal

Replace the handwritten Supabase JWT parser and HS256 signature verifier with
standards-based JOSE verification without invalidating existing self-hosted
Supabase sessions during the signing-key migration.

## Decision

The API will use a staged verifier:

1. Tokens using an asymmetric algorithm are verified against the Supabase
   remote JWKS endpoint at `/auth/v1/.well-known/jwks.json`.
2. Existing HS256 tokens are verified with `jose` and the configured legacy
   `SUPABASE_JWT_SECRET`.
3. Both paths enforce the configured issuer, the `authenticated` audience,
   expiration, and a non-empty subject.
4. Algorithm routing is explicit. HS256 is never sent to the remote JWKS and
   asymmetric tokens are never verified with the shared secret.

This transition requires no EasyPanel fork or Docker layout change. When the
self-hosted Auth service is confirmed to issue asymmetric tokens and the old
access-token lifetime has elapsed, the HS256 path can be removed separately.

## Structure

- `src/lib/jwt.ts` owns key selection, JOSE verification, claim validation,
  normalized unauthorized errors, and typed verified claims.
- `src/plugins/auth.ts` awaits verification and maps verified claims into the
  existing request authentication context.
- `src/lib/config.ts` derives the issuer and JWKS URL from `SUPABASE_URL` while
  retaining the legacy secret for the compatibility window and current order
  token signing usages.
- The remote JWKS resolver is cached by `jose`; tests inject a local resolver
  or local HTTP JWKS fixture and never depend on the production Supabase host.

## Security Boundaries

- Accepted asymmetric algorithms are allowlisted.
- The legacy path accepts only HS256.
- `iss`, `aud`, `exp`, and `sub` are mandatory for every accepted token.
- Unknown keys, malformed tokens, unsupported algorithms, and cryptographic or
  claim failures all produce the same public 401 response.
- No JWT contents or secrets are logged in authentication failures.

## Verification

Tests cover a valid asymmetric token, a valid legacy token, expiration, bad
issuer, bad audience, missing subject, unknown key, tampered signature, and
route-level authentication behavior. The complete API test suite and TypeScript
build must pass before commit.
