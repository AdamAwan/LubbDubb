import type { Agent, HumanTask, TaskSummary } from './types.js';
import { roundUsd } from './issueSpend.js';
import { DISPATCH_RULES, type DispatchRuleId } from './dispatcher/rules.js';

/**
 * What the fleet is spending **now** — the live cost question the rest of `src/spend*.ts`
 * (all post-mortem) cannot answer. A run is judged against the **median** (never the
 * mean) of settled runs in the same **rule-and-profile** bucket, and must clear
 * {@link BurnPolicy.minimumRuns}, {@link BurnPolicy.floorUsd} and the multiple; the
 * separate {@link BurnPolicy.ceilingUsd} arm covers a deployment with no history.
 *
 * It files a `burn` human task and kills nothing — an expensive run is not a wrong run.
 * PTY mode reports no usage, so `costUsd` stays null and no run there can trip it: the
 * fail-open direction. → [18](../docs/spec/18-observability.md#the-burn-watch),
 * [13](../docs/spec/13-jobs-and-tickets.md)
 */

/** How hard a live run has to be spending before it is worth an operator's eye. */
export interface BurnPolicy {
  /** Master switch. Off files nothing — and still settles rows already standing, so turning it off drains the bench. */
  enabled: boolean;
  /**
   * How many times its bucket's median a live run may reach before it surfaces. Generous
   * on purpose: the spread inside one bucket is real work, not noise.
   */
  multiple: number;
  /** Settled, measured runs a bucket needs before its median is trusted at all. */
  minimumRuns: number;
  /** Absolute money a run must also have spent, so a multiple of nearly nothing is not an alarm. */
  floorUsd: number;
  /**
   * A flat per-run ceiling that fires with no history whatever, or null for no such arm —
   * the default, because nothing here can guess the right number.
   */
  ceilingUsd: number | null;
}

/**
 * On, and conservative enough that a healthy fleet never sees it: four times the
 * median of a bucket with at least five settled runs, and never under a dollar.
 * No flat ceiling, for {@link BurnPolicy.ceilingUsd}'s reason.
 */
export const DEFAULT_BURN: BurnPolicy = {
  enabled: true,
  multiple: 4,
  minimumRuns: 5,
  floorUsd: 1,
  ceilingUsd: null,
};

/**
 * Refuse a policy that cannot do what it says, at load, naming the key. Every rejection
 * here is a value that would leave the watch running and useless.
 */
export function validateBurnPolicy(policy: BurnPolicy): void {
  if (typeof policy.multiple !== 'number' || !(policy.multiple > 1))
    throw new Error(
      `Refusing to start: spendBurn.multiple is ${JSON.stringify(policy.multiple)}, and must be a number above 1 — ` +
        `at or below 1 it flags every run at or over the median of its own kind of work.`,
    );
  if (!Number.isInteger(policy.minimumRuns) || policy.minimumRuns < 1)
    throw new Error(
      `Refusing to start: spendBurn.minimumRuns is ${JSON.stringify(policy.minimumRuns)}, and must be a whole ` +
        `number of settled runs (1 or more) before a bucket's median is trusted.`,
    );
  if (typeof policy.floorUsd !== 'number' || policy.floorUsd < 0 || !Number.isFinite(policy.floorUsd))
    throw new Error(
      `Refusing to start: spendBurn.floorUsd is ${JSON.stringify(policy.floorUsd)}, and must be a non-negative ` +
        `number of dollars a run must also have spent before a multiple counts as expensive.`,
    );
  if (policy.ceilingUsd !== null && (typeof policy.ceilingUsd !== 'number' || !(policy.ceilingUsd > 0)))
    throw new Error(
      `Refusing to start: spendBurn.ceilingUsd is ${JSON.stringify(policy.ceilingUsd)}, and must be a number of ` +
        `dollars above 0, or null for no flat ceiling.`,
    );
}

/** What a pass decided, as data — so the decisions are testable without a store. */
type BurnStep =
  | { kind: 'file'; agentId: string; originRef: string | null; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string };

interface BurnInput {
  policy: BurnPolicy;
  /** Every agent the store holds — the live ones are judged, the settled ones are the baseline. */
  agents: readonly Agent[];
  /** The pulse's tasks, for the rule and profile behind each run. */
  tasks: readonly TaskSummary[];
  /** The `burn` tasks already filed, settled ones included. */
  existing: readonly HumanTask[];
}

/** Alive for this reading — the concurrency cap's own set. `crashed` is not live. */
const LIVE: readonly Agent['status'][] = ['starting', 'running', 'waiting'];

/** Ended, however it ended — the runs a baseline is made of. */
const SETTLED: readonly Agent['status'][] = ['done', 'failed', 'crashed', 'killed', 'interrupted'];

/**
 * What this pulse owes: the notices to file or refresh, and the standing ones
 * whose run has since ended. Pure, and safe to run on every pulse — filing is
 * idempotent through `recordHumanTask`'s dedup, which is also what refreshes the
 * figures in a standing notice.
 */
export function burnPass(input: BurnInput): BurnStep[] {
  const taskOf = new Map(input.tasks.map((t) => [t.id, t]));
  const openByAgent = new Map<string, HumanTask>();
  const settledAgents = new Set<string>();
  for (const t of input.existing) {
    if (t.agentId === null) continue;
    if (t.status === 'open') openByAgent.set(t.agentId, t);
    else settledAgents.add(t.agentId);
  }
  const steps: BurnStep[] = [];

  // The settle arm runs whether or not the watch is on: a row about an ended run would
  // otherwise have no way left to close itself.
  for (const agent of input.agents) {
    if (LIVE.includes(agent.status)) continue;
    const standing = openByAgent.get(agent.id);
    if (!standing) continue;
    steps.push({
      kind: 'settle',
      taskId: standing.id,
      status: 'done',
      resolution: `the run ended ${agent.status} having spent ${money(agent.costUsd)}`,
    });
  }
  if (!input.policy.enabled) return steps;

  const medians = bucketMedians(input.agents, taskOf, input.policy.minimumRuns);

  for (const agent of input.agents) {
    if (!LIVE.includes(agent.status)) continue;
    // Unmeasured, not free. Every PTY run is this case, and a stream run before its
    // first turn reports.
    if (agent.costUsd === null) continue;
    // A notice the operator already answered is not re-filed.
    if (settledAgents.has(agent.id)) continue;
    const task = taskOf.get(agent.taskId);
    const verdict = judge(agent.costUsd, medians.get(bucketKey(task)) ?? null, input.policy);
    if (verdict === null) continue;
    steps.push({
      kind: 'file',
      agentId: agent.id,
      originRef: task?.originRef ?? null,
      title: burnTitle(task?.rule ?? null, verdict.arm),
      detail: burnDetail(agent, task ?? null, verdict, input.policy),
    });
  }

  return steps;
}

/** Which arm fired, and the numbers behind it — kept together so the notice cannot describe one and cite the other. */
interface BurnVerdict {
  arm: 'baseline' | 'ceiling';
  costUsd: number;
  /** The bucket's median and its run count — null on the ceiling arm, which has no bucket. */
  baseline: Baseline | null;
}

/** A bucket's median cost, and how many settled runs it was taken over. */
interface Baseline {
  medianUsd: number;
  runs: number;
}

/**
 * Whether this run is worth a notice, and on which arm. The baseline arm is asked first
 * and wins when both would fire — it is the more useful sentence.
 */
function judge(costUsd: number, baseline: Baseline | null, policy: BurnPolicy): BurnVerdict | null {
  if (baseline !== null && costUsd >= baseline.medianUsd * policy.multiple && costUsd >= policy.floorUsd)
    return { arm: 'baseline', costUsd, baseline };
  if (policy.ceilingUsd !== null && costUsd >= policy.ceilingUsd) return { arm: 'ceiling', costUsd, baseline };
  return null;
}

/**
 * The median settled cost of each rule-and-profile bucket with enough runs to have one. A
 * bucket below `minimumRuns` is **absent rather than zero** — a 0 would make every live
 * run in a young bucket infinitely over its median.
 */
function bucketMedians(
  agents: readonly Agent[],
  taskOf: ReadonlyMap<string, TaskSummary>,
  minimumRuns: number,
): Map<string, Baseline> {
  const costs = new Map<string, number[]>();
  for (const agent of agents) {
    if (!SETTLED.includes(agent.status) || agent.costUsd === null) continue;
    const key = bucketKey(taskOf.get(agent.taskId));
    const bucket = costs.get(key) ?? [];
    bucket.push(agent.costUsd);
    costs.set(key, bucket);
  }
  const out = new Map<string, Baseline>();
  for (const [key, values] of costs) {
    if (values.length < minimumRuns) continue;
    out.set(key, { medianUsd: median(values), runs: values.length });
  }
  return out;
}

/**
 * The two axes a run's cost is comparable along, as one key. A run with neither buckets
 * with its own kind rather than being skipped — that is a real population.
 */
function bucketKey(task: TaskSummary | undefined): string {
  return `${task?.rule ?? ''}::${task?.profile ?? ''}`;
}

/** Middle value, or the mean of the two middle ones. Sorts a copy — the caller's array is the store's reading. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return roundUsd(value);
}

/**
 * Stable across pulses, and deliberately carrying **no figure**: `recordHumanTask` dedups
 * on the title, so a title naming dollars would file a fresh row every turn. The numbers
 * live in the detail, which the same dedup refreshes in place.
 */
function burnTitle(rule: string | null, arm: BurnVerdict['arm']): string {
  const label = ruleLabel(rule);
  return arm === 'ceiling'
    ? `${label} is past the per-run spend ceiling`
    : `${label} is costing far more than that work usually does`;
}

/**
 * The rule's own name from the registry — never a second vocabulary. An id the registry
 * has lost is rendered as itself rather than folded into the unruled case.
 */
function ruleLabel(rule: string | null): string {
  if (rule === null) return 'A run dispatched outside the pulse';
  const known = DISPATCH_RULES[rule as DispatchRuleId] as { name: string } | undefined;
  return known === undefined ? `A ${rule} run` : `A ${known.name.toLowerCase()} run`;
}

/**
 * What it has spent, what that kind of work costs, and what to do — refreshed every pulse
 * the run is still going. It says out loud that nothing is held.
 */
function burnDetail(agent: Agent, task: TaskSummary | null, verdict: BurnVerdict, policy: BurnPolicy): string {
  const lines: string[] = [];
  if (verdict.arm === 'baseline' && verdict.baseline) {
    const { medianUsd, runs } = verdict.baseline;
    const times = medianUsd > 0 ? (verdict.costUsd / medianUsd).toFixed(1) : '∞';
    lines.push(
      `This run has spent **${money(verdict.costUsd)}** so far — **${times}×** the ${money(medianUsd)} median of ` +
        `the ${runs} settled ${describeBucket(task)} runs on this deployment.`,
    );
  } else {
    lines.push(
      `This run has spent **${money(verdict.costUsd)}** so far, past the **${money(policy.ceilingUsd)}** per-run ` +
        `ceiling. That is a flat limit, not a comparison — nothing here says whether this work is unusual.`,
    );
  }
  if (agent.note) lines.push('', `It last said it was: _${agent.note}_`);
  lines.push(
    '',
    `Nothing is held — this is a note, not a gate, and the run carries on either way. Open the agent (\`${agent.id}\`) ` +
      `to read what it is doing, and stop it there if it is going in circles. Marking this done stops it being ` +
      `raised again for this run; it settles itself when the run ends.`,
  );
  return lines.join('\n');
}

/** The bucket in words, on the two axes it is keyed by, for the sentence the notice is built around. */
function describeBucket(task: TaskSummary | null): string {
  const rule = task?.rule ? `\`${task.rule}\`` : 'unruled';
  return task?.profile ? `${rule} / \`${task.profile}\`` : rule;
}

/** Dollars as an operator reads them. Null is the unmeasured case and says so rather than printing $0.00. */
function money(usd: number | null): string {
  return usd === null ? 'nothing measurable' : `$${usd.toFixed(2)}`;
}
