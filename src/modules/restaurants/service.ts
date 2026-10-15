import { AppError } from "../../lib/errors.js";
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
    createOwnedRestaurant(userId: string, input: OnboardingBody) {
      return repository.createOwnedRestaurant(userId, input);
    },

    async getOwnedRestaurant(userId: string) {
      const restaurant = await repository.findOwnedRestaurant(userId);
      if (!restaurant) throw notFound();
      return restaurant;
    },

    async updateOwnedRestaurant(userId: string, patch: UpdateOwnedRestaurantBody) {
      const restaurant = await repository.updateOwnedRestaurant(userId, patch);
      if (!restaurant) throw notFound();
      return restaurant;
    },
  };
}
