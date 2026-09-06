import { rollUpReach } from '../environments/reach.js';
import { isContainerType } from '../issueRelations.js';
import type { MirroredTicket } from '../store/tickets.js';
import type {
  Escalation,
  FeatureSequence,
  FeatureSummary,
  GoalEnvironmentReach,
  GoalLanding,
  GoalPause,
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

// → docs/spec/17-cockpit.md

export const FEATURE_CHILDREN = 25;

export const FEATURE_BRIEFING_ROWS = 3;

export const FEATURE_LANDINGS = 25;

interface BuildInput {
  items: readonly MirroredTicket[];
  outcomes: ReadonlyMap<number, string>;
  costs: ReadonlyMap<number, number>;
  featureSlots: ReadonlyMap<number, number>;
  running: ReadonlyMap<number, string>;
  summaries: ReadonlyMap<string, FeatureSummary>;
  sequences: ReadonlyMap<string, FeatureSequence>;
  standingKeys: ReadonlyMap<number, string>;
  deliveries: readonly IssueDelivery[];
  shortfalls: readonly IssueShortfall[];
  escalations: readonly Escalation[];
  reach: readonly { goalRef: string; environments: GoalEnvironmentReach[] }[];
  landings: readonly GoalLanding[];
  environments: readonly string[];
  containerTypes: readonly string[] | undefined;
  watchLabel: string;
  pauses?: ReadonlyMap<string, GoalPause>;
}

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
    if (isContainerType(item.issueType, containerTypes)) continue;

    const row = childRow(item, { outcomes, costs, running, watchLabel });
    if (item.parent === undefined) {
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
      paused: input.pauses?.get(`issue:${number}`) ?? null,
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
    costUsd: ctx.costs.get(item.number) ?? null,
    changedAt: item.changedAt,
  };
}

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

function byIssueNumber<T extends { originRef: string }>(rows: readonly T[]): Map<number, T> {
  const out = new Map<number, T>();
  for (const row of rows) {
    const number = issueNumberOf(row.originRef);
    if (number !== null) out.set(number, row);
  }
  return out;
}

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

function totalCost(rows: readonly FeatureChildRow[]): number | null {
  let total: number | null = null;
  for (const row of rows) {
    if (row.costUsd === null) continue;
    total = (total ?? 0) + row.costUsd;
  }
  return total === null ? null : Math.round(total * 100) / 100;
}

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
      else if (found.status === 'partial' || found.status === 'unknown') unresolved += 1;
    }
    return { environment, status: rollUpReach({ total, reached, unresolved }), goals: reached, total };
  });
}

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

function byWantsYouThenSize(a: FeatureRollup, b: FeatureRollup): number {
  const wants = (f: FeatureRollup) => f.counts.fellShort + f.counts.unwatched;
  const resting = (f: FeatureRollup) => (f.paused === null ? 0 : 1);
  return resting(a) - resting(b) || wants(b) - wants(a) || b.counts.total - a.counts.total || a.number - b.number;
}

export function featureBoardOn(config: { featureBoard: boolean }, connector: { canPlaceWorkItem(): boolean }): boolean {
  return config.featureBoard && connector.canPlaceWorkItem();
}
