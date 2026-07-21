import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { WorktreeManager } from '../worktree/worktreeManager.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { AutoSendConfig } from '../config.js';
import type { ValidatedAction } from '../dispatcher/actions.js';
import type { DispatchResult } from '../dispatcher/dispatcher.js';
import type { Action, DecisionOutcome, Task } from '../types.js';

export interface ExecutorDeps {
  store: Store;
  agents: AgentManager;
  worktrees: WorktreeManager;
  escalations: EscalationInbox;
  /** Outbound seam for side-effectful actions the harness may auto-send. */
  sink: ActionSink;
  /** Confidence-gated auto-send policy. */
  autoSend: AutoSendConfig;
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
            record(
              'deferred',
              `Deferred: concurrency cap ${this.deps.maxConcurrentAgents} reached; will retry next cycle.`,
            );
            break;
          }
          try {
            const { task, cwd } = await this.materializeTask(action);
            this.deps.agents.spawn(task, cwd);
            liveCount += 1;
            record(
              'executed',
              `Spawned ${action.type === 'dispatch_code_agent' ? 'code' : 'desk'} agent for task ${task.id} in ${cwd}.`,
            );
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
          record(
            ok ? 'executed' : 'skipped',
            ok ? `Typed response into agent ${action.agentId}.` : `Agent ${action.agentId} not live; nothing typed.`,
          );
          break;
        }

        case 'reply_on_pr': {
          // Absent confidence means "no confidence stated" -> treat as 0 -> never auto-send.
          const confidence = action.confidence ?? 0;
          const gate = this.deps.autoSend;
          const blockedBy = autoSendBlockedBy(gate, 'reply_on_pr', confidence);

          if (!blockedBy) {
            // Confident enough and enabled: actually send it through the sink.
            try {
              const res = await this.deps.sink.postPrReply({
                prNumber: action.prNumber,
                commentId: action.commentId,
                body: action.draft,
              });
              record(
                'executed',
                `Auto-sent reply on PR #${action.prNumber} (confidence ${confidence.toFixed(2)} ≥ ${gate.confidenceThreshold} threshold).${res.ref ? ` ref=${res.ref}` : ''}`,
              );
            } catch (err) {
              // Send failed — never drop the reply; fall back to draft + escalate.
              const esc = this.deps.escalations.create({
                type: 'review_reply',
                prompt: `Auto-send failed (${(err as Error).message}); review and send manually.\n\nDraft reply for PR #${action.prNumber}:\n\n${action.draft}`,
                context: {
                  prNumber: action.prNumber,
                  commentId: action.commentId,
                  draft: action.draft,
                  confidence,
                  autoSendFailed: true,
                },
              });
              record(
                'executed',
                `Auto-send to PR #${action.prNumber} failed (${(err as Error).message}); drafted and escalated for approval: ${esc.id}.`,
              );
            }
            break;
          }

          // Not eligible for auto-send: draft, then escalate for sign-off (v1 default).
          const esc = this.deps.escalations.create({
            type: 'review_reply',
            prompt: `Draft reply for PR #${action.prNumber}:\n\n${action.draft}`,
            context: { prNumber: action.prNumber, commentId: action.commentId, draft: action.draft, confidence },
          });
          record('executed', `Drafted PR reply and escalated for approval (${blockedBy}): ${esc.id}.`);
          break;
        }

        case 'merge_pr': {
          // Merging is side-effectful, so it runs through the same auto-send gate
          // as reply_on_pr: send only when enabled, allow-listed, and confident;
          // otherwise escalate for a human to approve the merge.
          const confidence = action.confidence ?? 0;
          const gate = this.deps.autoSend;
          const blockedBy = autoSendBlockedBy(gate, 'merge_pr', confidence);

          if (!blockedBy) {
            try {
              const res = await this.deps.sink.mergePr({ prNumber: action.prNumber, method: action.method });
              record(
                'executed',
                `Auto-merged PR #${action.prNumber} via ${action.method} (confidence ${confidence.toFixed(2)} ≥ ${gate.confidenceThreshold} threshold).${res.ref ? ` ref=${res.ref}` : ''}`,
              );
            } catch (err) {
              // Merge failed — surface it for a human rather than silently dropping it.
              const esc = this.deps.escalations.create({
                type: 'approve_change',
                prompt: `Auto-merge failed (${(err as Error).message}); review and merge PR #${action.prNumber} manually.`,
                context: { prNumber: action.prNumber, method: action.method, confidence, autoMergeFailed: true },
              });
              record(
                'executed',
                `Auto-merge of PR #${action.prNumber} failed (${(err as Error).message}); escalated for approval: ${esc.id}.`,
              );
            }
            break;
          }

          // Not eligible for auto-merge: escalate for explicit human sign-off (v1 default).
          const esc = this.deps.escalations.create({
            type: 'approve_change',
            prompt: `PR #${action.prNumber} is green, approved and mergeable. Approve merging it (method: ${action.method})?`,
            context: { prNumber: action.prNumber, method: action.method, confidence },
          });
          record(
            'executed',
            `PR #${action.prNumber} is merge-ready; escalated for merge approval (${blockedBy}): ${esc.id}.`,
          );
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
  private async materializeTask(
    action: ValidatedAction & { type: 'dispatch_code_agent' | 'dispatch_desk_agent' },
  ): Promise<{ task: Task; cwd: string }> {
    const { store } = this.deps;
    if (action.type === 'dispatch_code_agent') {
      const task = store.createTask({
        kind: 'code',
        title: action.title,
        prompt: action.prompt,
        branch: action.branch,
        originRef: action.originRef,
        originTitle: action.originTitle,
        originSummary: action.originSummary,
        dispatchReason: action.reason,
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
      originTitle: action.originTitle,
      originSummary: action.originSummary,
      dispatchReason: action.reason,
    });
    const cwd = resolve(this.deps.deskRoot, task.id);
    mkdirSync(cwd, { recursive: true });
    return { task, cwd };
  }
}

/**
 * Why an action may NOT be auto-sent, as a human-readable reason for the audit
 * log — or `null` if it's clear to send. Centralises the gate so the reason the
 * harness escalated is always explicit and consistent.
 */
function autoSendBlockedBy(gate: AutoSendConfig, actionType: string, confidence: number): string | null {
  if (!gate.enabled) return 'auto-send disabled';
  if (!gate.allowedActions.includes(actionType)) return `${actionType} not in allowed auto-send actions`;
  if (confidence < gate.confidenceThreshold)
    return `confidence ${confidence.toFixed(2)} < ${gate.confidenceThreshold} threshold`;
  return null;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
