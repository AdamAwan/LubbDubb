import { parseIssueOrigin } from '../issueOrigins.js';
import { standsFor } from '../primitives.js';
import type { Agent, AgentProgress, Job, PrThreadLabel, TaskSummary, WorldSnapshot } from '../types.js';

// → docs/spec/11-mcp-tools.md#progress-the-harness-measures

const ISSUE_WORK_STAGES = ['Reading', 'Making changes', 'PR open'] as const;
const PR_FIX_STAGES = ['Reading', 'Making changes'] as const;

export interface AgentProgressInputs {
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
  jobs: readonly Job[];
  world: WorldSnapshot;
  threadLabels: readonly PrThreadLabel[];
  agentsWithFiles: ReadonlySet<string>;
}

export function agentProgress(inputs: AgentProgressInputs): AgentProgress[] {
  const tasks = new Map(inputs.tasks.map((t) => [t.id, t]));
  const jobs = new Map(inputs.jobs.map((j) => [j.id, j]));
  const out: AgentProgress[] = [];
  for (const agent of inputs.agents) {
    if (agent.endedAt !== null) continue;
    const task = tasks.get(agent.taskId);
    if (task === undefined) continue;
    const origin = standsFor(task.originRef, (id) => jobs.get(id));
    const reading = readingFor(agent, task, origin, inputs);
    if (reading !== null) out.push({ agentId: agent.id, ...reading });
  }
  return out;
}

type Reading = Omit<AgentProgress, 'agentId'>;

function readingFor(
  agent: Agent,
  task: TaskSummary,
  origin: string | null,
  inputs: AgentProgressInputs,
): Reading | null {
  const pr = /^pr:(\d+):(comments|ci|ci-gate|mergeable)$/.exec(origin ?? '');
  if (pr !== null) {
    const prNumber = Number(pr[1]);
    if (pr[2] === 'comments') return threadCount(agent.id, prNumber, inputs);
    return stage(PR_FIX_STAGES, inputs.agentsWithFiles.has(agent.id) ? 2 : 1);
  }
  const family = parseIssueOrigin(origin)?.family;
  if (family !== 'root' && family !== 'part' && family !== 'localValidationFix') return null;
  if (task.kind !== 'code') return null;
  const prOpen =
    task.branch !== null && inputs.world.pullRequests.some((p) => p.branch === task.branch && p.state !== 'closed');
  return stage(ISSUE_WORK_STAGES, prOpen ? 3 : inputs.agentsWithFiles.has(agent.id) ? 2 : 1);
}

function threadCount(agentId: string, prNumber: number, inputs: AgentProgressInputs): Reading | null {
  const answered = new Set(
    inputs.threadLabels.filter((l) => l.agentId === agentId && l.prNumber === prNumber).map((l) => l.threadId),
  );
  const pr = inputs.world.pullRequests.find((p) => p.number === prNumber);
  const waiting = (pr?.unresolvedComments ?? []).filter((c) => !c.handled && !answered.has(c.id)).length;
  const total = answered.size + waiting;
  if (total === 0) return null;
  return { kind: 'count', label: 'comments handled', done: answered.size, total };
}

function stage(stages: readonly string[], at: number): Reading {
  return { kind: 'stage', label: stages[at - 1]!, done: at, total: stages.length };
}
