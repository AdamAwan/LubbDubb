import type { Agent, CostDelta, Issue, IssueRun, IssueSpend, LocalRun, TaskSummary, WorkNode } from './types.js';
import { issueOriginRole } from './issueOrigins.js';
import { rollUpIssueSpend, roundUsd } from './issueSpend.js';
import { rollUpChecks, rollUpTaskTypes, type ChecksSpend, type TaskTypeSpend } from './taskTypeSpend.js';

/**
 * The spend breakdown: the same money the cost chips report, split three ways at
 * once.
 *
 * The chips answer *how much* — `$4.10 5h`, `$1.20` on a goal — and an operator
 * reading one immediately has a question the number cannot hold: **where did it
 * go**. Three splits answer it, and each is a different question:
 *
 * - **By phase** — deliberation, build, landing, evidence. What kind of work the
 *   money bought. A fleet spending half its budget deciding what to build is the
 *   finding this whole module exists to surface, and no per-goal figure shows it:
 *   a goal's total folds its planner and its parts into one number on purpose.
 * - **By goal** — the per-issue totals the cards already carry, gathered into one
 *   ranked table with the phase split inside each row, so the expensive goal and
 *   the reason it was expensive are one glance apart.
 * - **Over time** — daily buckets off `usage_events`. Cost is the one reading the
 *   harness holds that is *dated*, and a trend is the only way to tell a fleet
 *   that is spending more from one that has simply been running longer.
 *
 * ## One attribution, not two
 *
 * The per-goal totals are `rollUpIssueSpend`'s own, taken whole rather than
 * recomputed, and the phase split rides on the attribution map that roll-up
 * returns. That is deliberate and it is the sharp edge here: the panel and the
 * card state the same goal's cost inches apart in the cockpit, and a second walk
 * of the work graph would be a second opinion about which goal a pull request
 * belongs to — free to disagree, silently, on exactly the origin shapes the two
 * readings classify differently.
 *
 * ## Derived, never stored
 *
 * For [per-goal spend's reason](docs/spec/18-observability.md): the money is
 * already durable on the `agents` rows and in `usage_events`, and a table of
 * pre-summed insights would be a copy that goes stale the moment a turn reports.
 */

/**
 * What a run's money bought, as a partition of the fleet's spend.
 *
 * The issue-subtree phases are `issueOriginRole`'s vocabulary rather than a second
 * one — that module is where an origin is classified, and a new suffix must not
 * have to be remembered in two places. What it does not cover is everything
 * *outside* the subtree, which is where the last three come from: a pull request's
 * own agents (`pr:41:ci`, `pr:41:comments`), an operator's job, and the remainder.
 *
 * `ci` and `landing` are separate from `build` even though all three are work on
 * the same code, because they fail differently and an operator acts on the
 * difference: build is what the goal cost to write, and the other two are what it
 * cost to get *through*. A goal whose landing dwarfs its build is not an expensive
 * goal, it is a flaky pipeline.
 *
 * **`ci` is split out of `landing` because it is the one an operator can act on
 * alone.** Answering review comments is the cost of being reviewed and a fleet
 * cannot decline it; re-running failing checks is the cost of a *broken suite*,
 * which is a bug with a price — and folded together the two are one number that
 * cannot say which it is. `pr:<n>:ci-gate` — checks waiting on an action rather
 * than failing — counts here too: it is the same pipeline costing the same money,
 * and a phase per dispatch state would rank states instead of causes.
 */
export type SpendPhase = 'deliberation' | 'build' | 'ci' | 'landing' | 'evidence' | 'local' | 'job' | 'other';

/**
 * Reading order, funnel order: decide, build, go green, land, check, and the two
 * remainders.
 *
 * Exported because `spendTrend` walks the same phases over a different axis, and
 * a phase list written twice is a panel that silently stops counting `job` the
 * day someone adds a phase to one of them.
 */
export const PHASE_ORDER: readonly SpendPhase[] = [
  'deliberation',
  'build',
  'ci',
  'landing',
  'evidence',
  'local',
  'job',
  'other',
];

/**
 * What each phase is, in the operator's words rather than the ref vocabulary's.
 *
 * Shipped with the figures rather than held in the cockpit because it is a claim
 * about what the harness *did*, not about how to draw it: `landing` means
 * `pr:*` here and must mean it in the legend. Colour is the cockpit's business and
 * stays there.
 */
const PHASE_COPY: Record<SpendPhase, { label: string; blurb: string }> = {
  deliberation: { label: 'Deliberation', blurb: 'Planning and assaying — deciding what the work is' },
  build: { label: 'Build', blurb: 'The pickup and every part — where a branch is cut and a PR is written' },
  ci: { label: 'CI', blurb: 'Answering a pull request’s failing or blocked checks — what a red pipeline costs' },
  landing: { label: 'Landing', blurb: 'The rest of getting a pull request in — review comments, retargets, the merge' },
  evidence: { label: 'Evidence', blurb: 'Assessing what shipped, and writing the run up' },
  local: { label: 'Local runs', blurb: 'Bringing a goal’s branch up on this machine to look at it' },
  job: { label: 'Jobs', blurb: 'Work an operator queued directly, rather than a goal the harness picked up' },
  other: { label: 'Unclassified', blurb: 'Runs whose origin names none of the above — see the note below' },
};

/** How far back the trend reaches, and at what resolution. */
const TIMELINE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many runs the costliest-runs table carries. Capped because the table is a
 * *ranking* and not a ledger — the whole fleet's runs are the agent drawer's job —
 * and the panel says the cap out loud, because a silently truncated table reads as
 * a complete one.
 */
const TOP_RUNS = 20;

/**
 * The two concerns the `ci` phase is: checks that failed, and checks blocked
 * waiting on an action (`src/dispatcher/rules/prCiFailing.ts` dispatches both).
 * They ride together because they are one pipeline's bill — see {@link SpendPhase}.
 */
const CI_CONCERN = /^pr:\d+:ci(?:-gate)?$/;

/** The fleet's spend in one line, and how much of the fleet it actually covers. */
interface SpendTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * The cached share of the input, split the two ways it is priced: a read at a
   * fraction of a fresh token, a write at a premium. Both are *parts* of
   * {@link SpendTotals.inputTokens} and never additions to it.
   *
   * This is the panel's one actionable token reading. Cost already has the cache
   * discount baked in (it comes from the provider), so no figure derived from
   * cost can say whether the fleet is getting that discount — only this can, and
   * a fleet whose read share collapses is one paying full price for context it
   * had already paid to warm.
   */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * The gross input of the runs the two figures above are summed over — the
   * denominator the hit rate is a fraction *of*, and never `inputTokens`.
   *
   * They differ, and the difference is the whole reason this is shipped: a run
   * from before the split was recorded reports a gross input and no breakdown at
   * all, so dividing by the fleet's whole input would read those runs as a 0%
   * hit rate rather than as unmeasured. Same stance as
   * {@link SpendTotals.unmeasuredRuns}, one grain finer.
   */
  cacheMeasuredInputTokens: number;
  turns: number;
  /** Runs the totals are over: every agent and local run that reported any usage at all. */
  measuredRuns: number;
  /**
   * Runs that reported nothing — PTY mode throughout, or a run that ended before
   * its first `result`. Shipped beside the totals rather than left out, because
   * every figure in this panel is silent about these and a reader has no way to
   * know how much of the fleet the panel is speaking for otherwise.
   */
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
 * One goal's row: the total the card already shows, plus where inside the goal it
 * went and when it last moved.
 */
export interface SpendGoal extends IssueSpend {
  /**
   * The goal's name. From the world baseline while the tracker still lists it, and
   * from the run record the harness kept once it does not — a goal the fleet spent
   * money on was worked, and a run captures its title while it is still live. Null
   * only for a goal older than the run record itself.
   */
  title: string | null;
  /** Cost per phase, summing to `costUsd`. Every phase is keyed, most are zero. */
  byPhase: Record<SpendPhase, number>;
  /** The last time an agent on this goal was running — `null` only if none ever ended or started. */
  lastAt: string | null;
}

/** One expensive run, named well enough to find what spent it. */
export interface SpendRun {
  /**
   * The agent's id, or the local run's — {@link SpendRun.kind} says which.
   *
   * Not `agentId`, because half of these are not agents. A run id sitting in a field
   * of that name is a caller one join away from looking a local run up in the agent
   * drawer and drawing nothing, with no way to see why.
   */
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

/**
 * The trend, in rolling buckets ending now.
 *
 * Rolling rather than calendar days, which is the same stance the 5h and 7d
 * windows take: a calendar day needs a timezone, and the harness has no opinion
 * about the operator's. The last bucket is therefore "the last 24 hours" and the
 * panel labels it `now`.
 */
interface SpendTimeline {
  bucketMs: number;
  startsAt: string;
  buckets: SpendBucket[];
}

export interface SpendInsights {
  generatedAt: string;
  totals: SpendTotals;
  /**
   * The rolling windows the cost chip reads, restated here so the panel and the
   * indicator an operator opened it from cannot disagree about what the chip says.
   */
  windows: { fiveHourCostUsd: number; sevenDayCostUsd: number };
  /** Every phase with a run in it, in funnel order. A phase with nothing in it is left out. */
  phases: SpendPhaseTotal[];
  /** Costliest goal first. */
  goals: SpendGoal[];
  /** The remainder that reached no goal — `rollUpIssueSpend`'s own figure. */
  unattributedCostUsd: number;
  /**
   * Cost per kind of work — the grain below `phases`, off the rule each task
   * recorded at dispatch. A partition of the same money: review comments get a
   * figure of their own here, which no phase can give them.
   */
  taskTypes: TaskTypeSpend[];
  /** Cost per CI check — what `dotnet test` and `Qodana` are each costing. */
  checks: ChecksSpend;
  /** The {@link TOP_RUNS} costliest runs, costliest first. */
  runs: SpendRun[];
  /** How many runs the table above is a ranking *of*, so the cap can be stated against it. */
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
  /**
   * The dated cost deltas behind the trend — already windowed by the caller, and
   * **every** source of them (`Store.listCostDeltasSince`). A window drawn off the
   * agents' alone would fall short of the totals above it by exactly the local runs.
   */
  costDeltas: readonly CostDelta[];
  fiveHourCostUsd: number;
  sevenDayCostUsd: number;
  now: number;
}

/**
 * Which phase an origin's money belongs to.
 *
 * Origins only, which is why `local` is not among the answers: a local run has no
 * task and no dispatch origin, and the goal ref it does carry is the one shape that
 * would classify as `build`. Its phase is decided where its money is read, and
 * asking this function would have it guessing about a ref that means something else.
 *
 * The issue subtree defers to `issueOriginRole`, so the one place an origin suffix
 * is classified stays the one place. Its `unrecognised` answer is carried through
 * as `other` rather than guessed at, for the reason that function names an answer
 * at all: a new suffix should show up in the panel as a row an operator can ask
 * about, not be quietly folded into whichever neighbour looked closest.
 */
export function phaseOf(originRef: string | null): SpendPhase {
  if (originRef === null) return 'other';
  // `landing` is the remainder of `pr:*` rather than a list of its own suffixes,
  // and deliberately: `merge`, `comments`, `comment:<id>`, `reply`, `mergeable`
  // and the bare `pr:<n>` all belong there, and a new one must not have to be
  // remembered here to be counted at all. Only CI is named, because only CI is
  // being lifted out.
  if (originRef.startsWith('pr:')) return CI_CONCERN.test(originRef) ? 'ci' : 'landing';
  if (originRef.startsWith('job:')) return 'job';
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

/**
 * A phase in the operator's words. Exported so a second panel naming these phases
 * names them identically: `landing` means `pr:*` here, in the legend, and anywhere
 * else the vocabulary is borrowed.
 */
export function phaseLabel(phase: SpendPhase): string {
  return PHASE_COPY[phase].label;
}

/**
 * A zeroed phase record — the shape every `byPhase` starts from, so every key is
 * present. Exported alongside {@link PHASE_ORDER} and for its reason.
 */
export function zeroPhases(): Record<SpendPhase, number> {
  return { deliberation: 0, build: 0, ci: 0, landing: 0, evidence: 0, local: 0, job: 0, other: 0 };
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
 * The per-goal rows, costliest first — `rollUpIssueSpend`'s totals with the phase
 * split and the last activity folded on.
 *
 * Its own function because two panels want it and only one of them wants the rest
 * of this module. `spendTrend` cohorts these rows by the week each goal closed
 * and needs nothing else here; making it call {@link buildSpendInsights} would
 * have it computing a run ranking and a check table to throw both away, and
 * having it roll up goals itself would be the second opinion about which goal a
 * pull request belongs to that this module opens by refusing to have.
 */
export function buildSpendGoals(input: {
  agents: readonly Agent[];
  /** The goal's other spender — see {@link rollUpIssueSpend}. */
  localRuns: readonly LocalRun[];
  tasks: readonly TaskSummary[];
  nodes: readonly WorkNode[];
  issues: readonly Issue[];
  /**
   * The run records — the harness's own memory of every goal it has worked, whose
   * titles were captured while the issue was live and are never rewritten.
   *
   * Second to the world and not instead of it: a live issue's title is the current
   * one, and a run's is the one it had when the tracker last returned it. But the
   * world baseline is the tracker's *open* set, so a goal that was closed, retired
   * or dismissed drops out of it — while the money the fleet spent under it stays
   * on this table forever. Naming those rows off the world alone left every one of
   * them drawn as its number and an apology, which is the failure this exists to
   * end: the harness does know what they were.
   */
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
    // The roll-up's own silence about a run that reported nothing, kept here so
    // the phase split is a partition of exactly the money the totals are over.
    if (agent.costUsd === null && agent.inputTokens === null && agent.outputTokens === null) continue;
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
    // A local run counts as activity on the goal for the same reason its money does:
    // somebody was looking at this goal's work then.
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
  const { agents, localRuns, tasks, nodes, issues, costDeltas, now } = input;
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const titleOfTask = new Map(tasks.map((t) => [t.id, t.title]));
  // The per-goal totals and the attribution behind them, computed once by the
  // fold that owns the question — never a second walk of the graph. See above.
  const rollup = buildSpendGoals({ agents, localRuns, tasks, nodes, issues, runs: input.runs });

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

  for (const agent of agents) {
    // The same silence `rollUpIssueSpend` keeps, and for the same reason: a run
    // that reported nothing is unmeasured, not free. It is counted here — once,
    // as a caveat — and appears in no figure.
    if (agent.costUsd === null && agent.inputTokens === null && agent.outputTokens === null) {
      totals.unmeasuredRuns += 1;
      continue;
    }
    const cost = agent.costUsd ?? 0;
    const inputTokens = agent.inputTokens ?? 0;
    const outputTokens = agent.outputTokens ?? 0;
    const originRef = originOfTask.get(agent.taskId) ?? null;
    const phase = phaseOf(originRef);
    // `undefined` (an agent the roll-up never saw) cannot happen for a measured
    // run — it walks the same list with the same test — but `null` and "absent"
    // mean the same thing to a reader either way: this run reached no goal.
    const issueNumber = rollup.attribution.get(agent.id) ?? null;

    totals.costUsd = roundUsd(totals.costUsd + cost);
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    // Both-or-neither, and the run's own input alongside them: the two columns
    // are written in one breath by `recordAgentUsage`, so a run carrying one and
    // not the other is a shape that cannot occur — testing both is what keeps a
    // future half-write out of the denominator rather than silently at 0%.
    if (agent.cacheReadTokens !== null && agent.cacheCreationTokens !== null) {
      totals.cacheReadTokens += agent.cacheReadTokens;
      totals.cacheCreationTokens += agent.cacheCreationTokens;
      totals.cacheMeasuredInputTokens += inputTokens;
    }
    totals.turns += agent.numTurns ?? 0;
    totals.measuredRuns += 1;

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

  // The same three accumulators, a second source. Its own loop rather than a
  // widened one: everything an agent's phase and attribution has to be *looked up*
  // is already decided for a local run — the phase is `local` and the goal is its
  // own origin — and a merged walk would carry both sets of lookups over both.
  for (const run of localRuns) {
    if (run.costUsd === null && run.inputTokens === null && run.outputTokens === null) {
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
      // The branch it was pointed at, which is the one thing about a local run that
      // is not on its origin — two runs of one goal are told apart by nothing else.
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
    totals,
    windows: { fiveHourCostUsd: input.fiveHourCostUsd, sevenDayCostUsd: input.sevenDayCostUsd },
    phases: PHASE_ORDER.map((p) => phaseTotals.get(p)).filter((p): p is SpendPhaseTotal => p !== undefined),
    goals: rollup.goals,
    unattributedCostUsd: rollup.unattributedCostUsd,
    taskTypes: rollUpTaskTypes({ agents, tasks }),
    checks: rollUpChecks({ agents, tasks }),
    runs: [...runs].sort((a, b) => b.costUsd - a.costUsd).slice(0, TOP_RUNS),
    rankedFrom: runs.length,
    timeline: bucketise(costDeltas, now),
  };
}

/**
 * The dated deltas, folded into rolling daily buckets ending now.
 *
 * An event older than the window is dropped rather than clamped into the first
 * bucket: the caller already asked the store for exactly this window, so anything
 * outside it is a clock skew rather than history, and a spike drawn on day one
 * that nothing spent there is worse than a missing point.
 */
function bucketise(events: readonly CostDelta[], now: number): SpendTimeline {
  const start = now - TIMELINE_DAYS * DAY_MS;
  const buckets: SpendBucket[] = Array.from({ length: TIMELINE_DAYS }, (_, i) => ({
    startsAt: new Date(start + i * DAY_MS).toISOString(),
    costUsd: 0,
  }));
  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at) || at < start) continue;
    const index = Math.min(TIMELINE_DAYS - 1, Math.floor((at - start) / DAY_MS));
    const bucket = buckets[index];
    if (bucket) bucket.costUsd = roundUsd(bucket.costUsd + event.costUsd);
  }
  return { bucketMs: DAY_MS, startsAt: new Date(start).toISOString(), buckets };
}

/** How far back {@link buildSpendInsights} wants dated events — the route's `since`. */
export function spendTimelineSince(now: number): string {
  return new Date(now - TIMELINE_DAYS * DAY_MS).toISOString();
}
