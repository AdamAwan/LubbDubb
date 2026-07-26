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
import {
  authorityOf,
  mergeProposalRef,
  planProposalHold,
  planProposalRef,
  proposalHold,
  readProposedAct,
  replyProposalRef,
} from '../proposals/proposals.js';
import { releasePlan } from '../plans/planApproval.js';
import type { Action, DecisionOutcome, Proposal, ProposalKind, Task } from '../types.js';

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
      const tally = (outcome: DecisionOutcome): void => {
        if (outcome === 'executed') summary.executed += 1;
        else if (outcome === 'deferred') summary.deferred += 1;
        else if (outcome === 'rejected') summary.rejected += 1;
      };
      const record = (outcome: DecisionOutcome, detail: string): void => {
        store.recordDecision({ cycleId, action: action as unknown as Action, outcome, detail });
        tally(outcome);
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

        case 'reply_on_pr':
        case 'merge_pr': {
          const outbound = await this.authorize(cycleId, action);
          // The authorized path audits itself, under this same cycle id and
          // through the one function that performs an authorized act — so there
          // is nothing left to write, only to count.
          if (outbound.recorded) tally(outbound.outcome);
          else record(outbound.outcome, outbound.detail);
          break;
        }

        case 'propose_plan': {
          // The one proposal with no act to send (issue #109 phase 3). It is
          // born here anyway, with the other two: proposals are created in one
          // place, from a validated action, so "who may put something to a human"
          // has a single answer. The hold is re-asked here for the same reason
          // `authorize` re-asks about a merge — rule 3d suppresses itself, but
          // every path that reaches the executor must be covered, not just the
          // one that happens to check first.
          const ref = planProposalRef(action.originRef);
          const heldBy = planProposalHold(ref, store.listProposals());
          if (heldBy) {
            record('skipped', `Skipped proposing the plan for ${action.originRef}: ${heldBy}.`);
            break;
          }
          const esc = this.deps.escalations.create({
            type: 'approve_change',
            prompt: action.prompt,
            context: { originRef: action.originRef, planId: action.planId },
          });
          const proposal = store.createProposal({
            kind: 'plan',
            ref,
            action: action as unknown as Action,
            escalationId: esc.id,
          });
          record(
            'executed',
            `Proposed the plan for ${action.originRef} for approval: ${esc.id} / ${proposal.id}. ` +
              `Accepting releases its parts; nothing is scheduled until then.`,
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
   * The one place an outbound act is authorized (issue #109 phase 2). Both PR
   * acts the harness can publish — a drafted reply and a merge — come through
   * here, and so do both authorities.
   *
   * Before this, "may this go out?" was answered twice over: a human clicked
   * accept on a `Proposal` and the act ran through {@link runAuthorized}, or the
   * confidence gate said yes and the executor called the sink itself. Two answers
   * to one question, and no code could tell they were the same question — so an
   * auto-merged PR's only record of its authority was a threshold quoted in
   * prose. Auto-send is now a decider on the same record: the proposal is written
   * first, the gate settles it as `auto_send`, and the act runs down the same path
   * a human accept takes. The audit log answers "who authorized this" one way.
   *
   * The order matters and is the point: the **gate is asked after the hold**, so a
   * standing verdict (a pending question, a rejection you made, an act just
   * authorized) governs regardless of which decider would answer next. And a
   * blocked gate is emphatically **not** a `rejected` verdict — a rejection is
   * durable and would suppress the human ask for good. Blocked means "not mine to
   * authorize", which is exactly what a pending proposal says.
   */
  private async authorize(
    cycleId: string,
    action: ValidatedAction & { type: 'reply_on_pr' | 'merge_pr' },
  ): Promise<{ outcome: DecisionOutcome; detail: string; recorded: boolean }> {
    const { store } = this.deps;
    const merge = action.type === 'merge_pr';
    const kind: ProposalKind = merge ? 'merge' : 'reply_draft';
    const ref = merge ? mergeProposalRef(action.prNumber) : replyProposalRef(action.prNumber, action.commentId);
    const subject = merge ? `merge of PR #${action.prNumber}` : `reply on PR #${action.prNumber}`;

    // Rule 3 suppresses itself while a merge proposal stands, so on the default
    // path this is asked once — but it is repeated here because it must hold for
    // *every* path that reaches the executor, the LLM dispatcher's prose-composed
    // `reply_on_pr` included. One predicate, two call sites: the same discipline
    // as the branch gate above.
    const heldBy = proposalHold(kind, ref, store.listProposals());
    if (heldBy) return { outcome: 'skipped', detail: `Skipped ${subject}: ${heldBy}.`, recorded: false };

    // Absent confidence means "no confidence stated" -> treat as 0 -> never auto-send.
    const confidence = action.confidence ?? 0;
    const verdict = autoSendVerdict(this.deps.autoSend, action.type, confidence);

    if (verdict.authorized) {
      const proposal = store.createProposal({
        kind,
        ref,
        action: action as unknown as Action,
        // No inbox item: nothing is being asked of anyone. An escalation appears
        // only if the act then fails, which is the fallback `runAuthorized` owns.
        escalationId: null,
      });
      // The row was created `pending` one statement ago, so this compare-and-set
      // always wins; `?? proposal` is the type narrowing, not a fallback path.
      const accepted = store.decideProposal(proposal.id, 'accepted', verdict.note, 'auto_send') ?? proposal;
      const run = await this.runAuthorized(accepted, cycleId);
      return { ...run, recorded: true };
    }

    // Not the harness's to authorize: draft it and put it to a human as a
    // proposal they can accept (which performs it) or reject.
    const esc = this.deps.escalations.create(
      merge
        ? {
            type: 'approve_change',
            prompt: `PR #${action.prNumber} is green, approved and mergeable. Approve merging it (method: ${action.method})?`,
            context: { prNumber: action.prNumber, method: action.method, confidence },
          }
        : {
            type: 'review_reply',
            prompt: `Draft reply for PR #${action.prNumber}:\n\n${action.draft}`,
            context: { prNumber: action.prNumber, commentId: action.commentId, draft: action.draft, confidence },
          },
    );
    const proposal = store.createProposal({ kind, ref, action: action as unknown as Action, escalationId: esc.id });
    return {
      outcome: 'executed',
      detail: merge
        ? `PR #${action.prNumber} is merge-ready; proposed the merge for approval (${verdict.blockedBy}): ${esc.id} / ${proposal.id}. Accepting merges it.`
        : `Drafted PR reply and proposed it for approval (${verdict.blockedBy}): ${esc.id} / ${proposal.id}. Accepting sends it.`,
      recorded: false,
    };
  }

  /**
   * Perform an act that was authorized (issue #109). Lives here rather than in the
   * route handler for one reason: this is where the harness's outbound acts
   * happen, so the `ActionSink` keeps one caller and the outcome lands in the
   * decision log in the same shape as everything else — with the authority named,
   * which is the half of the audit trail that was missing.
   *
   * Who authorized it, where the row is grouped and how the operator reads it all
   * come from {@link authorityOf}, which is the only thing that branches on the
   * decider. A human accept is recorded outside the pulse as `human:<proposal
   * id>`; auto-send accepted *during* a cycle, so it keeps that cycle's id and
   * stays grouped with the pulse that produced the action.
   *
   * The failure path is one path for both deciders (`autoSendFailed` /
   * `autoMergeFailed` context + a fresh escalation): an authorized act that can't
   * be delivered must not evaporate. The proposal stays `accepted` — it *was*
   * accepted — and once its settle window lapses the gate re-proposes the act if
   * the world still warrants it. That is the recovery, and it needs no new state.
   */
  async runAuthorized(
    proposal: Proposal,
    pulseCycleId?: string,
  ): Promise<{ outcome: DecisionOutcome; detail: string }> {
    const { store } = this.deps;
    const { cycleId, by, approved } = authorityOf(proposal, pulseCycleId ?? null);
    const audit = (outcome: DecisionOutcome, detail: string): { outcome: DecisionOutcome; detail: string } => {
      store.recordDecision({ cycleId, action: proposal.action, outcome, detail });
      return { outcome, detail };
    };

    const read = readProposedAct(proposal);
    if (!read.ok) return audit('rejected', `Cannot run the accepted proposal: ${read.error}.`);
    const act = read.act;
    // A plan act publishes nothing: accepting it releases rule 4a onto the plan's
    // parts. It runs here rather than in the desk so an approved decomposition
    // lands in the decision log in the same shape, under the same authority, as
    // an approved merge — the audit trail is the reason this function exists, and
    // the sink is only what two of its three acts happen to need.
    if (act.kind === 'plan') {
      const settled = releasePlan(store, act.planId, act.originRef);
      return settled.ok
        ? audit('executed', `Approved the plan: ${settled.detail} — authorized by ${by} (${proposal.id}).`)
        : audit('skipped', `Nothing to release for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
    }
    // The verdict's note is the decider's own reason — a human's comment, or the
    // threshold auto-send cleared — so the audit line carries it verbatim rather
    // than re-deriving why the act was allowed.
    const because = proposal.note ? ` (${proposal.note})` : '';

    try {
      if (act.kind === 'merge') {
        const res = await this.deps.sink.mergePr({ prNumber: act.prNumber, method: act.method });
        return audit(
          'executed',
          `Merged PR #${act.prNumber} via ${act.method} — authorized by ${by}${because} (${proposal.id}).${res.ref ? ` ref=${res.ref}` : ''}`,
        );
      }
      const res = await this.deps.sink.postPrReply({
        prNumber: act.prNumber,
        commentId: act.commentId,
        body: act.body,
      });
      return audit(
        'executed',
        `Sent the reply on PR #${act.prNumber} — authorized by ${by}${because} (${proposal.id}).${res.ref ? ` ref=${res.ref}` : ''}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      const esc =
        act.kind === 'merge'
          ? this.deps.escalations.create({
              type: 'approve_change',
              prompt: `${approved} merging PR #${act.prNumber}, but the merge failed (${message}); merge it manually or wait for the harness to re-propose it.`,
              context: { prNumber: act.prNumber, method: act.method, autoMergeFailed: true },
            })
          : this.deps.escalations.create({
              type: 'review_reply',
              prompt: `${approved} this reply, but sending it failed (${message}); send it manually.\n\nDraft reply for PR #${act.prNumber}:\n\n${act.body}`,
              context: {
                prNumber: act.prNumber,
                commentId: act.commentId,
                draft: act.body,
                autoSendFailed: true,
              },
            });
      return audit(
        'rejected',
        `Authorized ${act.kind === 'merge' ? `merge of PR #${act.prNumber}` : `reply on PR #${act.prNumber}`} failed (${message}); escalated so it isn't dropped: ${esc.id}.`,
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
 * The auto-send policy as a verdict on one act: either the harness authorizes it,
 * with the reason that goes on the proposal as the decider's note, or it does not,
 * with the reason the escalation quotes. Both directions come from here so the
 * threshold is stated once and the audit log cannot explain a send and a refusal
 * in two different vocabularies.
 *
 * Note what it does *not* return: a rejection. Only a human can reject, because a
 * rejection is durable and a machine "no" would mean the question is never put to
 * anyone. Everything this refuses becomes a pending proposal.
 */
type AutoSendVerdict = { authorized: true; note: string } | { authorized: false; blockedBy: string };

function autoSendVerdict(gate: AutoSendConfig, actionType: string, confidence: number): AutoSendVerdict {
  if (!gate.enabled) return { authorized: false, blockedBy: 'auto-send disabled' };
  if (!gate.allowedActions.includes(actionType))
    return { authorized: false, blockedBy: `${actionType} not in allowed auto-send actions` };
  if (confidence < gate.confidenceThreshold)
    return {
      authorized: false,
      blockedBy: `confidence ${confidence.toFixed(2)} < ${gate.confidenceThreshold} threshold`,
    };
  return { authorized: true, note: `confidence ${confidence.toFixed(2)} ≥ ${gate.confidenceThreshold} threshold` };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
