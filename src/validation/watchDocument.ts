import { z } from 'zod';
import type { GoalWatchInput } from '../types.js';

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
 * that a second writer — `watch_declare`, when it exists — refuses exactly what a
 * plan document refuses rather than drifting on the day one of them learns a
 * field.
 *
 * → `docs/spec/29-post-deploy-watch.md#the-declaration`
 */

/** How many signals are kept. Trimmed rather than refused, `MAX_CHECKS`' trade. */
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
 * Reached by both transports exactly as `ValidationSchema` is — the `plan.json`
 * drain and the `plan_submit` tool must accept and reject the same documents.
 *
 * Only `signals` at this stage. `measures` — a percentile, a rate, a duration —
 * need a baseline to be worth anything, and a measure declaring neither a
 * threshold nor a baseline reads as a check and cannot fail. They arrive with the
 * baseline capture that makes them honest.
 */
export const WatchSchema = z
  .object({
    signals: z
      .array(WatchSignalSchema)
      .default([])
      .transform((list) => (list.length > MAX_SIGNALS ? list.slice(0, MAX_SIGNALS) : list)),
  })
  .strict('a watch block declares only "signals"')
  .superRefine((block, ctx) => {
    const ids = new Set<string>();
    for (const signal of block.signals) {
      if (ids.has(signal.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signals'], message: `duplicate signal id "${signal.id}"` });
      ids.add(signal.id);
    }
  });

/** The declared signals as store input, sequenced by their order in the document. */
export function watchSignalInputs(block: z.infer<typeof WatchSchema>): GoalWatchInput[] {
  return block.signals.map((signal, index) => ({
    id: signal.id,
    seq: index + 1,
    kind: 'signal' as const,
    title: signal.title,
    query: signal.query,
    presence: signal.presence,
    tolerate: signal.tolerate,
    why: signal.why ?? null,
  }));
}
