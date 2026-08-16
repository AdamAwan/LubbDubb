import type { Agent, HumanTask, Task } from './types.js';
import { roundUsd } from './issueSpend.js';
import { DISPATCH_RULES, type DispatchRuleId } from './dispatcher/rules.js';

/**
 * What the fleet is spending **now** — the one cost question the spend module
 * cannot answer.
 *
 * Everything else in `src/spend*.ts` is a post-mortem: the breakdown asks where
 * the money went, the trend asks whether last month was better than the one
 * before. Both are read by an operator who went looking. A run that is going to
 * cost forty dollars is answerable while it is still running — `recordAgentUsage`
 * folds a cumulative report onto the `agents` row on every `result` event, so
 * `Agent.costUsd` climbs turn by turn — and nothing was watching it.
 *
 * ## What "too much" means
 *
 * A dollar figure on its own says nothing: a planner on a large goal and a retro
 * write-up have no business being held to one number. So the reading is
 * **relative to what that kind of work costs on this deployment** — the median of
 * settled runs in the same bucket.
 *
 * **The bucket is the rule _and_ the profile**, not the rule alone. That pairing
 * is not a refinement, it is what stops the check being useless: a goal pinned to
 * `deep` legitimately costs several times the same rule on `fast`
 * ([02](../docs/spec/02-configuration.md#agentmodels)), so a rule-only baseline
 * would flag every pinned run on the deployment and nothing else. Both halves are
 * already on the task, resolved once at dispatch.
 *
 * **The median, never the mean.** The runaway this exists to catch is precisely
 * the observation that drags a mean upwards — a fleet that had three expensive
 * afternoons would quietly raise its own alarm threshold until nothing could trip
 * it. `rollUpTaskTypes`' `perRunUsd` is a mean and is deliberately not reused
 * here; it answers "what does this cost me", which is a different question and
 * wants every run in it.
 *
 * ## Three things that must all hold
 *
 * A multiple on its own fires constantly, so it is gated twice over:
 *
 * - **{@link BurnPolicy.minimumRuns} settled runs in the bucket**, or there is no
 *   median worth the name. Below it the bucket is silent rather than guessed at.
 * - **{@link BurnPolicy.floorUsd} in absolute money.** Four times the median of a
 *   rule that costs eight cents is thirty-two cents, and an operator woken for
 *   that stops reading these entirely. The floor is what makes the multiple mean
 *   "expensive" rather than "unusual".
 * - **The multiple itself.**
 *
 * {@link BurnPolicy.ceilingUsd} is the separate arm for the case the first three
 * cannot cover: a deployment with no history at all, where the first runaway is
 * also the first run. It is profile-blind and absolute, off by default, and the
 * notice says which arm fired — a run flagged for passing a flat ceiling and one
 * flagged against its own kind of work are different facts.
 *
 * ## Why it files a note and kills nothing
 *
 * An expensive run is not a wrong run, and this module cannot tell the two apart:
 * a bucket mixes a one-line fix with a goal that touches nine files, and the
 * spread inside one rule is real. Killing on a threshold would eventually kill
 * work that was going to land. So the verdict is a `burn` human task — visible,
 * refreshed every pulse, and **holding nothing** ([13](../docs/spec/13-jobs-and-findings.md)).
 * The operator has the transcript and the stop button; what they did not have was
 * the prompt to go and look.
 *
 * **PTY mode reports no usage at all**, so `costUsd` stays null and no run there
 * can ever trip this ([18](../docs/spec/18-observability.md#usage-accounting)).
 * That is the fail-open direction and the only safe one: unmeasured is not free,
 * and a watch that cannot see cannot be allowed to conclude anything.
 */

/** How hard a live run has to be spending before it is worth an operator's eye. */
export interface BurnPolicy {
  /** Master switch. Off files nothing — and still settles rows already standing, so turning it off drains the bench. */
  enabled: boolean;
  /**
   * How many times its bucket's median a live run may reach before it surfaces.
   *
   * Generous on purpose. The spread inside one rule-and-profile bucket is real
   * work, not noise, so a tight multiple reports ordinary big goals — and a
   * notice an operator learns to dismiss unread is worse than no notice.
   */
  multiple: number;
  /** Settled, measured runs a bucket needs before its median is trusted at all. */
  minimumRuns: number;
  /** Absolute money a run must also have spent, so a multiple of nearly nothing is not an alarm. */
  floorUsd: number;
  /**
   * A flat per-run ceiling that fires with no history whatever, or null for "no
   * such arm" — the default, because the right number is a property of the
   * deployment's work and nothing here can guess it.
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
 * Refuse a policy that cannot do what it says, at load, naming the key.
 *
 * Every rejection here is a value that would leave the watch running and silent —
 * a multiple of 1 flags every run above the median, a `minimumRuns` of 0 trusts a
 * median of one observation — which is the failure the config rules exist to
 * prevent everywhere else.
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

/**
 * What a pass decided, as data — so the decisions are testable without a store,
 * on {@link closeOutPass}'s pattern.
 */
type BurnStep =
  | { kind: 'file'; agentId: string; originRef: string | null; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string };

interface BurnInput {
  policy: BurnPolicy;
  /** Every agent the store holds — the live ones are judged, the settled ones are the baseline. */
  agents: readonly Agent[];
  /** The pulse's tasks, for the rule and profile behind each run. */
  tasks: readonly Task[];
  /** The `burn` tasks already filed, settled ones included. */
  existing: readonly HumanTask[];
}

/**
 * Alive for this reading, which is the concurrency cap's own set: `crashed` is
 * deliberately not live ({@link AgentStatus}), and a crashed run's cost is a fact
 * about the past like any other settled run's.
 */
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

  // The settle arm runs whether or not the watch is on: an operator who turned it
  // off is owed an empty bench, not a row about a run that ended last Tuesday and
  // has no way left to close itself.
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
    // Unmeasured, not free — the silence the whole spend module keeps. Every PTY
    // run is this case, and so is a stream run before its first turn reports.
    if (agent.costUsd === null) continue;
    // A notice the operator has already answered is not re-filed. `recordHumanTask`
    // would only refresh its detail rather than reopen it, so this changes no row —
    // it is the difference between having been told once and being told again.
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
 * Whether this run is worth a notice, and on which arm.
 *
 * The baseline arm is asked first and wins when both would fire: "four times what
 * this kind of work costs" is the more useful sentence, and a deployment that set
 * a ceiling still wants to be told which of its buckets a run blew past.
 */
function judge(costUsd: number, baseline: Baseline | null, policy: BurnPolicy): BurnVerdict | null {
  if (baseline !== null && costUsd >= baseline.medianUsd * policy.multiple && costUsd >= policy.floorUsd)
    return { arm: 'baseline', costUsd, baseline };
  if (policy.ceilingUsd !== null && costUsd >= policy.ceilingUsd) return { arm: 'ceiling', costUsd, baseline };
  return null;
}

/**
 * The median settled cost of each rule-and-profile bucket that has enough runs to
 * have one.
 *
 * A bucket below the floor is **absent rather than zero**: the caller has to
 * handle "there is nothing to compare against" explicitly, and a 0 here would
 * make every live run in a young bucket infinitely over its median.
 */
function bucketMedians(
  agents: readonly Agent[],
  taskOf: ReadonlyMap<string, Task>,
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
 * The two axes a run's cost is comparable along, as one key.
 *
 * A run with neither — dispatched outside the pulse, on a deployment with no
 * `agentModels` — buckets with its own kind rather than being skipped: "every
 * unruled run on no profile" is a real population, and a fleet where that is most
 * of them still deserves the watch.
 */
function bucketKey(task: Task | undefined): string {
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
 * Stable across pulses, and deliberately carrying **no figure**.
 *
 * `recordHumanTask` dedups on the title (with the agent, origin and kind), so a
 * title naming the dollars would file a fresh row every turn the run reported —
 * one notice per five minutes, about one agent. The numbers live in the detail,
 * which the same dedup refreshes in place.
 */
function burnTitle(rule: string | null, arm: BurnVerdict['arm']): string {
  const label = ruleLabel(rule);
  return arm === 'ceiling'
    ? `${label} is past the per-run spend ceiling`
    : `${label} is costing far more than that work usually does`;
}

/**
 * The rule's own name from the registry — never a second vocabulary, on
 * `rollUpTaskTypes`' reasoning. An id the registry has lost is rendered as itself
 * rather than folded into the unruled case, so a rule renamed last month is still
 * something an operator can ask about.
 */
function ruleLabel(rule: string | null): string {
  if (rule === null) return 'A run dispatched outside the pulse';
  const known = DISPATCH_RULES[rule as DispatchRuleId] as { name: string } | undefined;
  return known === undefined ? `A ${rule} run` : `A ${known.name.toLowerCase()} run`;
}

/**
 * What it has spent, what that kind of work costs, and what to do — refreshed on
 * every pulse the run is still going, so the figure an operator reads is the one
 * that is true now rather than the one that tripped the watch.
 *
 * It says out loud that nothing is held. A row on the bench that looks like a
 * gate gets answered in a hurry, and this one wants a look at the transcript.
 */
function burnDetail(agent: Agent, task: Task | null, verdict: BurnVerdict, policy: BurnPolicy): string {
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
function describeBucket(task: Task | null): string {
  const rule = task?.rule ? `\`${task.rule}\`` : 'unruled';
  return task?.profile ? `${rule} / \`${task.profile}\`` : rule;
}

/** Dollars as an operator reads them. Null is the unmeasured case and says so rather than printing $0.00. */
function money(usd: number | null): string {
  return usd === null ? 'nothing measurable' : `$${usd.toFixed(2)}`;
}
