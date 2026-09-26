import { AppError } from "../../lib/errors.js";
import type { OverviewDto } from "../business/contracts.js";
import type { OverviewRepository } from "./repository.js";
import type { OverviewPeriod } from "./schemas.js";

function periodStartUtc(period: OverviewPeriod, now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (period === "week") {
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  } else if (period === "month") {
    start.setUTCDate(1);
  }
  return start;
}

export function createOverviewService(
  repository: OverviewRepository,
  now: () => Date = () => new Date(),
) {
  return {
    async getOwnedOverview(userId: string, period: OverviewPeriod): Promise<OverviewDto> {
      const periodStart = periodStartUtc(period, now());
      const data = await repository.getOwnedOverview(userId, periodStart);
      if (!data) throw new AppError(404, "restaurant_not_found", "Restaurant not found");
      return {
        ...data,
        period,
        periodStart: periodStart.toISOString(),
      };
    },
  };
}
