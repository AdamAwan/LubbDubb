import type { Agent, Job, PullRequest, TaskSummary } from '../types.js';
import type { PrAgent, PrAgentsPayload } from '../wire.js';
import { groupBy, prOriginNumber, standsFor } from '../primitives.js';

// → docs/spec/45-ado-overlay.md#which-pull-request-an-agent-is-on

interface PrAgentsInputs {
  agents: readonly Agent[];
  tasks: readonly Pick<TaskSummary, 'id' | 'title' | 'branch' | 'originRef'>[];
  job: (id: string) => Pick<Job, 'originRef'> | null;
  pullRequests: readonly Pick<PullRequest, 'number' | 'branch'>[];
}

export function prAgents({ agents, tasks, job, pullRequests }: PrAgentsInputs): PrAgentsPayload {
  const byBranch = new Map(pullRequests.map((pr) => [pr.branch, pr.number]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const hits = agents.flatMap((agent) => {
    const t = byId.get(agent.taskId);
    if (t === undefined) return [];
    const number =
      prOriginNumber(standsFor(t.originRef, job)) ?? (t.branch === null ? undefined : byBranch.get(t.branch));
    if (number === undefined) return [];
    const row: PrAgent = { id: agent.id, status: agent.status, title: t.title, waitingReason: agent.waitingReason };
    return [{ number, row }];
  });
  return {
    prs: [...groupBy(hits, (h) => h.number)]
      .map(([number, held]) => ({ number, agents: held.map((h) => h.row) }))
      .sort((a, b) => a.number - b.number),
  };
}
