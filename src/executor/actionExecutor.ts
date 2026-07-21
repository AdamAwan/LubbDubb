import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { WorktreeManager } from '../worktree/worktreeManager.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ValidatedAction } from '../dispatcher/actions.js';
import type { DispatchResult } from '../dispatcher/dispatcher.js';
import type { Action, DecisionOutcome, Task } from '../types.js';

export interface ExecutorDeps {
  store: Store;
  agents: AgentManager;
  worktrees: WorktreeManager;
  escalations: EscalationInbox;
  deskRoot: string;
  maxConcurrentAgents: number;
}

export interface ExecutionSummary {
  cycleId: string;
  executed: number;
  deferred: number;
  rejected: number;
}

/**
 * Turns a validated action plan into real effects, applying the two guard rails
 * the design calls for: never start a second agent for work that's already in
 * flight (origin de-duplication), and never exceed the concurrency cap. Every
 * decision — executed, deferred, rejected, or skipped — is written to the audit
 * log with its reason, so "why did/didn't this happen" is always answerable.
 */
export class ActionExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(cycleId: string, plan: DispatchResult): Promise<ExecutionSummary> {
    const { store } = this.deps;
    const summary: ExecutionSummary = { cycleId, executed: 0, deferred: 0, rejected: 0 };

    // Malformed items the dispatcher produced are audited, never run.
    for (const bad of plan.rejected) {
      store.recordDecision({
        cycleId,
        action: { type: 'no_op', reason: 'rejected malformed action' } as Action,
        outcome: 'rejected',
        detail: `Rejected: ${bad.error} — raw: ${safeJson(bad.raw)}`,
      });
      summary.rejected += 1;
    }

    let liveCount = store.countLiveAgents();

    for (const action of plan.actions) {
      const record = (outcome: DecisionOutcome, detail: string): void => {
        store.recordDecision({ cycleId, action: action as unknown as Action, outcome, detail });
        if (outcome === 'executed') summary.executed += 1;
        else if (outcome === 'deferred') summary.deferred += 1;
        else if (outcome === 'rejected') summary.rejected += 1;
      };

      switch (action.type) {
        case 'dispatch_code_agent':
        case 'dispatch_desk_agent': {
          const origin = action.originRef;
          if (origin && store.findActiveTaskByOrigin(origin)) {
            record('skipped', `Skipped: work for ${origin} is already in flight.`);
            break;
          }
          if (liveCount >= this.deps.maxConcurrentAgents) {
            record('deferred', `Deferred: concurrency cap ${this.deps.maxConcurrentAgents} reached; will retry next cycle.`);
            break;
          }
          try {
            const { task, cwd } = await this.materializeTask(action);
            this.deps.agents.spawn(task, cwd);
            liveCount += 1;
            record('executed', `Spawned ${action.type === 'dispatch_code_agent' ? 'code' : 'desk'} agent for task ${task.id} in ${cwd}.`);
          } catch (err) {
            record('rejected', `Failed to start agent: ${(err as Error).message}`);
          }
          break;
        }

        case 'escalate_to_human': {
          const esc = this.deps.escalations.create({
            type: action.escalationType,
            prompt: action.prompt,
            context: action.context,
            taskId: action.taskId,
            agentId: action.agentId,
          });
          record('executed', `Escalated to human: ${esc.id} (${action.escalationType}).`);
          break;
        }

        case 'respond_to_agent': {
          const ok = this.deps.agents.respond(action.agentId, action.response);
          record(ok ? 'executed' : 'skipped', ok ? `Typed response into agent ${action.agentId}.` : `Agent ${action.agentId} not live; nothing typed.`);
          break;
        }

        case 'reply_on_pr': {
          // v1 safety: never post to a PR autonomously. Draft, then escalate for sign-off.
          const esc = this.deps.escalations.create({
            type: 'review_reply',
            prompt: `Draft reply for PR #${action.prNumber}:\n\n${action.draft}`,
            context: { prNumber: action.prNumber, commentId: action.commentId, draft: action.draft },
          });
          record('executed', `Drafted PR reply and escalated for approval: ${esc.id}.`);
          break;
        }

        case 'no_op':
          record('executed', `No-op: ${action.reason}`);
          break;
      }
    }

    return summary;
  }

  /** Create the task row and its working directory (worktree for code, scratch for desk). */
  private async materializeTask(action: ValidatedAction & { type: 'dispatch_code_agent' | 'dispatch_desk_agent' }): Promise<{ task: Task; cwd: string }> {
    const { store } = this.deps;
    if (action.type === 'dispatch_code_agent') {
      const task = store.createTask({
        kind: 'code',
        title: action.title,
        prompt: action.prompt,
        branch: action.branch,
        originRef: action.originRef,
      });
      const cwd = await this.deps.worktrees.ensure(action.branch);
      return { task, cwd };
    }
    const task = store.createTask({
      kind: 'desk',
      title: action.title,
      prompt: action.prompt,
      branch: null,
      originRef: action.originRef,
    });
    const cwd = resolve(this.deps.deskRoot, task.id);
    mkdirSync(cwd, { recursive: true });
    return { task, cwd };
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
