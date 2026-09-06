import { issueConclusionOrigin } from '../issueConclusion.js';
import { originIssueNumber } from '../plans/planning.js';
import type { Store } from '../store/store.js';
import type { Agent } from '../types.js';

// → docs/spec/22-pets.md

export interface RunClearOut {
  agents: number;
  jobs: number;
  instructions: number;
}

const LIVE: Agent['status'][] = ['starting', 'running', 'waiting'];

export function clearGoalWork(
  store: Store,
  agents: { kill(agentId: string): boolean },
  issueNumber: number,
): RunClearOut {
  let killed = 0;
  for (const agent of store.listAgentsByStatus(...LIVE)) {
    const task = store.getTask(agent.taskId);
    if (originIssueNumber(task?.originRef ?? null) !== issueNumber) continue;
    if (agents.kill(agent.id)) killed += 1;
  }
  let cancelled = 0;
  for (const job of store.listQueuedJobs()) {
    if (originIssueNumber(job.originRef) !== issueNumber) continue;
    if (store.cancelJob(job.id)) cancelled += 1;
  }
  const instructions = store.settleInstructions(issueConclusionOrigin(issueNumber));
  return { agents: killed, jobs: cancelled, instructions };
}
