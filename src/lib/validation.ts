import { z } from "zod";

import { AppError } from "./errors.js";

function failInvalidRequest(): never {
  throw new AppError(400, "invalid_request", "Invalid request");
}

export function validateWithSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(input);

  if (!result.success) {
    failInvalidRequest();
  }

  return result.data;
}
