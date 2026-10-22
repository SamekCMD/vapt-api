import {validateWithSchema} from "../../lib/validation.js";
import {slugAvailabilityQuerySchema} from "./schemas.js";
import { AppError } from "../../lib/errors.js";
import type { RestaurantScope, RestaurantWriteScope, TenantActor } from '../tenancy/contracts.js';
import type { RestaurantRepository } from "./repository.js";
import type {
  OnboardingBody,
  UpdateOwnedRestaurantBody,
} from "./schemas.js";

function notFound(): AppError {
  return new AppError(404, "not_found", "Restaurant not found");
}

export function createRestaurantService(repository: RestaurantRepository) {
  return {
    async checkSlugAvailability(scope:RestaurantScope,slug:string){
      const input=validateWithSchema(slugAvailabilityQuerySchema,{slug});
      return {available:await repository.checkSlugAvailability(scope,input.slug)};
    },
    resolveLegacyRestaurant(userId:string) { return repository.resolveLegacyRestaurant(userId); },
    async getRestaurant(scope:RestaurantScope) {
      const restaurant=await repository.getRestaurant(scope); if (!restaurant) throw notFound(); return restaurant;
    },
    async updateRestaurant(scope:RestaurantWriteScope,patch:UpdateOwnedRestaurantBody) {
      const restaurant=await repository.updateRestaurant(scope,patch); if (!restaurant) throw notFound(); return restaurant;
    },
    createOwnedRestaurant(userId: string, input: OnboardingBody) {
      return repository.createOwnedRestaurant(userId, input);
    },

    async getOwnedRestaurant(userId: string) {
      const restaurant = await repository.findOwnedRestaurant(userId);
      if (!restaurant) throw notFound();
      return restaurant;
    },

    async updateOwnedRestaurant(userId: string, patch: UpdateOwnedRestaurantBody, actor?:TenantActor) {
      const restaurant = await repository.updateOwnedRestaurant(userId, patch,actor);
      if (!restaurant) throw notFound();
      return restaurant;
    },
  };
}
