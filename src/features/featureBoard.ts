import { rollUpReach } from '../environments/reach.js';
import { isContainerType } from '../issueRelations.js';
import type { MirroredTicket } from '../store/tickets.js';
import type { GoalEnvironmentReach, GoalLanding } from '../types.js';
import { isWatched } from '../watchLabels.js';
import type {
  FeatureBoardPayload,
  FeatureChildRow,
  FeatureChildStanding,
  FeatureCounts,
  FeatureReach,
  FeatureRollup,
} from '../wire.js';

/** How many of a Feature's children the board ships. Enough to read; the Tickets tab has the rest. */
export const FEATURE_CHILDREN = 25;

interface BuildInput {
  items: readonly MirroredTicket[];
  /** The harness's own outcome word per goal — `ticketOutcomes`' answer, never a second fold. */
  outcomes: ReadonlyMap<number, string>;
  /** Dollars per goal — `buildSpendGoals`' answer, never a second rollup. */
  costs: ReadonlyMap<number, number>;
  /** Which hue each feature draws in — the store's persisted assignment. */
  featureSlots: ReadonlyMap<number, number>;
  /**
   * Goals with a run the harness minted and has not finished — the `inFlight`
   * standing, and the one reading here that is about *now* rather than about a
   * verdict somebody reached.
   */
  running: ReadonlySet<number>;
  /** Per-goal environment standing — `allGoalReach`' answer, folded one tier up here. */
  reach: readonly { goalRef: string; environments: GoalEnvironmentReach[] }[];
  landings: readonly GoalLanding[];
  /** The configured environment names, in the operator's own order. */
  environments: readonly string[];
  /** `issueContainerTypes` — the operator's policy about which items are never work. */
  containerTypes: readonly string[] | undefined;
  watchLabel: string;
}

/**
 * The feature board: every container the mirror's items hang off, with the work
 * beneath it folded.
 *
 * **A lens, and every reading in it is a quotation.** The outcome word is
 * `ticketOutcomes`', the money is `buildSpendGoals`', the watch bucket is
 * `src/watchLabels.ts`', which items are containers is `isContainerType`'s and the
 * environment fold is `rollUpReach`'s — the same function a goal's own landings
 * are folded with. Nothing here decides anything and no rule under
 * `src/dispatcher/` reads it, which is the rule the work graph, `buildStacks` and
 * `prAttentionStatus` are all held to.
 * → `docs/spec/17-cockpit.md#the-feature-board`
 *
 * Pure, and the whole of the derivation, for `buildTicketPage`'s reason: neither
 * the watch bucket nor the cost is the table's to know, so a materialised column
 * would be a stale copy of config the moment the label prefix changed.
 *
 * **What it deliberately does not ship is a verdict about a Feature.** There is no
 * "at risk", no "on track" and no forecast date, because each would be a policy no
 * config file states and no module owns — and a board that invented one would be
 * the second opinion this whole file is arranged to avoid. It ships the facts and
 * the cockpit composes the sentence.
 */
export function buildFeatureBoard(input: BuildInput): Omit<FeatureBoardPayload, 'backfilling' | 'refUrls'> {
  const { items, outcomes, costs, featureSlots, running, containerTypes, watchLabel } = input;

  const reachByGoal = new Map(input.reach.map((r) => [r.goalRef, r.environments]));
  const landedAt = lastLandingByGoal(input.landings);

  const groups = new Map<number, { title: string; rows: FeatureChildRow[] }>();
  const orphanRows: FeatureChildRow[] = [];
  let unresolved = 0;

  for (const item of items) {
    // A container is never its own child. It is a statement of intent whose
    // children are the work, and counting one in a parent Epic's bar would put a
    // whole Feature's worth of stories in the denominator as a single item.
    // → `docs/spec/06-issue-pickup.md`
    if (isContainerType(item.issueType, containerTypes)) continue;

    const row = childRow(item, { outcomes, costs, running, watchLabel });
    if (item.parent === undefined) {
      // The link was never resolved. Neither a Feature's nor an orphan's — see
      // `FeatureBoardPayload.unresolved`.
      unresolved += 1;
      continue;
    }
    if (item.parent === null) {
      orphanRows.push(row);
      continue;
    }
    const seen = groups.get(item.parent.number);
    if (seen) seen.rows.push(row);
    else groups.set(item.parent.number, { title: item.parent.title, rows: [row] });
  }

  // The container's own mirrored row, where the tracker's filter happened to return
  // it. Looked up rather than assumed: most deployments never see it.
  const containers = new Map<number, MirroredTicket>();
  for (const item of items) if (isContainerType(item.issueType, containerTypes)) containers.set(item.number, item);

  const features: FeatureRollup[] = [];
  for (const [number, group] of groups) {
    const self = containers.get(number);
    features.push({
      number,
      title: group.title,
      slot: featureSlots.get(number) ?? 0,
      workItemState: self?.workItemState ?? null,
      issueType: self?.issueType ?? null,
      counts: countStandings(group.rows),
      children: orderChildren(group.rows).slice(0, FEATURE_CHILDREN),
      costUsd: totalCost(group.rows),
      reach: foldReach(group.rows, reachByGoal, input.environments),
      lastLandingAt: latestLanding(group.rows, landedAt),
    });
  }

  return {
    features: features.sort(byWantsYouThenSize),
    orphans:
      orphanRows.length === 0
        ? null
        : {
            counts: countStandings(orphanRows),
            children: orderChildren(orphanRows).slice(0, FEATURE_CHILDREN),
            costUsd: totalCost(orphanRows),
            lastLandingAt: latestLanding(orphanRows, landedAt),
          },
    unresolved,
    environments: [...input.environments],
  };
}

/** One child row, and the standing that decides which segment of the bar it lands in. */
function childRow(
  item: MirroredTicket,
  ctx: {
    outcomes: ReadonlyMap<number, string>;
    costs: ReadonlyMap<number, number>;
    running: ReadonlySet<number>;
    watchLabel: string;
  },
): FeatureChildRow {
  const outcome = ctx.outcomes.get(item.number) ?? null;
  return {
    number: item.number,
    title: item.title,
    issueType: item.issueType,
    standing: standingOf({
      watched: isWatched(item.labels, ctx.watchLabel),
      running: ctx.running.has(item.number),
      outcome,
    }),
    outcome,
    workItemState: item.workItemState,
    // Absent, not zero, for `TicketRow.costUsd`'s reason.
    costUsd: ctx.costs.get(item.number) ?? null,
    changedAt: item.changedAt,
  };
}

/**
 * Which segment of the bar an item lands in, in strict precedence order.
 *
 * The order is the whole of this function and each step is load-bearing:
 *
 * 1. **`unwatched` first.** An item the fleet cannot see is not queued behind
 *    anything — nothing has read it, appraised it or spent on it. Drawn as
 *    `queued` it would report a fleet working through a backlog it has never
 *    looked at, which is the failure this board most has to refuse.
 * 2. **`inFlight` next**, above every outcome word, because a re-picked goal
 *    carries the verdict of its last attempt while an agent works its next one.
 *    The board is a reading of now.
 * 3. **Then the outcome words**, exactly as `ticketOutcomes` spelled them — never
 *    re-derived here, only mapped onto a segment.
 */
function standingOf(signals: { watched: boolean; running: boolean; outcome: string | null }): FeatureChildStanding {
  if (!signals.watched) return 'unwatched';
  if (signals.running) return 'inFlight';
  if (signals.outcome === 'delivered') return 'delivered';
  if (signals.outcome === 'fell short') return 'fellShort';
  if (signals.outcome === 'concluded' || signals.outcome === 'abandoned') return 'settled';
  return 'queued';
}

function countStandings(rows: readonly FeatureChildRow[]): FeatureCounts {
  const counts: FeatureCounts = {
    delivered: 0,
    inFlight: 0,
    queued: 0,
    fellShort: 0,
    settled: 0,
    unwatched: 0,
    total: rows.length,
  };
  for (const row of rows) counts[row.standing] += 1;
  return counts;
}

/**
 * Null where the fleet never ran on any of this Feature's children, and a number
 * — possibly `0` — where it ran on one and that one cost nothing measurable.
 *
 * The distinction is `TicketRow.costUsd`'s: PTY agents report no usage at all, so
 * a Feature worked entirely in that mode has no spend row anywhere, and drawing it
 * as `$0.00` would report free work where the truth is unmeasured work.
 */
function totalCost(rows: readonly FeatureChildRow[]): number | null {
  let total: number | null = null;
  for (const row of rows) {
    if (row.costUsd === null) continue;
    total = (total ?? 0) + row.costUsd;
  }
  return total === null ? null : Math.round(total * 100) / 100;
}

/**
 * The Feature's standing in each environment, folded from its goals'.
 *
 * Only goals `allGoalReach` produced a row for are counted, which is the same set
 * that module decides: a goal with nothing merged has been nowhere, and counting
 * it as `absent` here would put every never-started story in the denominator and
 * make a shipped Feature read as a third deployed for good.
 */
function foldReach(
  rows: readonly FeatureChildRow[],
  reachByGoal: ReadonlyMap<string, GoalEnvironmentReach[]>,
  environments: readonly string[],
): FeatureReach[] {
  return environments.map((environment) => {
    let total = 0;
    let reached = 0;
    let unresolved = 0;
    for (const row of rows) {
      const found = reachByGoal.get(`issue:${row.number}`)?.find((e) => e.environment === environment);
      if (found === undefined) continue;
      total += 1;
      if (found.status === 'reached') reached += 1;
      // `partial` and `unknown` are both unresolved one tier up: half a goal in an
      // environment is not a goal in it, and a probe that could not answer must
      // never fold to `absent`. `absent` falls through as neither.
      else if (found.status === 'partial' || found.status === 'unknown') unresolved += 1;
    }
    return { environment, status: rollUpReach({ total, reached, unresolved }), goals: reached, total };
  });
}

/** The newest landing under any of these goals, or null where none has landed anything. */
function latestLanding(rows: readonly FeatureChildRow[], landedAt: ReadonlyMap<string, string>): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    const at = landedAt.get(`issue:${row.number}`);
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

function lastLandingByGoal(landings: readonly GoalLanding[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const landing of landings) {
    const seen = out.get(landing.goalRef);
    if (seen === undefined || landing.recordedAt > seen) out.set(landing.goalRef, landing.recordedAt);
  }
  return out;
}

/**
 * The children a reader most needs first: what is happening, then what is stuck,
 * then the rest — and the tracker's own order inside each band.
 *
 * The board ships a bounded slice ({@link FEATURE_CHILDREN}), so this decides
 * which rows a large Feature shows rather than merely how they sit. An arrival
 * order would show twenty delivered stories and cut the one that fell short.
 */
const STANDING_ORDER: Record<FeatureChildStanding, number> = {
  inFlight: 0,
  fellShort: 1,
  unwatched: 2,
  queued: 3,
  delivered: 4,
  settled: 5,
};

function orderChildren(rows: readonly FeatureChildRow[]): FeatureChildRow[] {
  return [...rows].sort(
    (a, b) => STANDING_ORDER[a.standing] - STANDING_ORDER[b.standing] || b.changedAt.localeCompare(a.changedAt),
  );
}

/**
 * Features that want a person, then the ones carrying the most work.
 *
 * **This is an ordering, not a verdict.** It says which card to read first and
 * nothing about whether a Feature is in trouble — the same distinction the queue
 * rail draws. What counts as wanting a person is deliberately narrow and is a
 * count of facts rather than a judgement: an item that fell short is a decision
 * somebody owes, and an item nothing can see is a gap somebody has to close.
 * Neither is inferred; both are counted.
 */
function byWantsYouThenSize(a: FeatureRollup, b: FeatureRollup): number {
  const wants = (f: FeatureRollup) => f.counts.fellShort + f.counts.unwatched;
  return wants(b) - wants(a) || b.counts.total - a.counts.total || a.number - b.number;
}
