import { z } from 'zod';
import type { StateQueryInput } from '../types.js';
import { aggregatingQueryRefusal, aggregatingTail } from './watchQueryShape.js';

// → docs/spec/36-remote-validation.md

const MAX_QUERIES = 20;

const StateQuerySchemaShape = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: z.string().min(1),
    query: z.string().min(1),
    presence: z.string().min(1),
    why: z.string().min(1).optional(),
  })
  .strict('a state query declares only id/title/query/presence/why');

function refuseAggregation(
  declared: { id: string; query: string; presence: string },
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  for (const field of ['query', 'presence'] as const) {
    const operator = aggregatingTail(declared[field]);
    if (operator === null) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, field],
      message: `state query "${declared.id}": ${aggregatingQueryRefusal(field, operator)}`,
    });
  }
}

export const StateSchema = z
  .object({
    queries: z
      .array(StateQuerySchemaShape)
      .default([])
      .transform((list) => (list.length > MAX_QUERIES ? list.slice(0, MAX_QUERIES) : list)),
  })
  .strict('a state block declares only "queries"')
  .superRefine((block, ctx) => {
    const ids = new Set<string>();
    block.queries.forEach((query, index) => {
      refuseAggregation(query, ctx, ['queries', index]);
      if (ids.has(query.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['queries'], message: `duplicate query id "${query.id}"` });
      ids.add(query.id);
    });
  });

export const StateQuerySchema: z.ZodType<
  Omit<StateQueryInput, 'seq'>,
  z.ZodTypeDef,
  unknown
> = StateQuerySchemaShape.superRefine((query, ctx) => {
  refuseAggregation(query, ctx, []);
}).transform((query) => ({
  id: query.id,
  title: query.title,
  query: query.query,
  presence: query.presence,
  why: query.why ?? null,
}));

export function stateQueryInputs(block: z.infer<typeof StateSchema>): StateQueryInput[] {
  return block.queries.map((query, index) => ({
    id: query.id,
    seq: index + 1,
    title: query.title,
    query: query.query,
    presence: query.presence,
    why: query.why ?? null,
  }));
}
