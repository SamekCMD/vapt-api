import { z } from "zod";

export const tableSessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();

export const transferTableSessionBodySchema = z.object({
  tableNumber: z.string().trim().min(1).max(20),
}).strict();

export type TransferTableSessionBody = z.infer<typeof transferTableSessionBodySchema>;
