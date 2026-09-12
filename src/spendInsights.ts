import type {
  Agent,
  CostDelta,
  Issue,
  IssueRun,
  IssueSpend,
  LocalRun,
  TaskSummary,
  WorkNode,
  WorldEvent,
} from './types.js';
import { issueOriginRole, issueSubtreeNumber, obstacleOriginId } from './issueOrigins.js';
import { rollUpIssueSpend, roundUsd, unmeasured } from './issueSpend.js';
import { rollUpChecks, rollUpTaskTypes, type ChecksSpend, type TaskTypeSpend } from './taskTypeSpend.js';
import {
  bucketIndexIn,
  runInWindow,
  timelineSpan,
  windowView,
  type InsightsWindowView,
  type ResolvedWindow,
  type TimelineSpan,
} from './insightsWindow.js';

// → docs/spec/18-observability.md

export type SpendPhase =
  | 'deliberation'
  | 'build'
  | 'ci'
  | 'landing'
  | 'evidence'
  | 'local'
  | 'obstacle'
  | 'job'
  | 'other';

export const PHASE_ORDER: readonly SpendPhase[] = [
  'deliberation',
  'build',
  'ci',
  'landing',
  'evidence',
  'local',
  'obstacle',
  'job',
  'other',
];

const PHASE_COPY: Record<SpendPhase, { label: string; blurb: string }> = {
  deliberation: { label: 'Deliberation', blurb: 'Planning and appraising — deciding what the work is' },
  build: { label: 'Build', blurb: 'The pickup and every part — where a branch is cut and a PR is written' },
  ci: { label: 'CI', blurb: 'Answering a pull request’s failing or blocked checks — what a red pipeline costs' },
  landing: { label: 'Landing', blurb: 'The rest of getting a pull request in — review comments, retargets, the merge' },
  evidence: { label: 'Evidence', blurb: 'Assessing what shipped, and writing the run up' },
  local: { label: 'Local runs', blurb: 'Bringing a goal’s branch up on this machine to look at it' },
  obstacle: {
    label: 'Obstacles',
    blurb: 'Repairing something in the fleet’s way — a red base, a wall three goals have hit',
  },
  job: { label: 'Jobs', blurb: 'Work an operator queued directly, rather than a goal the harness picked up' },
  other: { label: 'Unclassified', blurb: 'Runs whose origin names none of the above — see the note below' },
};

const TOP_RUNS = 20;

const CI_CONCERN = /^pr:\d+:ci(?:-gate)?$/;

interface SpendTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheMeasuredInputTokens: number;
  turns: number;
  measuredRuns: number;
  unmeasuredRuns: number;
}

export interface SpendPhaseTotal {
  phase: SpendPhase;
  label: string;
  blurb: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

export interface SpendGoal extends IssueSpend {
  title: string | null;
  byPhase: Record<SpendPhase, number>;
  lastAt: string | null;
}

export interface SpendRun {
  id: string;
  kind: 'agent' | 'local';
  originRef: string | null;
  title: string | null;
  phase: SpendPhase;
  issueNumber: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number | null;
  startedAt: string;
  endedAt: string | null;
}

interface SpendBucket {
  startsAt: string;
  costUsd: number;
}

interface SpendTimeline {
  bucketMs: number;
  startsAt: string;
  buckets: SpendBucket[];
}

export interface SpendInsights {
  generatedAt: string;
  window: InsightsWindowView;
  totals: SpendTotals;
  phases: SpendPhaseTotal[];
  goals: SpendGoal[];
  unattributedCostUsd: number;
  taskTypes: TaskTypeSpend[];
  checks: ChecksSpend;
  landed: number;
  lostCostUsd: number;
  runs: SpendRun[];
  rankedFrom: number;
  timeline: SpendTimeline;
}

interface SpendInsightsInput {
  agents: readonly Agent[];
  localRuns: readonly LocalRun[];
  tasks: readonly TaskSummary[];
  nodes: readonly WorkNode[];
  issues: readonly Issue[];
  runs: readonly IssueRun[];
  costDeltas: readonly CostDelta[];
  mergeEvents: readonly WorldEvent[];
  window: ResolvedWindow;
  now: number;
}

export function phaseOf(originRef: string | null): SpendPhase {
  if (originRef === null) return 'other';
  if (originRef.startsWith('pr:')) return CI_CONCERN.test(originRef) ? 'ci' : 'landing';
  if (originRef.startsWith('job:')) return 'job';
  if (obstacleOriginId(originRef) !== null) return 'obstacle';
  const issueNumber = issueSubtreeNumber(originRef);
  if (issueNumber === null) return 'other';
  switch (issueOriginRole(issueNumber, originRef)) {
    case 'work':
      return 'build';
    case 'deliberation':
      return 'deliberation';
    case 'evidence':
      return 'evidence';
    default:
      return 'other';
  }
}

export function phaseLabel(phase: SpendPhase): string {
  return PHASE_COPY[phase].label;
}

export function zeroPhases(): Record<SpendPhase, number> {
  return { deliberation: 0, build: 0, ci: 0, landing: 0, evidence: 0, local: 0, obstacle: 0, job: 0, other: 0 };
}

function ranAt(agent: Agent): string {
  return agent.endedAt ?? agent.startedAt;
}

interface SpendGoalRollup {
  goals: SpendGoal[];
  unattributedCostUsd: number;
  attribution: Map<string, number | null>;
  localRunAttribution: Map<string, number | null>;
}

export function buildSpendGoals(input: {
  agents: readonly Agent[];
  localRuns: readonly LocalRun[];
  tasks: readonly TaskSummary[];
  nodes: readonly WorkNode[];
  issues: readonly Issue[];
  runs: readonly IssueRun[];
}): SpendGoalRollup {
  const { agents, tasks, issues } = input;
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const titleOfIssue = new Map<number, string>([
    ...input.runs.map((r): [number, string] => [r.issueNumber, r.title]),
    ...issues.map((i): [number, string] => [i.number, i.title]),
  ]);
  const rollup = rollUpIssueSpend({ agents, tasks, nodes: input.nodes, localRuns: input.localRuns });

  const goalPhases = new Map<number, Record<SpendPhase, number>>();
  const goalLastAt = new Map<number, string>();
  for (const agent of agents) {
    if (unmeasured(agent)) continue;
    const issueNumber = rollup.attribution.get(agent.id) ?? null;
    if (issueNumber === null) continue;
    const phase = phaseOf(originOfTask.get(agent.taskId) ?? null);
    const byPhase = goalPhases.get(issueNumber) ?? zeroPhases();
    byPhase[phase] = roundUsd(byPhase[phase] + (agent.costUsd ?? 0));
    goalPhases.set(issueNumber, byPhase);
    const at = ranAt(agent);
    const seen = goalLastAt.get(issueNumber);
    if (seen === undefined || at > seen) goalLastAt.set(issueNumber, at);
  }
  for (const run of input.localRuns) {
    const issueNumber = rollup.localRunAttribution.get(run.id) ?? null;
    if (issueNumber === null) continue;
    const byPhase = goalPhases.get(issueNumber) ?? zeroPhases();
    byPhase.local = roundUsd(byPhase.local + (run.costUsd ?? 0));
    goalPhases.set(issueNumber, byPhase);
    const at = run.endedAt ?? run.startedAt;
    const seen = goalLastAt.get(issueNumber);
    if (seen === undefined || at > seen) goalLastAt.set(issueNumber, at);
  }

  return {
    goals: [...rollup.byIssue.values()]
      .map((spend) => ({
        ...spend,
        title: titleOfIssue.get(spend.issueNumber) ?? null,
        byPhase: goalPhases.get(spend.issueNumber) ?? zeroPhases(),
        lastAt: goalLastAt.get(spend.issueNumber) ?? null,
      }))
      .sort((a, b) => b.costUsd - a.costUsd || a.issueNumber - b.issueNumber),
    unattributedCostUsd: rollup.unattributedCostUsd,
    attribution: rollup.attribution,
    localRunAttribution: rollup.localRunAttribution,
  };
}

export function buildSpendInsights(input: SpendInsightsInput): SpendInsights {
  const { tasks, nodes, issues, costDeltas, mergeEvents, window, now } = input;
  const agents = input.agents.filter((agent) => runInWindow(window, agent));
  const localRuns = input.localRuns.filter((run) => runInWindow(window, run));
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const titleOfTask = new Map(tasks.map((t) => [t.id, t.title]));
  const rollup = buildSpendGoals({ agents, localRuns, tasks, nodes, issues, runs: input.runs });
  const span = timelineSpan(
    window,
    costDeltas.reduce<number | null>((oldest, delta) => {
      const at = Date.parse(delta.at);
      return Number.isNaN(at) ? oldest : oldest === null || at < oldest ? at : oldest;
    }, null),
  );

  const totals: SpendTotals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheMeasuredInputTokens: 0,
    turns: 0,
    measuredRuns: 0,
    unmeasuredRuns: 0,
  };
  const phaseTotals = new Map<SpendPhase, SpendPhaseTotal>();
  const runs: SpendRun[] = [];
  let lostCostUsd = 0;

  for (const agent of agents) {
    if (unmeasured(agent)) {
      totals.unmeasuredRuns += 1;
      continue;
    }
    const cost = agent.costUsd ?? 0;
    const inputTokens = agent.inputTokens ?? 0;
    const outputTokens = agent.outputTokens ?? 0;
    const originRef = originOfTask.get(agent.taskId) ?? null;
    const phase = phaseOf(originRef);
    const issueNumber = rollup.attribution.get(agent.id) ?? null;

    totals.costUsd = roundUsd(totals.costUsd + cost);
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    if (agent.cacheReadTokens !== null && agent.cacheCreationTokens !== null) {
      totals.cacheReadTokens += agent.cacheReadTokens;
      totals.cacheCreationTokens += agent.cacheCreationTokens;
      totals.cacheMeasuredInputTokens += inputTokens;
    }
    totals.turns += agent.numTurns ?? 0;
    totals.measuredRuns += 1;
    if (agent.status === 'failed' || agent.status === 'crashed') lostCostUsd = roundUsd(lostCostUsd + cost);

    const phaseTotal = phaseTotals.get(phase) ?? {
      phase,
      ...PHASE_COPY[phase],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
    };
    phaseTotal.costUsd = roundUsd(phaseTotal.costUsd + cost);
    phaseTotal.inputTokens += inputTokens;
    phaseTotal.outputTokens += outputTokens;
    phaseTotal.runs += 1;
    phaseTotals.set(phase, phaseTotal);

    runs.push({
      id: agent.id,
      kind: 'agent',
      originRef,
      title: titleOfTask.get(agent.taskId) ?? null,
      phase,
      issueNumber,
      costUsd: cost,
      inputTokens,
      outputTokens,
      numTurns: agent.numTurns,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
    });
  }

  for (const run of localRuns) {
    if (unmeasured(run)) {
      totals.unmeasuredRuns += 1;
      continue;
    }
    const cost = run.costUsd ?? 0;
    const inputTokens = run.inputTokens ?? 0;
    const outputTokens = run.outputTokens ?? 0;
    totals.costUsd = roundUsd(totals.costUsd + cost);
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    if (run.cacheReadTokens !== null && run.cacheCreationTokens !== null) {
      totals.cacheReadTokens += run.cacheReadTokens;
      totals.cacheCreationTokens += run.cacheCreationTokens;
      totals.cacheMeasuredInputTokens += inputTokens;
    }
    totals.turns += run.numTurns ?? 0;
    totals.measuredRuns += 1;

    const phaseTotal = phaseTotals.get('local') ?? {
      phase: 'local' as const,
      ...PHASE_COPY.local,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
    };
    phaseTotal.costUsd = roundUsd(phaseTotal.costUsd + cost);
    phaseTotal.inputTokens += inputTokens;
    phaseTotal.outputTokens += outputTokens;
    phaseTotal.runs += 1;
    phaseTotals.set('local', phaseTotal);

    runs.push({
      id: run.id,
      kind: 'local',
      originRef: run.originRef,
      title: `Local run · ${run.ref}`,
      phase: 'local',
      issueNumber: rollup.localRunAttribution.get(run.id) ?? null,
      costUsd: cost,
      inputTokens,
      outputTokens,
      numTurns: run.numTurns,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    window: windowView(window, span),
    totals,
    phases: PHASE_ORDER.map((p) => phaseTotals.get(p)).filter((p): p is SpendPhaseTotal => p !== undefined),
    goals: rollup.goals,
    unattributedCostUsd: rollup.unattributedCostUsd,
    taskTypes: rollUpTaskTypes({ agents, tasks }),
    checks: rollUpChecks({ agents, tasks }),
    landed: mergeEvents.length,
    lostCostUsd,
    runs: [...runs].sort((a, b) => b.costUsd - a.costUsd).slice(0, TOP_RUNS),
    rankedFrom: runs.length,
    timeline: bucketise(costDeltas, span),
  };
}

function bucketise(events: readonly CostDelta[], span: TimelineSpan): SpendTimeline {
  const buckets: SpendBucket[] = Array.from({ length: span.buckets }, (_, i) => ({
    startsAt: new Date(span.startMs + i * span.bucketMs).toISOString(),
    costUsd: 0,
  }));
  for (const event of events) {
    const index = bucketIndexIn(span, Date.parse(event.at));
    const bucket = index === null ? undefined : buckets[index];
    if (bucket) bucket.costUsd = roundUsd(bucket.costUsd + event.costUsd);
  }
  return { bucketMs: span.bucketMs, startsAt: new Date(span.startMs).toISOString(), buckets };
}
