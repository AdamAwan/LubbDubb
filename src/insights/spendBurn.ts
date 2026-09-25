import type { Agent, HumanTask, TaskSummary } from '../types.js';
import { DISPATCH_RULES, type DispatchRuleId } from '../dispatcher/rules.js';

// → docs/spec/18-observability.md

export interface BurnPolicy {
  enabled: boolean;
  multiple: number;
  minimumRuns: number;
  floorUsd: number;
  ceilingUsd: number | null;
  floorSteps: number;
  ceilingSteps: number | null;
  floorMinutes: number;
  ceilingMinutes: number | null;
}

export const DEFAULT_BURN: BurnPolicy = {
  enabled: true,
  multiple: 4,
  minimumRuns: 5,
  floorUsd: 1,
  ceilingUsd: null,
  floorSteps: 80,
  ceilingSteps: null,
  floorMinutes: 15,
  ceilingMinutes: 60,
};

type AxisId = 'spend' | 'steps' | 'time';

const AXIS_ORDER: readonly AxisId[] = ['spend', 'steps', 'time'];

interface AxisPolicy {
  floor: number;
  ceiling: number | null;
}

function axisPolicy(policy: BurnPolicy, axis: AxisId): AxisPolicy {
  if (axis === 'spend') return { floor: policy.floorUsd, ceiling: policy.ceilingUsd };
  if (axis === 'steps') return { floor: policy.floorSteps, ceiling: policy.ceilingSteps };
  return { floor: policy.floorMinutes, ceiling: policy.ceilingMinutes };
}

function axisValue(axis: AxisId, agent: Agent, nowMs: number): number | null {
  if (axis === 'spend') return agent.costUsd;
  if (axis === 'steps') return agent.steps;
  return elapsedMinutes(agent, nowMs);
}

function elapsedMinutes(agent: Agent, nowMs: number): number | null {
  const started = Date.parse(agent.startedAt);
  if (Number.isNaN(started)) return null;
  const until = agent.endedAt === null ? nowMs : Date.parse(agent.endedAt);
  if (Number.isNaN(until)) return null;
  const minutes = (until - started) / 60_000;
  return minutes < 0 ? null : minutes;
}

function axisAmount(axis: AxisId, value: number | null): string {
  if (value === null) return 'nothing measurable';
  if (axis === 'spend') return money(value);
  if (axis === 'steps') return `${Math.round(value)} step${Math.round(value) === 1 ? '' : 's'}`;
  const minutes = Math.round(value);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function axisMedian(axis: AxisId, value: number): string {
  if (axis === 'spend') return `${money(value)} median`;
  if (axis === 'steps') return `${Math.round(value)}-step median`;
  return `${Math.round(value)}-minute median`;
}

function axisVerb(axis: AxisId): string {
  if (axis === 'spend') return 'spent';
  if (axis === 'steps') return 'taken';
  return 'been going for';
}

function axisCeilingNoun(axis: AxisId): string {
  if (axis === 'spend') return 'spend';
  if (axis === 'steps') return 'step';
  return 'runtime';
}

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
  validateFloor('floorUsd', policy.floorUsd, 'dollars a run must also have spent');
  validateFloor('floorSteps', policy.floorSteps, 'steps a run must also have taken');
  validateFloor('floorMinutes', policy.floorMinutes, 'minutes a run must also have been going');
  validateCeiling('ceilingUsd', policy.ceilingUsd, 'dollars');
  validateCeiling('ceilingSteps', policy.ceilingSteps, 'steps');
  validateCeiling('ceilingMinutes', policy.ceilingMinutes, 'minutes');
}

function validateFloor(key: string, value: number, what: string): void {
  if (typeof value !== 'number' || value < 0 || !Number.isFinite(value))
    throw new Error(
      `Refusing to start: spendBurn.${key} is ${JSON.stringify(value)}, and must be a non-negative number of ` +
        `${what} before a multiple counts as a runaway.`,
    );
}

function validateCeiling(key: string, value: number | null, unit: string): void {
  if (value !== null && (typeof value !== 'number' || !(value > 0)))
    throw new Error(
      `Refusing to start: spendBurn.${key} is ${JSON.stringify(value)}, and must be a number of ${unit} above 0, ` +
        `or null for no flat ceiling on that axis.`,
    );
}

type BurnStep =
  | { kind: 'file'; agentId: string; originRef: string | null; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string };

interface BurnInput {
  policy: BurnPolicy;
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
  existing: readonly HumanTask[];
  now: string;
  /** The deployment's profiles, cheapest first, so a notice can name the rung above the run's own. */
  profiles?: readonly string[];
}

const LIVE: readonly Agent['status'][] = ['starting', 'running', 'waiting'];

const SETTLED: readonly Agent['status'][] = ['done', 'failed', 'crashed', 'killed', 'interrupted'];

export function burnPass(input: BurnInput): BurnStep[] {
  const nowMs = Date.parse(input.now);
  const taskOf = new Map(input.tasks.map((t) => [t.id, t]));
  const { openByAgent, settledAgents } = indexNotices(input.existing);
  const steps = settleSteps(input.agents, openByAgent, nowMs);
  if (!input.policy.enabled) return steps;
  if (Number.isNaN(nowMs)) return steps;

  const medians = bucketMedians(input.agents, taskOf, input.policy.minimumRuns, nowMs);

  for (const agent of input.agents) {
    if (!LIVE.includes(agent.status)) continue;
    if (settledAgents.has(agent.id)) continue;
    const task = taskOf.get(agent.taskId);
    const verdict = judge(agent, medians.get(bucketKey(task)), input.policy, nowMs);
    if (verdict === null) continue;
    steps.push({
      kind: 'file',
      agentId: agent.id,
      originRef: task?.originRef ?? null,
      title: burnTitle(task?.rule ?? null),
      detail: burnDetail(agent, task ?? null, verdict, input.policy, nowMs, input.profiles ?? []),
    });
  }

  return steps;
}

function indexNotices(existing: readonly HumanTask[]): {
  openByAgent: Map<string, HumanTask>;
  settledAgents: Set<string>;
} {
  const openByAgent = new Map<string, HumanTask>();
  const settledAgents = new Set<string>();
  for (const t of existing) {
    if (t.agentId === null) continue;
    if (t.status === 'open') openByAgent.set(t.agentId, t);
    else settledAgents.add(t.agentId);
  }
  return { openByAgent, settledAgents };
}

function settleSteps(agents: readonly Agent[], openByAgent: ReadonlyMap<string, HumanTask>, nowMs: number): BurnStep[] {
  const steps: BurnStep[] = [];
  for (const agent of agents) {
    if (LIVE.includes(agent.status)) continue;
    const standing = openByAgent.get(agent.id);
    if (!standing) continue;
    steps.push({
      kind: 'settle',
      taskId: standing.id,
      status: 'done',
      resolution: settleResolution(agent, nowMs),
    });
  }
  return steps;
}

interface Baseline {
  median: number;
  runs: number;
}

type Baselines = Map<AxisId, Baseline>;

interface BurnVerdict {
  arm: 'baseline' | 'ceiling';
  axis: AxisId;
  value: number;
  baseline: Baseline | null;
}

/**
 * The tripped axis a notice leads on. The axes are read in a fixed order rather
 * than by how far past each one is: a ratio and a flat ceiling are not on one
 * scale, and the detail carries every axis's figures whichever leads.
 *
 * A parked run is not judged on the clock: it is waiting on a person or on an
 * allowance window, which is already a row of its own, and the hours it spends
 * there are nobody's runaway.
 */
function judge(agent: Agent, baselines: Baselines | undefined, policy: BurnPolicy, nowMs: number): BurnVerdict | null {
  let ceiling: BurnVerdict | null = null;
  for (const axis of AXIS_ORDER) {
    if (axis === 'time' && agent.status === 'waiting') continue;
    const value = axisValue(axis, agent, nowMs);
    if (value === null) continue;
    const { floor, ceiling: cap } = axisPolicy(policy, axis);
    const baseline = baselines?.get(axis) ?? null;
    if (baseline !== null && value >= baseline.median * policy.multiple && value >= floor)
      return { arm: 'baseline', axis, value, baseline };
    if (ceiling === null && cap !== null && value >= cap) ceiling = { arm: 'ceiling', axis, value, baseline };
  }
  return ceiling;
}

function bucketMedians(
  agents: readonly Agent[],
  taskOf: ReadonlyMap<string, TaskSummary>,
  minimumRuns: number,
  nowMs: number,
): Map<string, Baselines> {
  const values = new Map<string, Map<AxisId, number[]>>();
  for (const agent of agents) {
    if (!SETTLED.includes(agent.status)) continue;
    const key = bucketKey(taskOf.get(agent.taskId));
    const byAxis = values.get(key) ?? new Map<AxisId, number[]>();
    for (const axis of AXIS_ORDER) {
      const value = axisValue(axis, agent, nowMs);
      if (value === null) continue;
      const bucket = byAxis.get(axis) ?? [];
      bucket.push(value);
      byAxis.set(axis, bucket);
    }
    values.set(key, byAxis);
  }
  const out = new Map<string, Baselines>();
  for (const [key, byAxis] of values) {
    const baselines: Baselines = new Map();
    for (const [axis, bucket] of byAxis) {
      if (bucket.length < minimumRuns) continue;
      baselines.set(axis, { median: median(bucket), runs: bucket.length });
    }
    if (baselines.size > 0) out.set(key, baselines);
  }
  return out;
}

function bucketKey(task: TaskSummary | undefined): string {
  return `${task?.rule ?? ''}::${task?.profile ?? ''}`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(value * 100) / 100;
}

function burnTitle(rule: string | null): string {
  return `${ruleLabel(rule)} may be running away`;
}

function ruleLabel(rule: string | null): string {
  if (rule === null) return 'A run dispatched outside the pulse';
  const known = DISPATCH_RULES[rule as DispatchRuleId] as { name: string } | undefined;
  return known === undefined ? `A ${rule} run` : `A ${known.name.toLowerCase()} run`;
}

function burnDetail(
  agent: Agent,
  task: TaskSummary | null,
  verdict: BurnVerdict,
  policy: BurnPolicy,
  nowMs: number,
  profiles: readonly string[],
): string {
  const lines: string[] = [];
  const amount = axisAmount(verdict.axis, verdict.value);
  if (verdict.arm === 'baseline' && verdict.baseline) {
    const { median: med, runs } = verdict.baseline;
    const times = med > 0 ? (verdict.value / med).toFixed(1) : '∞';
    lines.push(
      `This run has ${axisVerb(verdict.axis)} **${amount}** so far — **${times}×** the ` +
        `${axisMedian(verdict.axis, med)} of the ${runs} settled ${describeBucket(task)} runs on this deployment.`,
    );
  } else {
    const cap = axisPolicy(policy, verdict.axis).ceiling;
    lines.push(
      `This run has ${axisVerb(verdict.axis)} **${amount}** so far, past the ` +
        `**${axisAmount(verdict.axis, cap)}** per-run ${axisCeilingNoun(verdict.axis)} ceiling. That is a flat ` +
        `limit, not a comparison — nothing here says whether this work is unusual.`,
    );
  }
  const rest = AXIS_ORDER.filter((axis) => axis !== verdict.axis)
    .map((axis) => ({ axis, value: axisValue(axis, agent, nowMs) }))
    .filter((r) => r.value !== null)
    .map((r) => `${axisAmount(r.axis, r.value)}`);
  if (rest.length > 0) lines.push('', `It has also ${rest.join(' and ')} to its name.`);
  if (agent.note) lines.push('', `It last said it was: _${agent.note}_`);
  const deeper = deeperProfile(task?.profile ?? null, profiles);
  if (deeper !== null)
    lines.push(
      '',
      `It is running on the **${task?.profile}** profile, and **${deeper}** sits above it. If it is going in ` +
        `circles rather than working, lifting it there hands this same task to a deeper model, told that the ` +
        `reasoning it is inheriting is known to have failed.`,
    );
  lines.push(
    '',
    `Nothing is held — this is a note, not a gate, and the run carries on either way. Open the agent (\`${agent.id}\`) ` +
      `to read what it is doing, and stop it there if it is going in circles. Marking this done stops it being ` +
      `raised again for this run; it settles itself when the run ends.`,
  );
  return lines.join('\n');
}

/** The rung above the one a run is on, or null where there is none to offer. */
function deeperProfile(profile: string | null, profiles: readonly string[]): string | null {
  if (profile === null) return null;
  const at = profiles.indexOf(profile);
  if (at < 0 || at + 1 >= profiles.length) return null;
  return profiles[at + 1] ?? null;
}

function settleResolution(agent: Agent, nowMs: number): string {
  const spent = agent.costUsd === null ? null : money(agent.costUsd);
  const ran = elapsedMinutes(agent, nowMs);
  const took = ran === null ? null : axisAmount('time', ran);
  const carried = [spent === null ? null : `spent ${spent}`, took === null ? null : `run for ${took}`].filter(
    (p): p is string => p !== null,
  );
  const tail = carried.length === 0 ? 'with nothing measured' : `having ${carried.join(' and ')}`;
  return `the run ended ${agent.status} ${tail}`;
}

function describeBucket(task: TaskSummary | null): string {
  const rule = task?.rule ? `\`${task.rule}\`` : 'unruled';
  return task?.profile ? `${rule} / \`${task.profile}\`` : rule;
}

function money(usd: number | null): string {
  return usd === null ? 'nothing measurable' : `$${usd.toFixed(2)}`;
}
