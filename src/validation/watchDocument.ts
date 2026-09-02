import { z } from 'zod';
import type { GoalWatchDeclaration, GoalWatchInput } from '../types.js';

/**
 * The `watch` block of a plan document: what a running system would have to show
 * for this work to have done what it claimed.
 *
 * Beside `validation` and additive and **optional** for the same reason every
 * post-v1 field is — an older plan, and an operator override that never learned
 * the block, must keep validating. Declaring nothing is a legitimate answer: a
 * refactor, a docs change and a build fix have nothing running to watch, and a
 * goal that declared no checks reads **null**, which is a third fact and not a
 * synonym for clean.
 *
 * Beside `checkDocument.ts` rather than under `src/environments/` because it is
 * the same kind of thing: the shape of a block in a plan document, exported so
 * that the second writer — `watch_declare` — refuses exactly what a plan document
 * refuses rather than drifting on the day one of them learns a field.
 *
 * → `docs/spec/29-post-deploy-watch.md#the-declaration`
 */

/** How many checks of each kind are kept. Trimmed rather than refused, `MAX_CHECKS`' trade. */
const MAX_SIGNALS = 20;

/**
 * One thing that should not be happening: exceptions, failures, retries, a log
 * line only written when something has gone wrong.
 *
 * **`presence` is required, and that is the whole design of a signal.** A query
 * naming an operation that does not exist returns zero rows, zero rows is
 * indistinguishable from a healthy release, and it is the direction that reads as
 * success — so the harness would report a fix verified on the strength of a typo.
 * A signal without a second query proving the code path runs at all can never
 * honestly report clean, which makes it a check that cannot fail: refused at
 * ingestion, on `arrival.opens: []`'s terms.
 */
const WatchSignalSchema = z
  .object({
    /** Stable and author-chosen: an amendment merges on it, so it must survive a replan. */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: z.string().min(1),
    /** The query itself. Reaches the shell as a variable's value and never as syntax. */
    query: z.string().min(1),
    /** The second query, whose only job is to prove the code path is running at all. */
    presence: z.string().min(1),
    /** The count this must not exceed. Almost always zero — the thing should not be happening. */
    tolerate: z.number().int().min(0).default(0),
    why: z.string().min(1).optional(),
  })
  .strict('a signal declares only id/title/query/presence/tolerate/why');

/**
 * One number: a percentile, a rate, a duration, a queue depth.
 *
 * **`expect` must say something a reading could fail.** A measure declaring
 * neither a threshold nor a baseline reads as a check and cannot fail, which is
 * the shape most likely to be written by somebody who meant to come back to it —
 * `arrival.opens: []`'s refusal, one document over. So the object is refused
 * empty rather than defaulted into a comparison nobody declared.
 *
 * A measure declares no `presence`, and that is not an omission: presence exists
 * because zero rows is indistinguishable from a healthy release, and a measure
 * that answers no row at all is already `unknown` under the output contract —
 * exactly one row carrying a numeric `value`, or the observation failed.
 */
const WatchExpectSchema = z
  .object({
    /** A ceiling: the number must stay below it. */
    under: z.number().optional(),
    /** A floor: the number must stay above it. */
    over: z.number().optional(),
    /**
     * The comparison that is worth having, and the one an optimisation is about:
     * the same query, from the same source, run at declaration time — before
     * anything changed. Read lower-is-better, which is what a percentile, a
     * duration and a queue depth all are; a measure where a bigger number is the
     * good news declares an `over` instead.
     */
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
    /** Stable and author-chosen: an amendment merges on it, so it must survive a replan. */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: z.string().min(1),
    /** The query. Answers exactly one row carrying a numeric `value`, or it did not answer. */
    query: z.string().min(1),
    expect: WatchExpectSchema,
    /** What the number is in, drawn beside it. Never parsed — the harness does no arithmetic on units. */
    unit: z.string().min(1).optional(),
    why: z.string().min(1).optional(),
  })
  .strict('a measure declares only id/title/query/expect/unit/why');

/**
 * Reached by both transports exactly as `ValidationSchema` is — the `plan.json`
 * drain and the `plan_submit` tool must accept and reject the same documents.
 *
 * Both kinds, and the ids are unique across the two: a measure and a signal
 * sharing a slug would be one row in `goal_watches`, whose key is the slug alone.
 */
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

/**
 * One check on its own, with the kind it is written under named rather than
 * implied by which array it sat in.
 *
 * The third writer's shape ([the operator, at any
 * time](../../docs/spec/29-post-deploy-watch.md#the-operator-at-any-point)): a
 * goal page edits one check, not a document, so there is no array to read the
 * kind off. Built from the same two schemas the block is, for the reason this
 * module exists at all — a writer with its own copy of these rules is one that
 * accepts what a plan document refuses on the day either learns a field.
 */
export const WatchCheckSchema: z.ZodType<GoalWatchDeclaration, z.ZodTypeDef, unknown> = z.discriminatedUnion('kind', [
  WatchSignalSchema.extend({ kind: z.literal('signal') }).strict(
    'a signal declares only kind/id/title/query/presence/tolerate/why',
  ),
  WatchMeasureSchema.extend({ kind: z.literal('measure') }).strict(
    'a measure declares only kind/id/title/query/expect/unit/why',
  ),
]);

/**
 * One check as store input, at the position the caller places it.
 *
 * One function over both kinds rather than two, because the store holds one table:
 * a measure is a row with no `presence`, a `tolerate` nothing reads, and an
 * expectation the signal columns are null for.
 */
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
    // A measure declares none, and the fold reads that null rather than
    // inferring it from the kind: presence answers "is this code path running",
    // which a measure's own single row already fails without.
    presence: null,
    tolerate: 0,
    expectUnder: check.expect.under ?? null,
    expectOver: check.expect.over ?? null,
    expectBaseline: check.expect.noWorseThan === 'baseline',
    unit: check.unit ?? null,
    why: check.why ?? null,
  };
}

/**
 * The declared checks as store input, sequenced by their order in the document —
 * signals first, then measures.
 */
export function watchCheckInputs(block: z.infer<typeof WatchSchema>): GoalWatchInput[] {
  return [
    ...block.signals.map((signal, index) => watchCheckInput({ ...signal, kind: 'signal' }, index + 1)),
    ...block.measures.map((measure, index) =>
      watchCheckInput({ ...measure, kind: 'measure' }, block.signals.length + index + 1),
    ),
  ];
}
