import { AppError } from '../../lib/errors.js';
import type { BillingPlanStatus, Capability, OperationFeatures, PlanType, Role } from './contracts.js';

const capabilities: Record<Role, readonly Capability[]> = {
  owner: ['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'],
  admin: ['restaurant.read','restaurant.operate','restaurant.manage','restaurant.create','billing.read','billing.manage'],
  manager: ['restaurant.read','restaurant.operate','restaurant.manage','billing.read'],
  staff: ['restaurant.read','restaurant.operate'],
};
export function hasCapability(role: Role, capability: Capability): boolean {
  return Object.hasOwn(capabilities, role) && capabilities[role].includes(capability);
}
export function getRestaurantLimit(plan: PlanType | 'trial'): number {
  if (plan === 'business') return 25;
  if (plan === 'starter' || plan === 'pro' || plan === 'trial') return 1;
  throw new AppError(400, 'invalid_request', 'Invalid request');
}
export function operationFeatures(plan: PlanType, status: BillingPlanStatus, trialEndsAt: string | null, now: number): OperationFeatures {
  const validPlan = plan === 'starter' || plan === 'pro' || plan === 'business';
  const trial = validPlan && status === 'trialing' && trialEndsAt !== null && Date.parse(trialEndsAt) > now;
  const active = validPlan && status === 'active';
  const pro = trial || (active && (plan === 'pro' || plan === 'business'));
  const business = trial || (active && plan === 'business');
  return { cashier:pro, open_tab:pro, metrics:pro, multi_user:business, advanced_reports:business };
}
