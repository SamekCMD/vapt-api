import { z } from "zod";

import type { Queryable } from "./database.js";
import { AppError } from "./errors.js";
import {authorizeRestaurant} from '../modules/tenancy/authorization.js';
import type {Access,Capability,RestaurantScope} from '../modules/tenancy/contracts.js';

export type RestaurantAuthorizer=(scope:RestaurantScope,capability:Capability)=>Promise<Access>;
export const createRestaurantCapabilityChecker=(database:Queryable):RestaurantAuthorizer=>
  (scope,capability)=>authorizeRestaurant(database,scope,capability);

export type OwnershipLookup = (input: {
  userId: string;
  restaurantId: string;
}) => Promise<boolean>;

export type RestaurantAccessChecker = (input: {
  userId: string;
  restaurantId: string;
}) => Promise<void>;

export function createRestaurantAccessChecker(
  ownershipLookup: OwnershipLookup,
): RestaurantAccessChecker {
  return async ({ userId, restaurantId }) => {
    const allowed = await ownershipLookup({ userId, restaurantId });

    if (!allowed) {
      throw new AppError(403, "forbidden", "Forbidden");
    }
  };
}

export const testOwnershipLookup: OwnershipLookup = async ({ userId, restaurantId }) =>
  userId === "user-1" && restaurantId === "rest-1";

const uuidSchema = z.string().uuid();

export function createOwnershipLookup(database: Queryable): OwnershipLookup {
  return async ({ userId, restaurantId }) => {
    if (!uuidSchema.safeParse(restaurantId).success || !uuidSchema.safeParse(userId).success) {
      throw new AppError(400, "invalid_request", "Invalid request");
    }

    try {
      // Conservative compatibility for the old Stripe consumer until Task7.
      await authorizeRestaurant(database,{userId,restaurantId},'billing.manage');
      return true;
    } catch(error) {
      if(error instanceof AppError && error.statusCode===403) return false;
      throw new AppError(500, "internal_error", "Failed to verify restaurant access");
    }
  };
}
