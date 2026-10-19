import { z } from 'zod';

export type Role = 'owner' | 'admin' | 'manager' | 'staff';
export type PlanType = 'starter' | 'pro' | 'business';
export type BillingPlanStatus = 'trialing' | 'active' | 'past_due' | 'incomplete' | 'unpaid' | 'paused' | 'expired' | 'cancelled';
export type Capability = 'restaurant.read' | 'restaurant.operate' | 'restaurant.manage' |
  'restaurant.create' | 'billing.read' | 'billing.manage';
export type TenantActor = { userId: string; sessionId: string; sessionExpiresAt: number };
export type RestaurantScope = { userId: string; restaurantId: string };
export type OrganizationScope = { userId: string; organizationId: string };
export type RestaurantWriteScope = RestaurantScope & TenantActor;
export type OrganizationWriteScope = OrganizationScope & TenantActor;
export type RestaurantMembership = { organizationId: string; role: Role };
export type Access = RestaurantScope & RestaurantMembership;
export type OperationFeatures = Record<'cashier' | 'open_tab' | 'metrics' | 'multi_user' | 'advanced_reports', boolean>;

// Internal request/command metadata only. Parsing this is not proof of membership.
export const tenantActorSchema = z.object({
  userId: z.string().uuid(), sessionId: z.string().uuid(), sessionExpiresAt: z.number().int().positive(),
});
