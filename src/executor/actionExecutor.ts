import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { WorktreeManager } from '../worktree/worktreeManager.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { AutoSendConfig } from '../config.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { ValidatedAction } from '../dispatcher/actions.js';
import type { DispatchResult } from '../dispatcher/dispatcher.js';
import { mergeProposalRef, proposalHold, readProposedAct, replyProposalRef } from '../proposals/proposals.js';
import type { Action, DecisionOutcome, Proposal, Task } from '../types.js';

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
  /**
   * Base a *new* agent branch is cut from. Passed on every `ensure` so the base is
   * explicit config rather than whatever `repoRoot` is checked out on.
   */
  defaultBranch: string;
  /** Live cap + pause flag, read by reference each cycle (never a frozen copy). */
  runtime: RuntimeControl;
}

export interface ExecutionSummary {
  cycleId: string;
  executed: number;
  deferred: number;
  rejected: number;
}

/**
 * Turns a validated action plan into real effects, applying the guard rails the
 * design calls for: never start a second agent for work that's already in flight
 * (origin de-duplication), never put a second agent on a branch a live task holds
 * (the branch half of the same gate — see below), and never exceed the
 * concurrency cap. Every decision — executed, deferred, rejected, or skipped — is
 * written to the audit log with its reason, so "why did/didn't this happen" is
 * always answerable.
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
          // The branch half of the same gate (issue #116). For every world-driven
          // rule origin and branch are 1:1 (`pr:<n>:*`→`pr.branch`,
          // `issue:<n>`→`issue/<n>`, `issue:<n>:plan`→`plan/issue/<n>`,
          // `issue:<n>:part:<slug>`→`issue/<n>/<slug>`, `story:<id>:work`→`story/<id>`),
          // so the origin check above already *is* a branch check and this one is a
          // no-op for them — asserted in test/jobQueue.test.ts, because a later rule
          // that broke the 1:1 property would otherwise break it silently. Two paths
          // can reach here with a branch the origin doesn't determine: rule 0, whose
          // `job.branch` is a free string the operator supplies, and the LLM
          // dispatcher, which names branches in prose. `WorktreeManager.ensure` is
          // reuse-first, so letting either through puts two live claude processes in
          // one worktree directory — the same files on disk, and no merge anywhere to
          // reconcile them.
          //
          // Deferred rather than skipped, deliberately. `skipped` is the origin
          // gate's word and means "this work is already being done"; that is not what
          // happened here — the job is a distinct request that merely names a busy
          // branch. Every active task ends, so the collision is transient and the
          // honest reading is "not yet": the job stays `queued` (nothing calls
          // `markJobDispatched`) and the gate re-tests next cycle, exactly as the
          // cap/pause deferrals below do, for one audit row a cycle. An operator who
          // doesn't want to wait cancels it.
          if (action.type === 'dispatch_code_agent') {
            const held = store.findActiveTaskByBranch(action.branch);
            if (held) {
              record(
                'deferred',
                `Deferred: branch ${action.branch} is held by active task ${held.id}` +
                  `${held.originRef ? ` (${held.originRef})` : ''}; a second agent would share its worktree. Will retry when it frees.`,
              );
              break;
            }
          }
          if (this.deps.runtime.paused) {
            record('deferred', `Deferred: dispatch is paused; will retry when resumed.`);
            break;
          }
          if (liveCount >= this.deps.runtime.cap) {
            record('deferred', `Deferred: concurrency cap ${this.deps.runtime.cap} reached; will retry next cycle.`);
            break;
          }
          try {
            const { task, cwd } = await this.materializeTask(action);
            this.deps.agents.spawn(task, cwd);
            liveCount += 1;
            // An operator-launched job leaves the queue only once its agent is
            // actually running — so a deferred (capped/paused) dispatch keeps it
            // queued for a later cycle.
            if (action.jobId) store.markJobDispatched(action.jobId, task.id);
            // Same rule as a job, for the same reason: a dispatch the cap/pause gate
            // held must leave the part `ready` for a later cycle, not claim it started.
            if (action.type === 'dispatch_code_agent' && action.partId)
              store.markPartDispatched(action.partId, task.id, action.branch);
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

          // Not eligible for auto-send: draft it, and put it to a human as a
          // proposal they can accept (which sends it) or reject.
          const proposalRef = replyProposalRef(action.prNumber, action.commentId);
          const heldBy = proposalHold('reply_draft', proposalRef, store.listProposals());
          if (heldBy) {
            record('skipped', `Reply on PR #${action.prNumber} was already put to you: ${heldBy}.`);
            break;
          }
          const esc = this.deps.escalations.create({
            type: 'review_reply',
            prompt: `Draft reply for PR #${action.prNumber}:\n\n${action.draft}`,
            context: { prNumber: action.prNumber, commentId: action.commentId, draft: action.draft, confidence },
          });
          const proposal = store.createProposal({
            kind: 'reply_draft',
            ref: proposalRef,
            action: action as unknown as Action,
            escalationId: esc.id,
          });
          record(
            'executed',
            `Drafted PR reply and proposed it for approval (${blockedBy}): ${esc.id} / ${proposal.id}. Accepting sends it.`,
          );
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

          // Not eligible for auto-merge: put it to a human as a proposal. Rule 3
          // suppresses itself while that proposal stands, so this is asked once —
          // but the check is repeated here because it must hold for *every* path
          // that reaches the executor, the LLM dispatcher's included. One
          // predicate, two call sites: the same discipline as the branch gate above.
          const proposalRef = mergeProposalRef(action.prNumber);
          const heldBy = proposalHold('merge', proposalRef, store.listProposals());
          if (heldBy) {
            record('skipped', `Merge of PR #${action.prNumber} was already put to you: ${heldBy}.`);
            break;
          }
          const esc = this.deps.escalations.create({
            type: 'approve_change',
            prompt: `PR #${action.prNumber} is green, approved and mergeable. Approve merging it (method: ${action.method})?`,
            context: { prNumber: action.prNumber, method: action.method, confidence },
          });
          const proposal = store.createProposal({
            kind: 'merge',
            ref: proposalRef,
            action: action as unknown as Action,
            escalationId: esc.id,
          });
          record(
            'executed',
            `PR #${action.prNumber} is merge-ready; proposed the merge for approval (${blockedBy}): ${esc.id} / ${proposal.id}. Accepting merges it.`,
          );
          break;
        }

        case 'set_work_item_state': {
          // A mechanical bookkeeping transition (e.g. move a work item to "In
          // Review" once its PR is open), not a publish-to-the-world action — so it
          // runs directly rather than through the auto-send gate. Idempotent, so a
          // repeat before the next snapshot reflects the change is harmless.
          try {
            const res = await this.deps.sink.setWorkItemState({ number: action.number, state: action.state });
            record(
              'executed',
              `Set work item #${action.number} to "${action.state}".${res.ref ? ` ref=${res.ref}` : ''}`,
            );
          } catch (err) {
            record('rejected', `Failed to set work item #${action.number} state: ${(err as Error).message}`);
          }
          break;
        }

        case 'no_op':
          record('executed', `No-op: ${action.reason}`);
          break;
      }
    }

    return summary;
  }

  /**
   * Perform an act a human accepted (issue #109). Lives here rather than in the
   * route handler for one reason: this is where the harness's outbound acts
   * happen, so the `ActionSink` keeps one caller and the outcome lands in the
   * decision log in the same shape as everything else — with the *human* named as
   * the authority, which is the half of the audit trail that was missing.
   *
   * The cycle id is `human:<proposal id>` rather than a cycle's, the way
   * `agent-lifecycle` already marks a decision made outside the pulse.
   *
   * The failure path mirrors the auto-send one exactly (`autoSendFailed` /
   * `autoMergeFailed` context + a fresh escalation) instead of inventing a second
   * one: an accepted act that can't be delivered must not evaporate. The proposal
   * stays `accepted` — the human did accept — and, because a settled proposal no
   * longer holds the gate, the next pulse re-proposes the act if the world still
   * warrants it. That is the recovery, and it needs no new state to express.
   */
  async runAuthorized(proposal: Proposal): Promise<{ ok: boolean; detail: string }> {
    const { store } = this.deps;
    const cycleId = `human:${proposal.id}`;
    const audit = (outcome: DecisionOutcome, detail: string): { ok: boolean; detail: string } => {
      store.recordDecision({ cycleId, action: proposal.action, outcome, detail });
      return { ok: outcome === 'executed', detail };
    };

    const read = readProposedAct(proposal);
    if (!read.ok) return audit('rejected', `Cannot run the accepted proposal: ${read.error}.`);
    const act = read.act;
    // Named in the audit line, because "who authorized this" is the point of the
    // record. Only `human` today; phase 2 gives `auto_send` the same sentence.
    const by = proposal.decidedBy === 'human' ? 'you' : (proposal.decidedBy ?? 'an unrecorded decider');

    try {
      if (act.kind === 'merge') {
        const res = await this.deps.sink.mergePr({ prNumber: act.prNumber, method: act.method });
        return audit(
          'executed',
          `Merged PR #${act.prNumber} via ${act.method} — authorized by ${by} (${proposal.id}).${res.ref ? ` ref=${res.ref}` : ''}`,
        );
      }
      const res = await this.deps.sink.postPrReply({
        prNumber: act.prNumber,
        commentId: act.commentId,
        body: act.body,
      });
      return audit(
        'executed',
        `Sent the reply on PR #${act.prNumber} — authorized by ${by} (${proposal.id}).${res.ref ? ` ref=${res.ref}` : ''}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      const esc =
        act.kind === 'merge'
          ? this.deps.escalations.create({
              type: 'approve_change',
              prompt: `You approved merging PR #${act.prNumber}, but the merge failed (${message}); merge it manually or wait for the harness to re-propose it.`,
              context: { prNumber: act.prNumber, method: act.method, autoMergeFailed: true },
            })
          : this.deps.escalations.create({
              type: 'review_reply',
              prompt: `You approved this reply, but sending it failed (${message}); send it manually.\n\nDraft reply for PR #${act.prNumber}:\n\n${act.body}`,
              context: {
                prNumber: act.prNumber,
                commentId: act.commentId,
                draft: act.body,
                autoSendFailed: true,
              },
            });
      return audit(
        'rejected',
        `Approved ${act.kind === 'merge' ? `merge of PR #${act.prNumber}` : `reply on PR #${act.prNumber}`} failed (${message}); escalated so it isn't dropped: ${esc.id}.`,
      );
    }
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
      // A stacked plan part names the branch it forks from; everything else takes
      // the configured integration branch.
      const cwd = await this.deps.worktrees.ensure(action.branch, action.base ?? this.deps.defaultBranch);
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
