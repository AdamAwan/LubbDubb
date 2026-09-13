import type { AgentManager } from '../agents/agentManager.js';
import type { Store } from '../store/store.js';
import type { Ejection, EjectionOutcome } from '../types.js';
import { requeueJobRequest } from '../agents/crashRecovery.js';
import { expired, type EjectionPolicy } from './policy.js';

// → docs/spec/35-ejection.md

type EjectResult = { ok: true; ejection: Ejection } | { ok: false; error: string };

type SettleResult = { ok: true; ejection: Ejection; jobId: string | null } | { ok: false; error: string };

interface EjectionDeskDeps {
  store: Store;
  agents(): AgentManager;
  policy(): EjectionPolicy;
  now(): string;
}

export class EjectionDesk {
  constructor(private readonly deps: EjectionDeskDeps) {}

  eject(agentId: string, reason: string): EjectResult {
    const { store } = this.deps;
    const policy = this.deps.policy();
    if (!policy.enabled) {
      return {
        ok: false,
        error:
          'Ejection is turned off on this deployment (ejection.enabled). Interrupt the agent and answer it, or ' +
          'kill it and let the fleet pick the work up again.',
      };
    }
    const trimmed = reason.trim();
    if (trimmed === '') {
      return {
        ok: false,
        error:
          'reason required — say why you are taking this off the fleet. It is what the session you hand it to ' +
          'reads first, and what everybody else sees on the held slot.',
      };
    }
    const agent = store.agents.getAgent(agentId);
    if (!agent) return { ok: false, error: `No agent "${agentId}".` };
    const task = store.tasks.getTask(agent.taskId);
    if (!task) return { ok: false, error: `Agent ${agentId} has no task recorded, so there is no work to hold.` };
    if (task.originRef === null) {
      return {
        ok: false,
        error:
          'This run has no dispatch origin, so there is nothing for a claim to hold: the fleet was never going ' +
          'to staff it again. Kill it instead — the branch and the transcript are unaffected either way.',
      };
    }
    const standing = store.ejections.liveEjectionForOrigin(task.originRef);
    if (standing) {
      return { ok: false, error: `${task.originRef} is already held by an ejection (${standing.id}).` };
    }

    // No await between the kill and the claim: settling the task is what frees the
    // origin, and a pulse landing in that gap would staff it again.
    if (!this.deps.agents().kill(agentId)) {
      return {
        ok: false,
        error:
          `This agent is "${agent.status}" and holds no live session, so there is nothing to eject. Its branch ` +
          'and transcript are still there; queue a job on them if you want the work.',
      };
    }
    const ejection = store.ejections.recordEjection({
      originRef: task.originRef,
      branch: task.branch,
      worktreePath: agent.cwd,
      agentId: agent.id,
      taskId: task.id,
      sessionId: agent.sessionId,
      reason: trimmed,
    });
    store.decisions.recordDecision({
      cycleId: `eject:${agent.id}`,
      action: {
        type: 'no_op',
        reason: `an operator took ${task.originRef} off the fleet: ${trimmed}`,
      },
      outcome: 'executed',
      detail: `Ejected agent ${agent.id}. Its origin and its worktree ${agent.cwd} are held until the work is handed back.`,
    });
    return { ok: true, ejection };
  }

  settle(id: string, outcome: Exclude<EjectionOutcome, 'expired'>, note: string | null): SettleResult {
    const { store } = this.deps;
    const standing = store.ejections.getEjection(id);
    if (!standing) return { ok: false, error: `No ejection "${id}".` };
    if (standing.settledAt !== null) {
      return {
        ok: false,
        error:
          `That ejection was already settled as "${standing.outcome}" at ${standing.settledAt}. Its goal is back ` +
          'with the fleet and its slot is back in the pool; there is nothing left to hand back.',
      };
    }
    const trimmed = note?.trim() ?? '';
    if (outcome === 'requeued' && trimmed === '') {
      return {
        ok: false,
        error:
          'note required to requeue — it is the preamble the fresh agent reads, and without it the run starts ' +
          'again knowing nothing about what you changed or why.',
      };
    }
    const jobId = outcome === 'requeued' ? this.requeue(standing, trimmed) : null;
    const settled = store.ejections.settleEjection(id, outcome, trimmed === '' ? null : trimmed);
    if (!settled) return { ok: false, error: `Ejection "${id}" was settled by something else.` };
    store.decisions.recordDecision({
      cycleId: `eject:${standing.agentId}`,
      action: { type: 'no_op', reason: `${standing.originRef} was handed back to the fleet as "${outcome}"` },
      outcome: 'executed',
      detail: trimmed === '' ? SETTLE_DETAIL[outcome] : `${SETTLE_DETAIL[outcome]} ${trimmed}`,
    });
    return { ok: true, ejection: settled, jobId };
  }

  /** @public — the pulse reaches this through `HarnessDeps.ejections`. */
  sweepExpiries(): Ejection[] {
    const { store } = this.deps;
    const policy = this.deps.policy();
    const now = this.deps.now();
    const gone: Ejection[] = [];
    for (const standing of store.ejections.liveEjections()) {
      if (!expired(standing.ejectedAt, now, policy)) continue;
      const settled = store.ejections.settleEjection(standing.id, 'expired', null);
      if (!settled) continue;
      gone.push(settled);
      store.decisions.recordDecision({
        cycleId: `eject:${standing.agentId}`,
        action: {
          type: 'no_op',
          reason: `the ejection holding ${standing.originRef} expired after ${policy.expiryHours}h`,
        },
        outcome: 'executed',
        detail:
          `Nobody settled it, so the harness has taken the work back: the goal is eligible again and the ` +
          `worktree ${standing.worktreePath ?? 'slot'} is back in the pool, which means the next dispatch onto ` +
          'another branch may wipe it. The operator ejected it because: ' +
          standing.reason,
      });
    }
    return gone;
  }

  private requeue(standing: Ejection, note: string): string | null {
    const { store } = this.deps;
    const task = store.tasks.getTask(standing.taskId);
    if (!task) return null;
    const request = requeueJobRequest(task, { note: standing.lastNote });
    const job = store.jobs.createJob({
      title: request.title,
      prompt: `${ejectionPreamble(standing, note)}\n\n${request.prompt}`,
      kind: 'code',
      branch: standing.branch,
      originRef: standing.originRef,
    });
    return job.id;
  }
}

function ejectionPreamble(standing: Ejection, note: string): string {
  return [
    `An operator took this work off the fleet at their own keyboard and has now handed it back. They stopped ` +
      `the agent that was on it because: "${standing.reason}"`,
    `What they did while they held it, in their own words: "${note}"`,
    standing.branch
      ? `Their work is on \`${standing.branch}\`, committed or not — read the branch before you change anything, ` +
        'and carry on from what is there rather than starting the part again.'
      : null,
  ]
    .filter((line) => line !== null)
    .join('\n\n');
}

const SETTLE_DETAIL: Record<Exclude<EjectionOutcome, 'expired'>, string> = {
  handed_back:
    'Nothing else was written: the rule that produced the work proposes it again on the next pulse, reading ' +
    'the branch as it now stands.',
  requeued: 'A job carrying the work was filed, standing in for the ejected origin until it runs.',
  delivered:
    'The branch has a pull request, so the work is back in the workflow the fleet already understands and the ' +
    'pull-request rules take the next decision.',
};
