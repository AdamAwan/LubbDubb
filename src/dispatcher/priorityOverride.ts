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
 * Three tiers, and the order between them is the whole contract:
 *
 *   1. **`manual-job` items stay first**, in their own (oldest-first) order. A manual
 *      job is a distinct request — not a re-prioritisation of existing work — so
 *      an override never moves one: it always takes the next free slot.
 *   2. **Overridden origins next**, in ascending rank order (rank `0` = "do this
 *      next"). This is what jumps a world-driven item ahead of the natural
 *      ranking, which is the whole point of the feature.
 *   3. **Everything else** keeps its natural (already-ranked) order.
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
): T[] {
  const keyed = candidates.map((candidate, index) => {
    const override = overrideRank.get(candidate.origin);
    // `manual-job` items are pinned to the top regardless of any override, so a stray
    // override on a `job:` origin can never demote the manual-job tier.
    const tier = candidate.rule === 'manual-job' ? 0 : override !== undefined ? 1 : 2;
    // Within the overridden tier, order by the operator's rank; every other tier
    // keeps its incoming position.
    const secondary = tier === 1 ? override! : index;
    return { candidate, index, tier, secondary };
  });
  keyed.sort((a, b) => a.tier - b.tier || a.secondary - b.secondary || a.index - b.index);
  return keyed.map((k) => k.candidate);
}
