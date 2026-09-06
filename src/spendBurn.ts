import type { Agent, HumanTask, TaskSummary } from './types.js';
import { roundUsd } from './issueSpend.js';
import { DISPATCH_RULES, type DispatchRuleId } from './dispatcher/rules.js';

// → docs/spec/18-observability.md

export interface BurnPolicy {
  enabled: boolean;
  multiple: number;
  minimumRuns: number;
  floorUsd: number;
  ceilingUsd: number | null;
}

export const DEFAULT_BURN: BurnPolicy = {
  enabled: true,
  multiple: 4,
  minimumRuns: 5,
  floorUsd: 1,
  ceilingUsd: null,
};

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

type BurnStep =
  | { kind: 'file'; agentId: string; originRef: string | null; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string };

interface BurnInput {
  policy: BurnPolicy;
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
  existing: readonly HumanTask[];
}

const LIVE: readonly Agent['status'][] = ['starting', 'running', 'waiting'];

const SETTLED: readonly Agent['status'][] = ['done', 'failed', 'crashed', 'killed', 'interrupted'];

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
    if (agent.costUsd === null) continue;
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

interface BurnVerdict {
  arm: 'baseline' | 'ceiling';
  costUsd: number;
  baseline: Baseline | null;
}

interface Baseline {
  medianUsd: number;
  runs: number;
}

function judge(costUsd: number, baseline: Baseline | null, policy: BurnPolicy): BurnVerdict | null {
  if (baseline !== null && costUsd >= baseline.medianUsd * policy.multiple && costUsd >= policy.floorUsd)
    return { arm: 'baseline', costUsd, baseline };
  if (policy.ceilingUsd !== null && costUsd >= policy.ceilingUsd) return { arm: 'ceiling', costUsd, baseline };
  return null;
}

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

function bucketKey(task: TaskSummary | undefined): string {
  return `${task?.rule ?? ''}::${task?.profile ?? ''}`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return roundUsd(value);
}

function burnTitle(rule: string | null, arm: BurnVerdict['arm']): string {
  const label = ruleLabel(rule);
  return arm === 'ceiling'
    ? `${label} is past the per-run spend ceiling`
    : `${label} is costing far more than that work usually does`;
}

function ruleLabel(rule: string | null): string {
  if (rule === null) return 'A run dispatched outside the pulse';
  const known = DISPATCH_RULES[rule as DispatchRuleId] as { name: string } | undefined;
  return known === undefined ? `A ${rule} run` : `A ${known.name.toLowerCase()} run`;
}

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

function describeBucket(task: TaskSummary | null): string {
  const rule = task?.rule ? `\`${task.rule}\`` : 'unruled';
  return task?.profile ? `${rule} / \`${task.profile}\`` : rule;
}

function money(usd: number | null): string {
  return usd === null ? 'nothing measurable' : `$${usd.toFixed(2)}`;
}
