import { z } from "zod";

export const overviewQuerySchema = z.object({
  period: z.enum(["day", "week", "month"]),
}).strict();

export type OverviewPeriod = z.infer<typeof overviewQuerySchema>["period"];
