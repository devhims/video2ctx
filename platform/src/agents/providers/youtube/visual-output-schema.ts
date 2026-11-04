import { asSchema, jsonSchema } from 'ai';
import type { z } from 'zod';

// Request every array explicitly for OpenAI Structured Outputs. Some other
// providers omit an empty sharedFindings array; preserve that one legacy default.
export function visualOutputSchema<S extends z.ZodObject>(schema: S) {
  return jsonSchema<z.output<S>>(asSchema(schema).jsonSchema, {
    validate(value) {
      const parsed = schema.safeParse(value && typeof value === 'object' && !Array.isArray(value)
        ? { sharedFindings: [], ...value } : value);
      return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error };
    },
  });
}
