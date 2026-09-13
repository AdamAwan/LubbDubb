import type { Agent, AgentStatus, TaskSummary, UsageEvent, WorldEvent } from '../types.js';
import { prNodeRefOf, roundUsd, unmeasured } from './issueSpend.js';
import { phaseLabel, phaseOf, type SpendPhase } from './spendInsights.js';
import { ciStatusOf } from '../world/worldDiff.js';
import {
  bucketIndexIn,
  runInWindow,
  runInstant,
  timelineSpan,
  windowView,
  type InsightsWindowView,
  type ResolvedWindow,
  type TimelineSpan,
} from './insightsWindow.js';

// → docs/spec/18-observability.md

const TOP_ROWS = 10;

export type RunOutcome = Extract<AgentStatus, 'done' | 'failed' | 'crashed' | 'killed' | 'interrupted'>;

const OUTCOME_ORDER: readonly RunOutcome[] = ['done', 'failed', 'crashed', 'killed', 'interrupted'];

const LOST: readonly RunOutcome[] = ['failed', 'crashed'];

const OUTCOME_COPY: Record<RunOutcome, { label: string; blurb: string }> = {
  done: { label: 'Finished', blurb: 'The agent ran to its own end' },
  failed: { label: 'Failed', blurb: 'The process exited non-zero — the harness did not stop it' },
  crashed: { label: 'Crashed', blurb: 'Found dead at boot: the server went down with the agent still out' },
  killed: { label: 'Killed', blurb: 'An operator stopped it, or the harness reclaimed its slot' },
  interrupted: { label: 'Interrupted', blurb: 'Cut short mid-run and left recoverable' },
};

export interface RunOutcomeTotal {
  outcome: RunOutcome;
  label: string;
  blurb: string;
  runs: number;
  costUsd: number;
}

export interface RunPhaseHealth {
  phase: SpendPhase;
  label: string;
  settled: number;
  completed: number;
  lost: number;
  stopped: number;
  completionRate: number | null;
  lostCostUsd: number;
  medianMs: number | null;
}

export interface RunRepeat {
  originRef: string;
  title: string | null;
  runs: number;
  lost: number;
  costUsd: number;
  lastAt: string;
}

interface RunBucket {
  startsAt: string;
  settled: number;
  lost: number;
}

export interface RunTally {
  settled: number;
  live: number;
  completed: number;
  lost: number;
  stopped: number;
  completionRate: number | null;
}

interface RunHealth extends RunTally {
  costUsd: number;
  lostCostUsd: number;
  unmeasuredRuns: number;
  byOutcome: RunOutcomeTotal[];
  byPhase: RunPhaseHealth[];
  repeats: RunRepeat[];
  repeatedOrigins: number;
  timeline: { bucketMs: number; startsAt: string; buckets: RunBucket[] };
}

export interface CiSubject {
  ref: string;
  prNumber: number | null;
  reds: number;
  greens: number;
  redMs: number;
  stillRed: boolean;
  costUsd: number;
}

interface CiBucket {
  startsAt: string;
  red: number;
  green: number;
}

export interface CiHealth {
  reds: number;
  greens: number;
  redRate: number | null;
  prsAffected: number;
  prsObserved: number;
  recoveries: number;
  medianToGreenMs: number | null;
  slowestToGreenMs: number | null;
  unrecovered: number;
  flakiest: CiSubject[];
  ciCostUsd: number;
  landingCostUsd: number;
  timeline: { bucketMs: number; startsAt: string; buckets: CiBucket[] };
}

export interface ReliabilityInsights {
  generatedAt: string;
  window: InsightsWindowView;
  runs: RunHealth;
  ci: CiHealth;
}

interface ReliabilityInput {
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
  ciEvents: readonly WorldEvent[];
  usageEvents: readonly UsageEvent[];
  window: ResolvedWindow;
  now: number;
}

function outcomeOf(status: AgentStatus): RunOutcome | null {
  return OUTCOME_ORDER.includes(status as RunOutcome) ? (status as RunOutcome) : null;
}

function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function prNumberOf(ref: string): number | null {
  const found = /^pr:(\d+)$/.exec(ref)?.[1];
  return found === undefined ? null : Number(found);
}

export function tallyRunOutcomes(agents: readonly Agent[]): RunTally {
  const tally: RunTally = { settled: 0, live: 0, completed: 0, lost: 0, stopped: 0, completionRate: null };
  for (const agent of agents) {
    const outcome = outcomeOf(agent.status);
    if (outcome === null) {
      tally.live += 1;
      continue;
    }
    tally.settled += 1;
    if (outcome === 'done') tally.completed += 1;
    else if (LOST.includes(outcome)) tally.lost += 1;
    else tally.stopped += 1;
  }
  tally.completionRate = tally.settled > 0 ? tally.completed / tally.settled : null;
  return tally;
}

export function buildReliabilityInsights(input: ReliabilityInput): ReliabilityInsights {
  const { now, window } = input;
  const windowed: ReliabilityInput = {
    ...input,
    agents: input.agents.filter((agent) => runInWindow(window, agent)),
  };
  const span = timelineSpan(
    window,
    [...windowed.agents.map(runInstant), ...input.ciEvents.map((e) => Date.parse(e.createdAt))].reduce<number | null>(
      (oldest, at) => (Number.isNaN(at) ? oldest : oldest === null || at < oldest ? at : oldest),
      null,
    ),
  );
  return {
    generatedAt: new Date(now).toISOString(),
    window: windowView(window, span),
    runs: buildRunHealth(windowed, span),
    ci: buildCiHealth(windowed, span),
  };
}

function buildRunHealth({ agents, tasks }: ReliabilityInput, span: TimelineSpan): RunHealth {
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const titleOfTask = new Map(tasks.map((t) => [t.id, t.title]));

  const health: RunHealth = {
    ...tallyRunOutcomes(agents),
    costUsd: 0,
    lostCostUsd: 0,
    unmeasuredRuns: 0,
    byOutcome: [],
    byPhase: [],
    repeats: [],
    repeatedOrigins: 0,
    timeline: {
      bucketMs: span.bucketMs,
      startsAt: new Date(span.startMs).toISOString(),
      buckets: Array.from({ length: span.buckets }, (_, i) => ({
        startsAt: new Date(span.startMs + i * span.bucketMs).toISOString(),
        settled: 0,
        lost: 0,
      })),
    },
  };

  const outcomes = new Map<RunOutcome, RunOutcomeTotal>();
  const phases = new Map<SpendPhase, RunPhaseHealth & { durations: number[] }>();
  const repeats = new Map<string, RunRepeat>();

  for (const agent of agents) {
    const outcome = outcomeOf(agent.status);
    if (outcome === null) continue;
    const cost = agent.costUsd ?? 0;
    const lost = LOST.includes(outcome);
    const originRef = originOfTask.get(agent.taskId) ?? null;
    const phase = phaseOf(originRef);

    health.costUsd = roundUsd(health.costUsd + cost);
    if (unmeasured(agent)) health.unmeasuredRuns += 1;
    if (lost) health.lostCostUsd = roundUsd(health.lostCostUsd + cost);

    const total = outcomes.get(outcome) ?? { outcome, ...OUTCOME_COPY[outcome], runs: 0, costUsd: 0 };
    total.runs += 1;
    total.costUsd = roundUsd(total.costUsd + cost);
    outcomes.set(outcome, total);

    const row = phases.get(phase) ?? {
      phase,
      label: phaseLabel(phase),
      settled: 0,
      completed: 0,
      lost: 0,
      stopped: 0,
      completionRate: null,
      lostCostUsd: 0,
      medianMs: null,
      durations: [],
    };
    row.settled += 1;
    if (outcome === 'done') row.completed += 1;
    else if (lost) {
      row.lost += 1;
      row.lostCostUsd = roundUsd(row.lostCostUsd + cost);
    } else row.stopped += 1;
    if (agent.endedAt !== null) {
      const ms = Date.parse(agent.endedAt) - Date.parse(agent.startedAt);
      if (Number.isFinite(ms) && ms >= 0) row.durations.push(ms);
    }
    phases.set(phase, row);

    if (originRef !== null) {
      const seen = repeats.get(originRef) ?? {
        originRef,
        title: null,
        runs: 0,
        lost: 0,
        costUsd: 0,
        lastAt: '',
      };
      seen.runs += 1;
      if (lost) seen.lost += 1;
      seen.costUsd = roundUsd(seen.costUsd + cost);
      const at = agent.endedAt ?? agent.startedAt;
      if (at >= seen.lastAt) {
        seen.lastAt = at;
        seen.title = titleOfTask.get(agent.taskId) ?? null;
      }
      repeats.set(originRef, seen);
    }

    const index = bucketIndexIn(span, runInstant(agent));
    const bucket = index === null ? undefined : health.timeline.buckets[index];
    if (bucket) {
      bucket.settled += 1;
      if (lost) bucket.lost += 1;
    }
  }

  const repeated = [...repeats.values()].filter((r) => r.runs > 1);
  health.byOutcome = OUTCOME_ORDER.map((o) => outcomes.get(o)).filter((o): o is RunOutcomeTotal => o !== undefined);
  health.byPhase = [...phases.values()]
    .map(({ durations, ...row }) => ({
      ...row,
      completionRate: row.completed / row.settled,
      medianMs: median(durations),
    }))
    .sort((a, b) => b.settled - a.settled || a.phase.localeCompare(b.phase));
  health.repeats = repeated.sort((a, b) => b.runs - a.runs || b.costUsd - a.costUsd).slice(0, TOP_ROWS);
  health.repeatedOrigins = repeated.length;
  return health;
}

function buildCiHealth({ agents, tasks, ciEvents, usageEvents, now }: ReliabilityInput, span: TimelineSpan): CiHealth {
  const buckets: CiBucket[] = Array.from({ length: span.buckets }, (_, i) => ({
    startsAt: new Date(span.startMs + i * span.bucketMs).toISOString(),
    red: 0,
    green: 0,
  }));

  const subjects = new Map<string, CiSubject>();
  const redSince = new Map<string, number>();
  const recoveries: number[] = [];
  let reds = 0;
  let greens = 0;

  for (const event of ciEvents) {
    const status = ciStatusOf(event);
    if (event.ref === null || (status !== 'failing' && status !== 'passing')) continue;
    const at = Date.parse(event.createdAt);
    if (Number.isNaN(at)) continue;

    const subject = subjects.get(event.ref) ?? {
      ref: event.ref,
      prNumber: prNumberOf(event.ref),
      reds: 0,
      greens: 0,
      redMs: 0,
      stillRed: false,
      costUsd: 0,
    };

    if (status === 'failing') {
      reds += 1;
      subject.reds += 1;
      const bucket = buckets[bucketIndexIn(span, at) ?? -1];
      if (bucket) bucket.red += 1;
      if (!redSince.has(event.ref)) redSince.set(event.ref, at);
    } else {
      greens += 1;
      subject.greens += 1;
      const bucket = buckets[bucketIndexIn(span, at) ?? -1];
      if (bucket) bucket.green += 1;
      const since = redSince.get(event.ref);
      if (since !== undefined) {
        recoveries.push(at - since);
        subject.redMs += at - since;
        redSince.delete(event.ref);
      }
    }
    subjects.set(event.ref, subject);
  }

  for (const [ref, since] of redSince) {
    const subject = subjects.get(ref);
    if (!subject) continue;
    subject.stillRed = true;
    subject.redMs += now - since;
  }

  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const prRuns = new Map<string, { phase: 'ci' | 'landing'; ref: string | null }>();
  for (const agent of agents) {
    const originRef = originOfTask.get(agent.taskId) ?? null;
    const phase = phaseOf(originRef);
    if (phase !== 'ci' && phase !== 'landing') continue;
    prRuns.set(agent.id, { phase, ref: originRef === null ? null : prNodeRefOf(originRef) });
  }

  let ciCostUsd = 0;
  let landingCostUsd = 0;
  for (const event of usageEvents) {
    const run = prRuns.get(event.agentId);
    if (run === undefined || Date.parse(event.at) < span.startMs) continue;
    if (run.phase === 'landing') {
      landingCostUsd = roundUsd(landingCostUsd + event.costUsd);
      continue;
    }
    ciCostUsd = roundUsd(ciCostUsd + event.costUsd);
    const subject = run.ref === null ? undefined : subjects.get(run.ref);
    if (subject) subject.costUsd = roundUsd(subject.costUsd + event.costUsd);
  }

  const ranked = [...subjects.values()].sort((a, b) => b.reds - a.reds || b.redMs - a.redMs);
  return {
    reds,
    greens,
    redRate: reds + greens > 0 ? reds / (reds + greens) : null,
    prsAffected: ranked.filter((s) => s.reds > 0).length,
    prsObserved: ranked.length,
    recoveries: recoveries.length,
    medianToGreenMs: median(recoveries),
    slowestToGreenMs: recoveries.length > 0 ? Math.max(...recoveries) : null,
    unrecovered: redSince.size,
    flakiest: ranked.filter((s) => s.reds > 0).slice(0, TOP_ROWS),
    ciCostUsd,
    landingCostUsd,
    timeline: { bucketMs: span.bucketMs, startsAt: new Date(span.startMs).toISOString(), buckets },
  };
}
