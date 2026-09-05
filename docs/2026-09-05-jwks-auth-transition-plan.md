# JWKS Authentication Transition Implementation Plan

## Task 1: Establish JOSE verifier contracts

- Add `jose`.
- Add focused JWT tests using generated asymmetric and symmetric keys.
- Confirm the new tests fail against the current synchronous handwritten API.

## Task 2: Implement staged verification

- Replace manual parsing and HMAC comparison with `decodeProtectedHeader` and
  `jwtVerify`.
- Route asymmetric tokens to a remote JWKS resolver and HS256 tokens to the
  legacy secret.
- Enforce issuer, audience, expiration, subject, and algorithm allowlists.
- Normalize all rejected tokens to the existing unauthorized application error.

## Task 3: Integrate configuration and Fastify authentication

- Add typed JWT verification configuration derived from `SUPABASE_URL`.
- Make the auth plugin await verification and consume typed claims.
- Preserve the existing shared secret for non-auth order-token signing until
  that concern is migrated to a dedicated secret.
- Update affected test fixtures and environment documentation.

## Task 4: Verify and deliver

- Run focused authentication/JWT tests.
- Run the complete API test suite.
- Run the TypeScript build.
- Review the diff for secret leakage and unintended auth behavior changes.
- Commit and push the Task 18 branch.
