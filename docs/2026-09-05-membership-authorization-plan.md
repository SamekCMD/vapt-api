# Membership Authorization Implementation Plan

## Task 1: Define authorization contracts

- Add tests for typed roles, active membership resolution, capability mapping,
  disabled/invited users, non-members, and lookup failures.
- Confirm the tests fail against the owner-only implementation.

## Task 2: Replace owner lookup

- Replace `OwnershipLookup` with a restaurant membership lookup.
- Resolve restaurant organization and active user membership server-side.
- Add a centralized role-to-capability policy and fail-closed checker.

## Task 3: Apply capabilities to services

- Require read, operational, management, or billing capabilities at each
  existing restaurant-scoped service boundary.
- Update dependency names and test fixtures without weakening server-side
  checks.

## Task 4: Verify and deliver

- Run focused permission, auth, billing, manual payment, and Mercado Pago tests.
- Run the complete API test suite and TypeScript build.
- Review cross-tenant and privilege-escalation risks.
- Commit and push the Task 19 branch.
