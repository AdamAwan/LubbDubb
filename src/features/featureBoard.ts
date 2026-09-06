import { rollUpReach } from '../environments/reach.js';
import { isContainerType } from '../issueRelations.js';
import type { MirroredTicket } from '../store/tickets.js';
import type {
  Escalation,
  FeatureSequence,
  FeatureSummary,
  GoalEnvironmentReach,
  GoalLanding,
  IssueDelivery,
  IssueShortfall,
} from '../types.js';
import { isWatched } from '../watchLabels.js';
import type {
  FeatureBlockRow,
  FeatureBoardPayload,
  FeatureBriefing,
  FeatureChildRow,
  FeatureChildStanding,
  FeatureCounts,
  FeatureLandingRow,
  FeatureReach,
  FeatureReportRow,
  FeatureRollup,
  FeatureWorkingRow,
} from '../wire.js';

/** How many of a Feature's children the board ships. Enough to read; the Tickets tab has the rest. */
export const FEATURE_CHILDREN = 25;

/**
 * How many rows of each briefing list the board ships. Enough to read at a glance;
 * the count beside it says how many were cut, and the children below carry the rest.
 */
export const FEATURE_BRIEFING_ROWS = 3;

/**
 * How many landings a card ships. The cockpit counts them inside a window it names,
 * so the bound only has to outrun that window on a busy Feature; the total lives on
 * `lastLandingAt` and the goals' own pages.
 */
export const FEATURE_LANDINGS = 25;

interface BuildInput {
  items: readonly MirroredTicket[];
  /** The harness's own outcome word per goal — `ticketOutcomes`' answer, never a second fold. */
  outcomes: ReadonlyMap<number, string>;
  /** Dollars per goal — `buildSpendGoals`' answer, never a second rollup. */
  costs: ReadonlyMap<number, number>;
  /** Which hue each feature draws in — the store's persisted assignment. */
  featureSlots: ReadonlyMap<number, number>;
  /**
   * Goals with a run the harness minted and has not finished, to when that run started —
   * the `inFlight` standing. A map, because the briefing draws the age: the run's
   * `startedAt` is the only stamp that survives a re-dispatch.
   */
  running: ReadonlyMap<number, string>;
  /**
   * The account rule `feature-summary` wrote of each Feature, keyed on the container's
   * `issue:<n>` origin. Quoted whole, never re-derived; a Feature with none ships null.
   */
  summaries: ReadonlyMap<string, FeatureSummary>;
  /**
   * The order each Feature's stories are worked in, on the same key and quoted the same
   * way. The lens forms no opinion about it — not even which wave a story is in.
   */
  sequences: ReadonlyMap<string, FeatureSequence>;
  /**
   * `featureStandingKey`'s digest per Feature number, quoted — the same value rule
   * `feature-summary` compares against `summary.standingKey`; a second digest here would
   * drift. A Feature absent from the map ships `''`, which means **not digested** rather
   * than "nothing has moved", and the cockpit must draw no marker for it.
   */
  standingKeys: ReadonlyMap<number, string>;
  /** The standing delivery verdicts — quoted for the briefing, never re-derived. */
  deliveries: readonly IssueDelivery[];
  /** The standing shortfall verdicts, likewise. */
  shortfalls: readonly IssueShortfall[];
  /** Every escalation; the briefing reads the open ones. */
  escalations: readonly Escalation[];
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
 * The feature board: every container the mirror's items hang off, with the work beneath it
 * folded.
 *
 * **A lens, and every reading in it is a quotation** — the outcome word, the money, the
 * watch bucket, the container test and the environment fold all come from the module that
 * owns them. Nothing here decides anything and no rule under `src/dispatcher/` reads it.
 * Pure, so no column can go stale against config.
 *
 * **It ships no verdict about a Feature** — no "at risk", no forecast date: each would be
 * a policy no config states and no module owns. It ships facts; the cockpit composes the
 * sentence. → `docs/spec/17-cockpit.md#the-feature-board`
 */
export function buildFeatureBoard(input: BuildInput): Omit<FeatureBoardPayload, 'backfilling' | 'refUrls'> {
  const { items, outcomes, costs, featureSlots, running, containerTypes, watchLabel } = input;

  const reachByGoal = new Map(input.reach.map((r) => [r.goalRef, r.environments]));
  const landedAt = lastLandingByGoal(input.landings);
  const landingsByGoal = landingRowsByGoal(input.landings);
  const brief: BriefingContext = {
    running,
    deliveries: byIssueNumber(input.deliveries),
    shortfalls: byIssueNumber(input.shortfalls),
    questions: openQuestionsByGoal(input.escalations),
  };

  const groups = new Map<number, { title: string; rows: FeatureChildRow[] }>();
  const orphanRows: FeatureChildRow[] = [];
  let unresolved = 0;

  for (const item of items) {
    // A container is never its own child: counting one in a parent Epic's bar would put
    // a whole Feature's worth of stories in the denominator as one item.
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

  // The container's own mirrored row, where the tracker's filter happened to return it.
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
      briefing: briefingFor(group.rows, brief),
      summary: input.summaries.get(`issue:${number}`) ?? null,
      sequence: input.sequences.get(`issue:${number}`) ?? null,
      children: orderChildren(group.rows).slice(0, FEATURE_CHILDREN),
      costUsd: totalCost(group.rows),
      reach: foldReach(group.rows, reachByGoal, input.environments),
      lastLandingAt: latestLanding(group.rows, landedAt),
      landings: landingsUnder(group.rows, landingsByGoal),
      standingKey: input.standingKeys.get(number) ?? '',
    });
  }

  return {
    features: features.sort(byWantsYouThenSize),
    orphans:
      orphanRows.length === 0
        ? null
        : {
            counts: countStandings(orphanRows),
            briefing: briefingFor(orphanRows, brief),
            children: orderChildren(orphanRows).slice(0, FEATURE_CHILDREN),
            costUsd: totalCost(orphanRows),
            lastLandingAt: latestLanding(orphanRows, landedAt),
            landings: landingsUnder(orphanRows, landingsByGoal),
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
    running: ReadonlyMap<number, string>;
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
 * Which segment of the bar an item lands in, in strict precedence order — each step is
 * load-bearing. `unwatched` first: an item the fleet cannot see is not queued behind
 * anything. `inFlight` next, above every outcome word, because a re-picked goal carries
 * its last attempt's verdict. Then the outcome words, as `ticketOutcomes` spelled them.
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

interface BriefingContext {
  running: ReadonlyMap<number, string>;
  deliveries: ReadonlyMap<number, IssueDelivery>;
  shortfalls: ReadonlyMap<number, IssueShortfall>;
  questions: ReadonlyMap<number, Escalation[]>;
}

/**
 * The three lists a person outside the fleet reads first: what is being worked, what was
 * delivered, and what is stopping the rest.
 *
 * **Every sentence in it was written by somebody** — quoted from the delivery, shortfall
 * or escalation, never reworded and never assembled from the counts. The **outcome word**
 * decides the done and blocked lists, not the standing, so a re-picked goal keeps its last
 * verdict while an agent works the next attempt. A question counts only where the
 * escalation names the goal itself (`issue:<n>`), never by a guess.
 */
function briefingFor(rows: readonly FeatureChildRow[], ctx: BriefingContext): FeatureBriefing {
  const working: FeatureWorkingRow[] = [];
  const delivered: FeatureReportRow[] = [];
  const blocking: FeatureBlockRow[] = [];

  for (const { number, title, standing, outcome } of rows) {
    const since = ctx.running.get(number);
    if (since !== undefined && standing === 'inFlight') working.push({ number, title, since });

    const delivery = ctx.deliveries.get(number);
    if (outcome === 'delivered' && delivery) {
      delivered.push({ number, title, summary: delivery.summary, by: delivery.by, at: delivery.decidedAt });
    }

    for (const ask of ctx.questions.get(number) ?? []) {
      blocking.push({ number, title, kind: 'question', summary: ask.prompt, since: ask.createdAt });
    }

    const shortfall = ctx.shortfalls.get(number);
    if (outcome === 'fell short' && shortfall) {
      blocking.push({ number, title, kind: 'fellShort', summary: shortfall.summary, since: shortfall.decidedAt });
    }
  }

  working.sort((a, b) => b.since.localeCompare(a.since));
  delivered.sort((a, b) => b.at.localeCompare(a.at));
  // A question outranks a shortfall of any age: one has an agent stopped against it.
  blocking.sort((a, b) => blockRank(a) - blockRank(b) || b.since.localeCompare(a.since));

  return {
    working: working.slice(0, FEATURE_BRIEFING_ROWS),
    workingTotal: working.length,
    delivered: delivered.slice(0, FEATURE_BRIEFING_ROWS),
    deliveredTotal: delivered.length,
    blocking: blocking.slice(0, FEATURE_BRIEFING_ROWS),
    blockingTotal: blocking.length,
  };
}

function blockRank(row: FeatureBlockRow): number {
  return row.kind === 'question' ? 0 : 1;
}

/** The standing verdict per issue number — one row per origin, as the store holds it. */
function byIssueNumber<T extends { originRef: string }>(rows: readonly T[]): Map<number, T> {
  const out = new Map<number, T>();
  for (const row of rows) {
    const number = issueNumberOf(row.originRef);
    if (number !== null) out.set(number, row);
  }
  return out;
}

/**
 * The open escalations that name a goal, keyed on it. `open` and not "unanswered": a
 * dismissed escalation has `answeredAt` null for ever, and would block a Feature on a
 * question nobody is being asked.
 */
function openQuestionsByGoal(escalations: readonly Escalation[]): Map<number, Escalation[]> {
  const out = new Map<number, Escalation[]>();
  for (const escalation of escalations) {
    if (escalation.status !== 'open') continue;
    const number = issueNumberOf(escalation.context.originRef ?? '');
    if (number === null) continue;
    const seen = out.get(number);
    if (seen) seen.push(escalation);
    else out.set(number, [escalation]);
  }
  return out;
}

function issueNumberOf(ref: string): number | null {
  const match = /^issue:(\d+)$/.exec(ref);
  return match ? Number(match[1]) : null;
}

/**
 * Null where the fleet never ran on any of this Feature's children, and a number —
 * possibly `0` — where it ran and cost nothing measurable. PTY agents report no usage, so
 * `$0.00` would claim free work where the truth is unmeasured work.
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
 * The Feature's standing in each environment, folded from its goals'. Only goals
 * `allGoalReach` produced a row for are counted — counting a never-started story as
 * `absent` would leave a shipped Feature reading as a third deployed for good.
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
      // `partial` and `unknown` are both unresolved one tier up — a probe that could not
      // answer must never fold to `absent`, which falls through as neither.
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
 * Every landing under these goals, newest first and cut at {@link FEATURE_LANDINGS}.
 * Each row is the `goal_landings` stamp quoted — no rate, no window; the cockpit
 * names the window it counts inside.
 */
function landingsUnder(
  rows: readonly FeatureChildRow[],
  landingsByGoal: ReadonlyMap<number, FeatureLandingRow[]>,
): FeatureLandingRow[] {
  const out: FeatureLandingRow[] = [];
  for (const row of rows) out.push(...(landingsByGoal.get(row.number) ?? []));
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, FEATURE_LANDINGS);
}

function landingRowsByGoal(landings: readonly GoalLanding[]): Map<number, FeatureLandingRow[]> {
  const out = new Map<number, FeatureLandingRow[]>();
  for (const landing of landings) {
    const goal = issueNumberOf(landing.goalRef);
    if (goal === null) continue;
    const row: FeatureLandingRow = { goal, prNumber: landing.prNumber, at: landing.recordedAt };
    const seen = out.get(goal);
    if (seen) seen.push(row);
    else out.set(goal, [row]);
  }
  return out;
}

/**
 * The children a reader most needs first: what is happening, then what is stuck, then the
 * rest. The board ships a bounded slice ({@link FEATURE_CHILDREN}), so this decides *which*
 * rows a large Feature shows, not merely how they sit.
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
 * Features that want a person, then the ones carrying the most work. **An ordering, not a
 * verdict**: it says which card to read first and nothing about whether a Feature is in
 * trouble. What counts as wanting a person is a count of facts, never a judgement.
 */
function byWantsYouThenSize(a: FeatureRollup, b: FeatureRollup): number {
  const wants = (f: FeatureRollup) => f.counts.fellShort + f.counts.unwatched;
  return wants(b) - wants(a) || b.counts.total - a.counts.total || a.number - b.number;
}

/**
 * Whether this deployment has a feature board at all — the operator's flag **and** the
 * provider's hierarchy. One exported predicate, because the route's refusal and the
 * cockpit's tab must never disagree. The provider half is `canPlaceWorkItem`, asked of the
 * connector and never inferred from its name. → `src/sink/actionSink.ts`
 */
export function featureBoardOn(config: { featureBoard: boolean }, connector: { canPlaceWorkItem(): boolean }): boolean {
  return config.featureBoard && connector.canPlaceWorkItem();
}
