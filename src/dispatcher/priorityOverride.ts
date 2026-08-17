import type { DispatchRuleId } from './rules.js';

/** The minimal shape the override ranking reads off a dispatch candidate. */
interface Rankable {
  origin: string;
  rule: DispatchRuleId;
}

/**
 * Re-order dispatch candidates by the operator's "Up next" priority override
 * (issue #128).
 *
 * The override is a per-origin rank the operator sets by re-ordering the
 * cockpit's Up next panel. It is keyed on the candidate's stable `origin`
 * (`pr:<n>:ci`, `issue:<n>`, `issue:<n>:part:<slug>`, …) rather than on the
 * ephemeral projection the panel draws, so the ordering survives pulses and
 * restarts while "Up next" stays a per-pulse projection.
 *
 * Four tiers, and the order between them is the whole contract:
 *
 *   1. **`manual-job` items stay first**, in their own (oldest-first) order. A manual
 *      job is a distinct request — not a re-prioritisation of existing work — so
 *      an override never moves one: it always takes the next free slot.
 *   2. **A goal the operator marked a priority**, every origin its work takes
 *      (`isExpedited`, from `goalPriority.ts`), keeping the **pipeline's own order
 *      among them**: the flag says which goal comes first and the pipeline already
 *      says what that goal needs first — assay before plan, plan before parts, a
 *      review before a red build. A second opinion about the order *within* a goal
 *      is not what the operator asked for and would be a worse one.
 *   3. **Overridden origins next**, in ascending rank order (rank `0` = "do this
 *      next"). This is what jumps a world-driven item ahead of the natural
 *      ranking, which is the whole point of that feature.
 *   4. **Everything else** keeps its natural (already-ranked) order.
 *
 * A flag outranks a drag because they are statements of different lifetimes: a
 * drag arranges the queue this pulse and is pruned when its origin stops being
 * ranked, while a flag stands on the goal until the operator clears it. Dragging a
 * row above a flagged goal would be honoured for one pulse and silently lost on
 * the next, which is worse than not honouring it.
 *
 * It only re-orders. It never clears a `held` verdict: a cooldown, cap, pause,
 * ignore tag or unapproved plan holds an item wherever the override places it —
 * the headroom cut downstream still treats a held candidate as held whatever its
 * position. *Overriding a hold* is a different feature (out of scope for #128).
 *
 * The comparator is total (it falls back to the incoming index), so the result
 * is deterministic and does not lean on `Array.prototype.sort` stability.
 */
export function rankByPriorityOverride<T extends Rankable>(
  candidates: readonly T[],
  overrideRank: ReadonlyMap<string, number>,
  isExpedited: (originRef: string) => boolean = () => false,
): T[] {
  const keyed = candidates.map((candidate, index) => {
    const override = overrideRank.get(candidate.origin);
    // `manual-job` items are pinned to the top regardless of any override or flag,
    // so a stray override on a `job:` origin can never demote the manual-job tier.
    const tier =
      candidate.rule === 'manual-job' ? 0 : isExpedited(candidate.origin) ? 1 : override !== undefined ? 2 : 3;
    // Within the overridden tier, order by the operator's rank; every other tier —
    // the flagged goal's included — keeps its incoming position, which is the
    // pipeline's own answer about what that goal needs first.
    const secondary = tier === 2 ? override! : index;
    return { candidate, index, tier, secondary };
  });
  keyed.sort((a, b) => a.tier - b.tier || a.secondary - b.secondary || a.index - b.index);
  return keyed.map((k) => k.candidate);
}
