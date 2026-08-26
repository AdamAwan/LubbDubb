import { issueConclusionOrigin } from '../issueConclusion.js';
import { originIssueNumber } from '../plans/planning.js';
import type { Store } from '../store/store.js';
import type { Agent } from '../types.js';

/**
 * What ending a run cleared out of the way behind it — the counts the route hands
 * back so the cockpit can report the destruction it just did rather than a bare
 * `ok`.
 */
export interface RunClearOut {
  /** Live agents on the goal that were killed. */
  agents: number;
  /** Queued jobs standing in for the goal's work that were cancelled. */
  jobs: number;
  /** Standing operator instructions on the goal that were settled unread. */
  instructions: number;
}

/** The three statuses that mean an agent is still going. Mirrors `countLiveAgents`. */
const LIVE: Agent['status'][] = ['starting', 'running', 'waiting'];

/**
 * Stop everything the harness still has in flight on a goal — the other half of
 * ending its run.
 *
 * Dismissing the run stops the *dispatcher*, which is a statement about what will
 * be started next and says nothing about what is already running: an agent
 * mid-turn keeps working, a queued job takes the next free slot, and a standing
 * instruction waits to be handed to whoever picks the goal up. So the goal the
 * operator just ended the run at goes on producing commits, costing money and
 * writing verdicts, from a run the cockpit has already drawn as over. That gap is
 * the reason this exists, and it is why "End the run" is a destructive act that
 * asks first rather than a card being cleared away.
 *
 * **Scoped exactly as the goal page scopes it** — the `issue:<n>` subtree, so a
 * planner, a part and an appraisal all go, and a `pr:` agent does not. The page's own
 * agent count reads the same subtree, which is what lets the confirmation state a
 * number the operator can already see on the header.
 *
 * Killing rather than completing: `kill` records the abandonment (task
 * `interrupted`, the worktree kept for the reap), which is what actually happened.
 * `complete` would stamp a clean `done` on work nobody read.
 *
 * Instructions are **settled, not deleted** — the append-only record of what the
 * operator asked for survives, and only its standing-ness ends. Nothing here is
 * undone by an un-dismissal, because there is no un-dismissal: the run is ended
 * one way, and a goal worked again is worked afresh.
 */
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
    // A job's *own* origin is `job:<id>`; `originRef` is the work it stands in for,
    // which is the only field that can say it belongs to this goal.
    if (originIssueNumber(job.originRef) !== issueNumber) continue;
    if (store.cancelJob(job.id)) cancelled += 1;
  }
  const instructions = store.settleInstructions(issueConclusionOrigin(issueNumber));
  return { agents: killed, jobs: cancelled, instructions };
}
