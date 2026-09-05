# Membership Authorization Design

## Goal

Authorize private API operations through active organization membership instead
of the deprecated `restaurants.owner_id` relationship.

## Membership Resolution

For every restaurant-scoped authorization check, the API resolves the
restaurant's `organization_id` and then loads the caller's matching
`organization_members` row. Access is granted only when the row exists and its
status is `active`. Invited, disabled, missing, malformed, and cross-tenant
memberships fail closed.

The lookup returns a typed organization role: `owner`, `admin`, `manager`, or
`staff`. The service-role Supabase client remains server-only and is used only
to resolve this authorization context.

## Capabilities

Authorization is expressed through capabilities rather than scattered role
comparisons:

| Capability | Allowed roles | Use |
| --- | --- | --- |
| `restaurant.read` | owner, admin, manager, staff | Basic restaurant access |
| `restaurant.operate` | owner, admin, manager, staff | Daily operations and manual payment confirmation |
| `restaurant.manage` | owner, admin, manager | Operational configuration |
| `billing.read` | owner, admin, manager | Subscription and provider status |
| `billing.manage` | owner, admin | Subscription mutations and provider connection changes |

The authenticated JWT role is not treated as an organization role. The API
always resolves the role from `organization_members` for the target restaurant.

## Route Mapping

- The restaurant access endpoint requires `restaurant.read`.
- Manual payment confirmation requires `restaurant.operate`.
- Stripe subscription status requires `billing.read`.
- Stripe checkout, subscription change, and cancellation require
  `billing.manage`.
- Mercado Pago status requires `billing.read`.
- Mercado Pago connect and disconnect require `billing.manage`.

Routes that are not scoped to a restaurant are unchanged in this task.

## Errors and Safety

- Missing or insufficient membership returns the existing generic 403 response.
- Database lookup failures return 500 without exposing credentials or rows.
- Unknown database role values fail closed as forbidden.
- Authorization remains inside API services even when the frontend hides an
  action.

## Verification

Unit tests cover all four active roles, invited/disabled memberships,
non-members, cross-tenant access, capability denial, and database failures.
Service and route tests prove privileged billing/provider operations reject
insufficient roles while operational staff access remains available.
