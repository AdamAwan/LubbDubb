import type { AccountRateLimits, Agent, TaskSummary, UsageEvent, WorldEvent } from '../types.js';
import type { SpendGoal } from './spendInsights.js';
import { issueBehind, roundUsd, unmeasured } from './issueSpend.js';
import type { InsightsWindowView } from './insightsWindow.js';

// → docs/spec/18-observability.md

const GAP_MS = 15 * 60_000;

const FIT_MS = 48 * 3_600_000;

const MIN_FIT_READINGS = 3;

const SLOTS = 5;

export interface AllowanceReading {
  at: string;
  fiveHour: number | null;
  sevenDay: number | null;
  afterGap: boolean;
  afterReset: boolean;
}

export interface AllowanceLane {
  agentId: string;
  title: string | null;
  issueNumber: number | null;
  slot: number | null;
  startedAt: string;
  endedAt: string | null;
  measured: boolean;
}

export interface AllowanceGoal {
  issueNumber: number;
  originRef: string;
  title: string | null;
  slot: number;
  costUsd: number;
  points: number;
  landed: number;
  pointsPerLanded: number | null;
}

export interface AllowanceApportionment {
  observedPoints: number | null;
  attributedPoints: number;
  unattributedPoints: number;
  pointsPerUsd: number | null;
  goals: AllowanceGoal[];
}

export interface AllowanceProjection {
  usedPercentage: number;
  capturedAt: string;
  resetsAt: string | null;
  ratePerHour: number | null;
  exhaustsAt: string | null;
  beforeReset: boolean | null;
  fittedFrom: number;
}

export interface AllowanceInsights {
  generatedAt: string;
  window: InsightsWindowView;
  readings: AllowanceReading[];
  lanes: AllowanceLane[];
  apportionment: AllowanceApportionment;
  projection: AllowanceProjection | null;
}

interface AllowanceInput {
  readings: readonly AccountRateLimits[];
  weekReadings: readonly AccountRateLimits[];
  usageEvents: readonly UsageEvent[];
  costDeltas: readonly { costUsd: number; at: string }[];
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
  nodes: readonly { ref: string; parentRef: string | null }[];
  goals: readonly SpendGoal[];
  attribution: ReadonlyMap<string, number | null>;
  mergeEvents: readonly WorldEvent[];
  window: InsightsWindowView;
  now: number;
}

export function buildAllowanceInsights(input: AllowanceInput): AllowanceInsights {
  const { readings, agents, tasks, attribution, window, now } = input;
  const titleOfTask = new Map(tasks.map((t) => [t.id, t.title]));
  const apportionment = apportion(input);
  const slotOfGoal = new Map(apportionment.goals.map((goal) => [goal.issueNumber, goal.slot]));

  return {
    generatedAt: new Date(now).toISOString(),
    window,
    readings: markReadings(readings),
    lanes: agents
      .map((agent): AllowanceLane => {
        const issueNumber = attribution.get(agent.id) ?? null;
        return {
          agentId: agent.id,
          title: titleOfTask.get(agent.taskId) ?? null,
          issueNumber,
          slot: issueNumber === null ? null : (slotOfGoal.get(issueNumber) ?? null),
          startedAt: agent.startedAt,
          endedAt: agent.endedAt,
          measured: !unmeasured(agent),
        };
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    apportionment,
    projection: project(input.weekReadings, now),
  };
}

function markReadings(readings: readonly AccountRateLimits[]): AllowanceReading[] {
  return readings.map((reading, i) => {
    const previous = readings[i - 1] ?? null;
    const used = reading.fiveHour?.usedPercentage ?? null;
    const before = previous?.fiveHour?.usedPercentage ?? null;
    return {
      at: reading.capturedAt,
      fiveHour: used,
      sevenDay: reading.sevenDay?.usedPercentage ?? null,
      afterGap: previous !== null && Date.parse(reading.capturedAt) - Date.parse(previous.capturedAt) > GAP_MS,
      afterReset: used !== null && before !== null && used < before,
    };
  });
}

function apportion(input: AllowanceInput): AllowanceApportionment {
  const { readings, usageEvents, costDeltas, agents, goals, attribution, nodes } = input;
  const points = new Map<number, number>();
  let observed = 0;
  let unattributed = 0;
  let attributed = 0;

  const goalOfAgent = new Map(agents.map((a) => [a.id, attribution.get(a.id) ?? null]));
  const agentSpend = usageEvents.map((e) => ({ at: Date.parse(e.at), costUsd: e.costUsd, agentId: e.agentId }));
  const allSpend = costDeltas.map((d) => ({ at: Date.parse(d.at), costUsd: d.costUsd }));

  for (let i = 1; i < readings.length; i++) {
    const from = readings[i - 1];
    const to = readings[i];
    const before = from?.fiveHour?.usedPercentage ?? null;
    const after = to?.fiveHour?.usedPercentage ?? null;
    if (from === undefined || to === undefined || before === null || after === null) continue;
    const rise = after - before;
    if (rise <= 0) continue;
    observed += rise;

    const startMs = Date.parse(from.capturedAt);
    const endMs = Date.parse(to.capturedAt);
    const total = allSpend.reduce((sum, d) => (d.at > startMs && d.at <= endMs ? sum + d.costUsd : sum), 0);
    if (total <= 0) {
      unattributed += rise;
      continue;
    }
    let charged = 0;
    for (const spend of agentSpend) {
      if (spend.at <= startMs || spend.at > endMs) continue;
      const issueNumber = goalOfAgent.get(spend.agentId) ?? null;
      if (issueNumber === null) continue;
      const share = (rise * spend.costUsd) / total;
      points.set(issueNumber, (points.get(issueNumber) ?? 0) + share);
      charged += share;
    }
    attributed += charged;
    unattributed += rise - charged;
  }

  const landed = landedByGoal(input.mergeEvents, nodes);
  const costUsd = goals.reduce((sum, goal) => sum + goal.costUsd, 0);
  const rows = goals
    .map((goal) => {
      const share = roundUsd(points.get(goal.issueNumber) ?? 0);
      const merged = landed.get(goal.issueNumber) ?? 0;
      return {
        issueNumber: goal.issueNumber,
        originRef: goal.originRef,
        title: goal.title,
        costUsd: goal.costUsd,
        points: share,
        landed: merged,
        pointsPerLanded: merged > 0 ? roundUsd(share / merged) : null,
      };
    })
    .filter((goal) => goal.points > 0)
    .sort((a, b) => b.points - a.points || a.issueNumber - b.issueNumber);
  const slots = assignSlots(rows.map((row) => row.issueNumber));
  const withSlots = rows.map((row): AllowanceGoal => ({ ...row, slot: slots.get(row.issueNumber) ?? 0 }));

  return {
    observedPoints: readings.length < 2 ? null : roundUsd(observed),
    attributedPoints: roundUsd(attributed),
    unattributedPoints: roundUsd(unattributed),
    pointsPerUsd: costUsd > 0 ? roundUsd(observed / costUsd) : null,
    goals: withSlots,
  };
}

function assignSlots(issueNumbers: readonly number[]): Map<number, number> {
  const taken = new Set<number>();
  const slots = new Map<number, number>();
  for (const issueNumber of issueNumbers) {
    const wanted = issueNumber % SLOTS;
    let slot = wanted;
    for (let hop = 1; taken.has(slot) && hop < SLOTS; hop++) slot = (wanted + hop) % SLOTS;
    taken.add(slot);
    slots.set(issueNumber, slot);
  }
  return slots;
}

function landedByGoal(
  mergeEvents: readonly WorldEvent[],
  nodes: readonly { ref: string; parentRef: string | null }[],
): Map<number, number> {
  const parentOf = new Map(nodes.map((n) => [n.ref, n.parentRef]));
  const landed = new Map<number, number>();
  for (const event of mergeEvents) {
    if (event.ref === null) continue;
    const issueNumber = issueBehind(event.ref, parentOf);
    if (issueNumber === null) continue;
    landed.set(issueNumber, (landed.get(issueNumber) ?? 0) + 1);
  }
  return landed;
}

function project(weekReadings: readonly AccountRateLimits[], now: number): AllowanceProjection | null {
  const withWeek = weekReadings.filter((r) => r.sevenDay !== null);
  const latest = withWeek.at(-1);
  if (latest === undefined || latest.sevenDay === null) return null;

  let fit = withWeek.filter((r) => now - Date.parse(r.capturedAt) <= FIT_MS);
  for (let i = fit.length - 1; i > 0; i--) {
    const used = fit[i]?.sevenDay?.usedPercentage ?? 0;
    const before = fit[i - 1]?.sevenDay?.usedPercentage ?? 0;
    if (used < before) {
      fit = fit.slice(i);
      break;
    }
  }

  const first = fit[0];
  const usedPercentage = latest.sevenDay.usedPercentage;
  const resetsAt = latest.sevenDay.resetsAt;
  const base: AllowanceProjection = {
    usedPercentage,
    capturedAt: latest.capturedAt,
    resetsAt,
    ratePerHour: null,
    exhaustsAt: null,
    beforeReset: null,
    fittedFrom: fit.length,
  };
  if (fit.length < MIN_FIT_READINGS || first === undefined) return base;

  const hours = (Date.parse(latest.capturedAt) - Date.parse(first.capturedAt)) / 3_600_000;
  const rise = usedPercentage - (first.sevenDay?.usedPercentage ?? 0);
  if (hours <= 0 || rise <= 0) return base;

  const ratePerHour = rise / hours;
  const exhaustsAt = new Date(now + ((100 - usedPercentage) / ratePerHour) * 3_600_000).toISOString();
  return {
    ...base,
    ratePerHour: roundUsd(ratePerHour),
    exhaustsAt,
    beforeReset: resetsAt === null ? null : Date.parse(exhaustsAt) < Date.parse(resetsAt),
  };
}
