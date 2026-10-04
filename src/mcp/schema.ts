import { z } from 'zod';

// → docs/spec/11-mcp-tools.md

export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'throw' });
  return json;
}
