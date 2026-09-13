import type { NeedRow, NeedUrgency } from '../../view/needsYou.js';

// → docs/spec/17-cockpit.md#the-overview

/**
 * The order the ask-led shapes read in: the tier first, then how much work is
 * stalled behind the ask. `holding` is the number the rail already computes and
 * the one that should decide what an operator opens first — an ask with four
 * parts waiting behind it is stopping more work than one with none, whatever
 * either is about.
 */
const TIER_RANK: Record<NeedUrgency, number> = { now: 0, next: 1, later: 2 };

export function byWeight(a: NeedRow, b: NeedRow): number {
  const tier = TIER_RANK[a.urgency] - TIER_RANK[b.urgency];
  if (tier !== 0) return tier;
  if (a.holding !== b.holding) return b.holding - a.holding;
  return a.raisedAt.localeCompare(b.raisedAt);
}

/** How many parts are stalled behind the whole set, which is the banner's number. */
export function partsHeld(rows: readonly NeedRow[]): number {
  return rows.reduce((sum, row) => sum + row.holding, 0);
}
