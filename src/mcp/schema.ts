import { z } from 'zod';

// → docs/spec/11-mcp-tools.md

export function enumOf<T extends string>(values: readonly T[]): z.ZodEnum<{ [K in T]: K }> {
  // A runtime-built list is readonly T[], which z.enum cannot accept as a tuple.
  return z.enum(values as unknown as [T, ...T[]]);
}

export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
