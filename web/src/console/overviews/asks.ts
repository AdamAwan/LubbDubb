import type { NeedKind, NeedRow, NeedUrgency } from '../../view/needsYou.js';

// → docs/spec/17-cockpit.md#the-overview

/**
 * The order the ask-led shapes read in: the tier first, then how much work is
 * stalled behind the ask, then how far along the work the ask is about already
 * is. `holding` is the number the rail already computes and the one that should
 * decide what an operator opens first — an ask with four parts waiting behind it
 * is stopping more work than one with none, whatever either is about.
 */
const TIER_RANK: Record<NeedUrgency, number> = { now: 0, next: 1, later: 2 };

/**
 * How far along the work behind the ask is, which is what breaks a tie between
 * two asks holding the same number of parts. Read low-to-high as a part's own
 * life run backwards: a merge is one press from landing, a review thread is on a
 * pull request that exists, a bench row is checking something already delivered,
 * an escalation is an agent out right now — and an intake hold is work that has
 * not started, which is the thing to answer once the work already moving is
 * done. Last of all comes the deployment itself.
 *
 * It sorts **under** `holding` rather than over it, so nothing here re-decides
 * what the server decided: where two asks stall the same amount of work the
 * remaining cut used to be `raisedAt`, which put the oldest intake hold on the
 * deployment in front of every ask about work in flight.
 *
 * Total over {@link NeedKind}, like the rail's own tables, so a new kind is
 * placed deliberately rather than inheriting the last one's stage.
 */
const STAGE_RANK: Record<NeedKind, number> = {
  merge: 0,
  describe: 1,
  reply: 1,
  assigned: 1,
  validate: 2,
  validation_plan: 2,
  bench: 2,
  close_out: 2,
  // Moment two is asked after the goal is closed out, so it sits at the same stage
  // rather than ahead of the close it follows.
  outcome: 2,
  shortfall: 2,
  escalation: 3,
  permission: 3,
  recovery: 3,
  plan: 3,
  dispatch: 3,
  limit: 3,
  burn: 3,
  intake: 4,
  profile: 4,
  placement: 4,
  unwatched: 4,
  watch: 4,
  supply: 4,
  config: 5,
  config_gap: 5,
  upgrade: 5,
  project_pull: 5,
};

export function byWeight(a: NeedRow, b: NeedRow): number {
  const tier = TIER_RANK[a.urgency] - TIER_RANK[b.urgency];
  if (tier !== 0) return tier;
  if (a.holding !== b.holding) return b.holding - a.holding;
  const stage = STAGE_RANK[a.kind] - STAGE_RANK[b.kind];
  if (stage !== 0) return stage;
  return a.raisedAt.localeCompare(b.raisedAt);
}

/** How many parts are stalled behind the whole set, which is the banner's number. */
export function partsHeld(rows: readonly NeedRow[]): number {
  return rows.reduce((sum, row) => sum + row.holding, 0);
}
