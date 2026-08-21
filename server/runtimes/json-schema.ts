import { z } from "zod";

type JsonSchema = Record<string, unknown>;

export function zodShapeToJsonSchema(shape: z.ZodRawShape): JsonSchema {
  return z.toJSONSchema(z.object(shape), { unrepresentable: "any" }) as JsonSchema;
}
