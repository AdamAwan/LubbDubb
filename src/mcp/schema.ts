import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// → docs/spec/11-mcp-tools.md

function rejectsUnknownKeys(schema: z.ZodType): boolean {
  // zod-to-json-schema renders .strict() and the default strip mode identically,
  // so the advertised constraint is read off the schema's own unknownKeys instead.
  let node: unknown = schema;
  for (;;) {
    const def = (node as { _def?: { typeName?: string; unknownKeys?: string; schema?: unknown } })._def;
    if (!def) return false;
    if (def.typeName === 'ZodObject') return def.unknownKeys === 'strict';
    if (def.schema === undefined) return false;
    node = def.schema;
  }
}

export function enumOf<T extends string>(values: readonly T[]): z.ZodEnum<[T, ...T[]]> {
  // A runtime-built list is readonly T[], which z.enum cannot accept as a tuple.
  return z.enum(values as unknown as [T, ...T[]]);
}

export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
    rejectedAdditionalProperties: undefined,
  }) as Record<string, unknown>;
  delete json.$schema;
  if (rejectsUnknownKeys(schema)) json.additionalProperties = false;
  return json;
}
