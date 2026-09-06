import { z } from 'zod';
import type { GoalWatchDeclaration, GoalWatchInput } from '../types.js';

// → docs/spec/20-validation.md

const MAX_SIGNALS = 20;

const WatchSignalSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: z.string().min(1),
    query: z.string().min(1),
    presence: z.string().min(1),
    tolerate: z.number().int().min(0).default(0),
    why: z.string().min(1).optional(),
  })
  .strict('a signal declares only id/title/query/presence/tolerate/why');

const WatchExpectSchema = z
  .object({
    under: z.number().optional(),
    over: z.number().optional(),
    noWorseThan: z.literal('baseline').optional(),
  })
  .strict('a measure expects only under/over/noWorseThan')
  .refine((e) => e.under !== undefined || e.over !== undefined || e.noWorseThan !== undefined, {
    message:
      'a measure must declare a threshold ("under"/"over") or "noWorseThan": "baseline" — one that ' +
      'declares neither reads as a check and can never fail',
  });

const WatchMeasureSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: z.string().min(1),
    query: z.string().min(1),
    expect: WatchExpectSchema,
    unit: z.string().min(1).optional(),
    why: z.string().min(1).optional(),
  })
  .strict('a measure declares only id/title/query/expect/unit/why');

export const WatchSchema = z
  .object({
    signals: z
      .array(WatchSignalSchema)
      .default([])
      .transform((list) => (list.length > MAX_SIGNALS ? list.slice(0, MAX_SIGNALS) : list)),
    measures: z
      .array(WatchMeasureSchema)
      .default([])
      .transform((list) => (list.length > MAX_SIGNALS ? list.slice(0, MAX_SIGNALS) : list)),
  })
  .strict('a watch block declares only "signals" and "measures"')
  .superRefine((block, ctx) => {
    const ids = new Set<string>();
    for (const check of [...block.signals, ...block.measures]) {
      if (ids.has(check.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signals'], message: `duplicate check id "${check.id}"` });
      ids.add(check.id);
    }
  });

export const WatchCheckSchema: z.ZodType<GoalWatchDeclaration, z.ZodTypeDef, unknown> = z.discriminatedUnion('kind', [
  WatchSignalSchema.extend({ kind: z.literal('signal') }).strict(
    'a signal declares only kind/id/title/query/presence/tolerate/why',
  ),
  WatchMeasureSchema.extend({ kind: z.literal('measure') }).strict(
    'a measure declares only kind/id/title/query/expect/unit/why',
  ),
]);

export function watchCheckInput(check: GoalWatchDeclaration, seq: number): GoalWatchInput {
  if (check.kind === 'signal')
    return {
      id: check.id,
      seq,
      kind: 'signal',
      title: check.title,
      query: check.query,
      presence: check.presence,
      tolerate: check.tolerate,
      expectUnder: null,
      expectOver: null,
      expectBaseline: false,
      unit: null,
      why: check.why ?? null,
    };
  return {
    id: check.id,
    seq,
    kind: 'measure',
    title: check.title,
    query: check.query,
    presence: null,
    tolerate: 0,
    expectUnder: check.expect.under ?? null,
    expectOver: check.expect.over ?? null,
    expectBaseline: check.expect.noWorseThan === 'baseline',
    unit: check.unit ?? null,
    why: check.why ?? null,
  };
}

export function watchCheckInputs(block: z.infer<typeof WatchSchema>): GoalWatchInput[] {
  return [
    ...block.signals.map((signal, index) => watchCheckInput({ ...signal, kind: 'signal' }, index + 1)),
    ...block.measures.map((measure, index) =>
      watchCheckInput({ ...measure, kind: 'measure' }, block.signals.length + index + 1),
    ),
  ];
}
