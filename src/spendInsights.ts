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
import { issueOriginRole, obstacleOriginId } from './issueOrigins.js';
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

/**
 * The spend breakdown: the same money the cost chips report, split three ways at once — by
 * phase, by goal (per-issue totals ranked, with the phase split inside each row), and over
 * time (rolling buckets off the dated deltas).
 *
 * One attribution, not two: the per-goal totals are `rollUpIssueSpend`'s own, taken whole,
 * and the phase split rides on the attribution map that roll-up returns, so a second walk of
 * the work graph can never silently disagree with the card in the cockpit.
 *
 * Derived, never stored — the money is already durable on `agents` and `usage_events`.
 * → `docs/spec/18-observability.md`
 */

/**
 * What a run's money bought, as a partition of the fleet's spend. The issue-subtree phases
 * are `issueOriginRole`'s vocabulary rather than a second one. `ci` and `landing` are separate
 * from `build` because they answer different questions — what the goal cost to write versus
 * what it cost to get through — and `ci` is separate from `landing` because a broken suite is
 * the half an operator can act on alone. `pr:<n>:ci-gate` counts as `ci`.
 */
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

/**
 * Reading order, funnel order: decide, build, go green, land, check, and the remainders.
 * Exported because `spendTrend` walks the same phases over a different axis.
 */
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

/** What each phase is, in the operator's words. Shipped with the figures rather than held in the cockpit, since it is a claim about what the harness did. */
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

/** How many runs the costliest-runs table carries. A ranking, not a ledger; the panel states the cap out loud. */
const TOP_RUNS = 20;

/** The two concerns the `ci` phase is: checks that failed, and checks blocked waiting on an action — they ride together as one pipeline's bill. */
const CI_CONCERN = /^pr:\d+:ci(?:-gate)?$/;

/** The fleet's spend in one line, and how much of the fleet it actually covers. */
interface SpendTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** The cached share of the input, split the two ways it is priced. Both are parts of {@link SpendTotals.inputTokens}, never additions to it. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * The gross input of the runs the two figures above are summed over — the denominator the
   * hit rate is a fraction of, never `inputTokens`: a pre-split run has no breakdown, and
   * dividing by the whole input would read it as 0% rather than unmeasured.
   */
  cacheMeasuredInputTokens: number;
  turns: number;
  /** Runs the totals are over: every agent and local run that reported any usage at all. */
  measuredRuns: number;
  /** Runs that reported nothing — PTY mode throughout, or a run that ended before its first `result`. */
  unmeasuredRuns: number;
}

export interface SpendPhaseTotal {
  phase: SpendPhase;
  label: string;
  blurb: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Runs in this phase — the denominator behind "what a planner costs on average". */
  runs: number;
}

/**
 * One goal's row: what the goal cost inside the window, where inside the goal it went, and
 * when it last moved. Not the goal card's figure, which is all-time — the two agree only on `window=all`.
 */
export interface SpendGoal extends IssueSpend {
  /** The goal's name: from the world baseline while the tracker lists it, from the run record once it does not. Null only for a goal older than the run record itself. */
  title: string | null;
  /** Cost per phase, summing to `costUsd`. Every phase is keyed, most are zero. */
  byPhase: Record<SpendPhase, number>;
  /** The last time an agent on this goal was running — `null` only if none ever ended or started. */
  lastAt: string | null;
}

/** One expensive run, named well enough to find what spent it. */
export interface SpendRun {
  /** The agent's id, or the local run's — {@link SpendRun.kind} says which. Not `agentId`, since a caller would join half of these against the agent drawer and draw nothing. */
  id: string;
  kind: 'agent' | 'local';
  originRef: string | null;
  /** The task's title — what the agent was actually asked to do. */
  title: string | null;
  phase: SpendPhase;
  /** The goal this run's money was folded into, by name or by lineage. Null when it reached none. */
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

/** The trend, in rolling buckets ending now, at the window's resolution ({@link timelineSpan}). Rolling rather than calendar, since a calendar day needs a timezone the harness has no opinion about. */
interface SpendTimeline {
  bucketMs: number;
  startsAt: string;
  buckets: SpendBucket[];
}

export interface SpendInsights {
  generatedAt: string;
  /** The stretch every figure below was measured over. Shipped rather than assumed, so the caption cannot disagree with the buckets the server actually cut. */
  window: InsightsWindowView;
  totals: SpendTotals;
  /** Every phase with a run in it, in funnel order. A phase with nothing in it is left out. */
  phases: SpendPhaseTotal[];
  /** Costliest goal first. */
  goals: SpendGoal[];
  /** The remainder that reached no goal — `rollUpIssueSpend`'s own figure. */
  unattributedCostUsd: number;
  /** Cost per kind of work — the grain below `phases`, off the rule each task recorded at dispatch, and a partition of the same money. */
  taskTypes: TaskTypeSpend[];
  /** Cost per CI check — what `dotnet test` and `Qodana` are each costing. */
  checks: ChecksSpend;
  /** Pull requests merged inside the window — the denominator of `spent ÷ landed`. Merges rather than closed goals: a goal can close without the fleet having landed anything. */
  landed: number;
  /** What the runs that failed or crashed inside the window cost. On this payload rather than the reliability one so the headline's two halves cannot describe two windows. */
  lostCostUsd: number;
  /** The {@link TOP_RUNS} costliest runs, costliest first. */
  runs: SpendRun[];
  /** How many runs the table above is a ranking of, so the cap can be stated against it. */
  rankedFrom: number;
  timeline: SpendTimeline;
}

interface SpendInsightsInput {
  agents: readonly Agent[];
  /** Every recorded local run — the second thing that spends on a goal's behalf. */
  localRuns: readonly LocalRun[];
  tasks: readonly TaskSummary[];
  /** The durable work graph — how a pull request's spend finds its goal. */
  nodes: readonly WorkNode[];
  /** The world's issues, for titles only. A goal absent from it still gets a row. */
  issues: readonly Issue[];
  /** The run records, for the titles the world has forgotten. See {@link buildSpendGoals}. */
  runs: readonly IssueRun[];
  /** The dated cost deltas behind the trend — already windowed by the caller, and every source of them (`Store.listCostDeltasSince`). The agents' alone would fall short by exactly the local runs. */
  costDeltas: readonly CostDelta[];
  /** `pr_merged` rows inside the window. Only the count is read. */
  mergeEvents: readonly WorldEvent[];
  /** The stretch to measure. Every figure below obeys it, including the goals. */
  window: ResolvedWindow;
  now: number;
}

/**
 * Which phase an origin's money belongs to. Origins only — `local` is not among the answers,
 * since a local run's phase is decided where its money is read. The issue subtree defers to
 * `issueOriginRole`, and its `unrecognised` is carried through as `other` rather than folded
 * into a neighbour, so a new suffix shows up as a row an operator can ask about.
 */
export function phaseOf(originRef: string | null): SpendPhase {
  if (originRef === null) return 'other';
  // `landing` is the remainder of `pr:*` rather than a list of suffixes, so a new one is
  // counted without being remembered here. Only CI is named, because only CI is lifted out.
  if (originRef.startsWith('pr:')) return CI_CONCERN.test(originRef) ? 'ci' : 'landing';
  if (originRef.startsWith('job:')) return 'job';
  // A repair dispatch is not any goal's work: it is what the fleet spent getting something
  // out of its own way.
  if (obstacleOriginId(originRef) !== null) return 'obstacle';
  const issueNumber = /^issue:(\d+)(?::|$)/.exec(originRef)?.[1];
  if (issueNumber === undefined) return 'other';
  switch (issueOriginRole(Number(issueNumber), originRef)) {
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

/** A phase in the operator's words. Exported so a second panel names them identically. */
export function phaseLabel(phase: SpendPhase): string {
  return PHASE_COPY[phase].label;
}

/** A zeroed phase record — the shape every `byPhase` starts from, so every key is present. */
export function zeroPhases(): Record<SpendPhase, number> {
  return { deliberation: 0, build: 0, ci: 0, landing: 0, evidence: 0, local: 0, obstacle: 0, job: 0, other: 0 };
}

/** Where an agent's run sits in time: when it finished, or when it started if it has not. */
function ranAt(agent: Agent): string {
  return agent.endedAt ?? agent.startedAt;
}

/** What {@link buildSpendGoals} hands back: the goal rows, and the map behind them. */
interface SpendGoalRollup {
  goals: SpendGoal[];
  unattributedCostUsd: number;
  /** {@link rollUpIssueSpend}'s own agent → goal map, passed through untouched. */
  attribution: Map<string, number | null>;
  /** The same, for local runs, and for the same reason: one attribution, not two. */
  localRunAttribution: Map<string, number | null>;
}

/**
 * The per-goal rows, costliest first — `rollUpIssueSpend`'s totals with the phase split and
 * the last activity folded on. Its own function because `spendTrend` wants these rows and
 * nothing else, and rolling goals up itself would be the second attribution this module refuses to have.
 */
export function buildSpendGoals(input: {
  agents: readonly Agent[];
  /** The goal's other spender — see {@link rollUpIssueSpend}. */
  localRuns: readonly LocalRun[];
  tasks: readonly TaskSummary[];
  nodes: readonly WorkNode[];
  issues: readonly Issue[];
  /** The run records — titles captured while each issue was live. Second to the world: the world baseline is the tracker's open set, so a closed goal drops out of it while its spend stays on the table forever. */
  runs: readonly IssueRun[];
}): SpendGoalRollup {
  const { agents, tasks, issues } = input;
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  // The world wins where it has an answer, so a retitled ticket reads as it does now.
  const titleOfIssue = new Map<number, string>([
    ...input.runs.map((r): [number, string] => [r.issueNumber, r.title]),
    ...issues.map((i): [number, string] => [i.number, i.title]),
  ]);
  const rollup = rollUpIssueSpend({ agents, tasks, nodes: input.nodes, localRuns: input.localRuns });

  const goalPhases = new Map<number, Record<SpendPhase, number>>();
  const goalLastAt = new Map<number, string>();
  for (const agent of agents) {
    // The roll-up's own silence about an unmeasured run, kept so the phase split partitions
    // exactly the money the totals are over.
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
    // A local run counts as activity: somebody was looking at this goal's work then.
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
  // The window is applied once, here; everything below folds the lists it produces.
  // Per-fold filtering drifts, and shows up as a phase table that does not add to its total.
  // Both spenders are cut by the same rule: a run belongs to the window it finished in.
  const agents = input.agents.filter((agent) => runInWindow(window, agent));
  const localRuns = input.localRuns.filter((run) => runInWindow(window, run));
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const titleOfTask = new Map(tasks.map((t) => [t.id, t.title]));
  // Computed once by the fold that owns the question — never a second walk of the graph.
  const rollup = buildSpendGoals({ agents, localRuns, tasks, nodes, issues, runs: input.runs });
  const span = timelineSpan(
    window,
    // The earliest reported instant, off the deltas rather than the runs — a usage-less row
    // would stretch the axis over nothing.
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
    // A run that reported nothing is unmeasured, not free: counted once as a caveat, and in
    // no figure.
    if (unmeasured(agent)) {
      totals.unmeasuredRuns += 1;
      continue;
    }
    const cost = agent.costUsd ?? 0;
    const inputTokens = agent.inputTokens ?? 0;
    const outputTokens = agent.outputTokens ?? 0;
    const originRef = originOfTask.get(agent.taskId) ?? null;
    const phase = phaseOf(originRef);
    // `undefined` cannot happen for a measured run, and reads the same as `null` anyway:
    // this run reached no goal.
    const issueNumber = rollup.attribution.get(agent.id) ?? null;

    totals.costUsd = roundUsd(totals.costUsd + cost);
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    // Both-or-neither, plus the run's own input: testing both keeps a future half-write out
    // of the denominator rather than silently at 0%.
    if (agent.cacheReadTokens !== null && agent.cacheCreationTokens !== null) {
      totals.cacheReadTokens += agent.cacheReadTokens;
      totals.cacheCreationTokens += agent.cacheCreationTokens;
      totals.cacheMeasuredInputTokens += inputTokens;
    }
    totals.turns += agent.numTurns ?? 0;
    totals.measuredRuns += 1;
    // `failed` and `crashed` only: a killed run is a steer, and counting an operator's change
    // of mind as waste makes every steered fleet look broken.
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

  // The same accumulators, a second source. Its own loop because a local run's phase and
  // goal are already decided, where an agent's have to be looked up.
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
      // The branch it was pointed at: the only thing telling two runs of one goal apart.
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

/**
 * The dated deltas, folded into rolling buckets ending now. An event outside the window is
 * dropped rather than clamped into the first bucket: it is clock skew rather than history,
 * and a spike nothing spent is worse than a missing point.
 */
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
