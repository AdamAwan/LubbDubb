import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { StackLandingDesk } from '../stacks/landingDesk.js';
import type { ActionSink } from '../sink/actionSink.js';
import { resolveAgentProfile, type AgentModels } from '../agents/modelPolicy.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { ValidatedAction } from '../dispatcher/actions.js';
import type { ReadyingBoard } from './readying.js';
import type { DispatchResult } from '../dispatcher/dispatcher.js';
import {
  authorityOf,
  mergeProposalRef,
  planAmendmentHold,
  planAmendmentProposalRef,
  planProposalHold,
  planProposalRef,
  proposalHold,
  reaskContext,
  readProposedAct,
  rejectionGuidance,
  rejectionSignalQuery,
  replyProposalRef,
} from '../proposals/proposals.js';
import { actOnShortfall, releasePlan } from '../plans/planApproval.js';
import { amendmentWarnings, applyPlanAmendment, describeAmendment } from '../plans/planAmendment.js';
import { proposedPlanDiff } from '../plans/planDiff.js';
import { planNarrative, planPartInputs, validatePlanDocument } from '../plans/planDocument.js';
import { shortfallRef } from '../delivery/shortfall.js';
import { outstandingWorkNote } from '../mcp/conclusion.js';
import { operatorInstructionsNote } from '../goalInstructions.js';
import { attachmentsNote } from '../jobs/attachments.js';
import { reviewOrigin } from '../review/prReview.js';
import { retroSubmitOrigin } from '../retro/retro.js';
import { retroDossier, retroPad } from '../retro/dossier.js';
import { goalRecord } from '../retro/record.js';
import { featureSummarySubmitOrigin } from '../summaries/featureSummary.js';
import { featureRecords, featureReach, renderFeatureDossier } from '../summaries/featureRecord.js';
import { sequenceBriefing } from '../sequence/dossier.js';
import { featureSequenceSubmitOrigin } from '../sequence/sequence.js';
import { neighbourSeedPaths, priorWorkBriefing } from '../briefing/priorWork.js';
import { deliveredWorkBriefing } from '../briefing/delivered.js';
import { assessIssueNumber } from '../delivery/assessment.js';
import { issueForPr } from '../prIssue.js';
import { liveParts } from '../plans/parts.js';
import { ciEvidenceNote, type CiEvidenceReader, type CiEvidenceTarget } from '../ci/ciEvidence.js';
import { goalOriginFor, WITNESS_INSTRUCTION } from '../scratch/pad.js';
import { dispatchFactScopes } from '../knowledge/block.js';
import { corroborationGoal } from '../knowledge/knowledge.js';
import { obstaclesForDispatch, renderObstacleNote } from '../obstacles/delivery.js';
import { retryNote, retryResumeFor, type RetryResume } from './retryResume.js';
import { isActiveTask } from '../tasks.js';
import type {
  Action,
  DecisionOutcome,
  FeatureSequence,
  PlanAmendment,
  Proposal,
  ProposalKind,
  PullRequest,
  Task,
  WorldEvent,
} from '../types.js';
import type { FeatureBoardFacts } from '../summaries/featureRecord.js';

// → docs/spec/09-execution.md

interface ExecutorDeps {
  store: Store;
  agents: AgentManager;
  worktrees: Worktrees;
  escalations: EscalationInbox;
  readying: ReadyingBoard;
  landings: StackLandingDesk;
  sink: ActionSink;
  autoSendReplies?: () => boolean;
  agentModels?: AgentModels;
  deskRoot: string;
  defaultBranch: string;
  runtime: RuntimeControl;
  errors: ErrorRecorder;
  ciEvidence?: CiEvidenceReader;
  instructionTracker?: (issueNumber: number) => string | null;
  featureBoard?: FeatureBoardFacts;
}

export interface ExecutionSummary {
  cycleId: string;
  executed: number;
  deferred: number;
  rejected: number;
}

export class ActionExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(cycleId: string, plan: DispatchResult): Promise<ExecutionSummary> {
    const { store } = this.deps;
    const summary: ExecutionSummary = { cycleId, executed: 0, deferred: 0, rejected: 0 };

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

      const hold = this.deps.readying.pickUp({
        cycleId,
        title: readyingTitle(action),
        originRef: 'originRef' in action ? action.originRef : null,
        branch: action.type === 'dispatch_code_agent' ? action.branch : null,
      });
      try {
        switch (action.type) {
          case 'dispatch_code_agent':
          case 'dispatch_desk_agent': {
            const origin = action.originRef;
            if (origin && (store.findActiveTaskByOrigin(origin) || store.findStandingJobByOrigin(origin))) {
              record('skipped', `Skipped: work for ${origin} is already in flight.`);
              break;
            }
            if (origin && store.liveEjectionForOrigin(origin)) {
              record('skipped', `Skipped: an operator holds ${origin} at their own keyboard.`);
              break;
            }
            if (action.type === 'dispatch_code_agent') {
              const ejected = store.ejectionOnBranch(action.branch);
              if (ejected) {
                record(
                  'deferred',
                  `Deferred: branch ${action.branch} is held by an ejection (${ejected.id}); an operator has its ` +
                    'worktree at their own keyboard. Will retry when they hand it back.',
                );
                break;
              }
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
            let task: Task | null = null;
            try {
              hold.at('ci-evidence');
              const evidence = action.type === 'dispatch_code_agent' ? await this.ciEvidenceFor(action) : '';
              const retry = retryResumeFor(origin, store);
              task = this.recordDispatchTask(action, evidence, retry);
              hold.at('slot-handover');
              const cwd =
                retry && action.type === 'dispatch_desk_agent'
                  ? retry.previous.cwd
                  : await this.workingDirectory(task, action);
              const inherit = retry && retry.previous.cwd === cwd ? retry.previous.sessionId : null;
              const agent = this.deps.agents.spawn(task, cwd, inherit);
              const resumed = inherit !== null && agent.sessionId === inherit;
              liveCount += 1;
              if (action.jobId) store.markJobDispatched(action.jobId, task.id);
              if (action.type === 'dispatch_code_agent' && action.partId)
                store.markPartDispatched(action.partId, task.id, action.branch);
              if (action.type === 'dispatch_code_agent' && action.localValidation) {
                if (action.localValidation.as === 'fix')
                  store.markLocalValidationFix(action.localValidation.id, task.id);
                else store.markLocalValidationDispatched(action.localValidation.id, task.id);
              }
              const kind = action.type === 'dispatch_code_agent' ? 'code' : 'desk';
              record(
                'executed',
                resumed
                  ? `Resumed the previous agent's conversation for a ${kind} agent on task ${task.id} in ${cwd}.`
                  : `Spawned ${kind} agent for task ${task.id} in ${cwd}.`,
              );
            } catch (err) {
              if (task) this.abandonUnstarted(task);
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
            hold.at('authorizing');
            const outbound = await this.authorize(cycleId, action);
            if (outbound.recorded) tally(outbound.outcome);
            else record(outbound.outcome, outbound.detail);
            break;
          }

          case 'propose_plan': {
            const ref = planProposalRef(action.originRef);
            const heldBy = planProposalHold(ref, store.listProposals());
            if (heldBy) {
              record('skipped', `Skipped proposing the plan for ${action.originRef}: ${heldBy}.`);
              break;
            }
            const esc = this.deps.escalations.create({
              type: 'approve_change',
              prompt: action.prompt,
              context: {
                originRef: action.originRef,
                planId: action.planId,
                ...(action.detail ? { detail: action.detail, detailFrom: 'What the plan says' } : {}),
              },
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

          case 'propose_plan_amendment': {
            const ref = planAmendmentProposalRef(action.amendmentId);
            const heldBy = planAmendmentHold(ref, store.listProposals());
            if (heldBy) {
              record('skipped', `Skipped proposing the amendment to the plan for ${action.originRef}: ${heldBy}.`);
              break;
            }
            const amendment = store.getPlanAmendment(action.amendmentId);
            if (!amendment || amendment.status !== 'pending') {
              record(
                'skipped',
                `Skipped proposing the amendment to the plan for ${action.originRef}: it is ` +
                  `${amendment ? `"${amendment.status}"` : 'gone'}.`,
              );
              break;
            }
            const esc = this.deps.escalations.create({
              type: 'approve_change',
              prompt: action.prompt,
              context: {
                originRef: action.originRef,
                planId: action.planId,
                amendmentId: amendment.id,
                detail: describeAmendmentFor(store, amendment),
                detailFrom: 'What the amendment changes',
              },
            });
            const proposal = store.createProposal({
              kind: 'plan_amendment',
              ref,
              action: action as unknown as Action,
              escalationId: esc.id,
            });
            record(
              'executed',
              `Proposed a change to the running plan for ${action.originRef} for approval: ${esc.id} / ` +
                `${proposal.id}. The plan keeps scheduling either way; accepting amends it in place.`,
            );
            break;
          }

          case 'propose_shortfall': {
            const ref = shortfallRef(action.issueNumber);
            const proposals = store.listProposals();
            const signals = this.rejectionSignals(proposals);
            const heldBy = proposalHold('shortfall', ref, proposals, { rejectionSignals: signals });
            if (heldBy) {
              record('skipped', `Skipped proposing a response to the assessment of ${action.originRef}: ${heldBy}.`);
              break;
            }
            const again = reaskContext('shortfall', ref, proposals, { rejectionSignals: signals });
            const esc = this.deps.escalations.create({
              type: 'approve_change',
              prompt: again ? `${again}\n\n${action.prompt}` : action.prompt,
              context: {
                originRef: action.originRef,
                issueNumber: action.issueNumber,
                planId: action.planId,
                detail: action.detail,
                detailFrom: 'What the assessor found',
              },
            });
            const proposal = store.createProposal({
              kind: 'shortfall',
              ref,
              action: action as unknown as Action,
              escalationId: esc.id,
            });
            record(
              'executed',
              `Proposed a response to the failed assessment of ${action.originRef}: ${esc.id} / ${proposal.id}. ` +
                `Accepting ${action.cause === 'plan' ? 'sends the plan back to a planner' : `appends a follow-up part for "${action.partSlug}"`}; nothing happens until then.`,
            );
            break;
          }

          case 'update_pr_branch': {
            const ejected = store.ejectionOnBranch(action.branch);
            if (ejected) {
              record(
                'deferred',
                `Deferred: branch ${action.branch} is held by an ejection (${ejected.id}); merging ` +
                  `${action.base} in under an operator's own checkout would move it beneath them. ` +
                  'Will retry when they hand it back.',
              );
              break;
            }
            const staffed = store.findActiveTaskByBranch(action.branch);
            if (staffed) {
              record(
                'deferred',
                `Deferred: branch ${action.branch} is held by active task ${staffed.id}; ` +
                  `merging ${action.base} in under it would move the commit its worktree was cut from. ` +
                  `Will retry when it frees.`,
              );
              break;
            }
            try {
              const res = await this.deps.sink.updatePrBranch({ prNumber: action.prNumber, base: action.base });
              if (!res.ok) {
                record(
                  'skipped',
                  `This provider cannot merge ${action.base} into PR #${action.prNumber} itself; ` +
                    `a code agent will be dispatched to do it.`,
                );
                break;
              }
              record(
                'executed',
                `Brought PR #${action.prNumber} up to date with ${action.base} — no agent spent.${res.ref ? ` ref=${res.ref}` : ''}`,
              );
            } catch (err) {
              const message = (err as Error).message;
              this.deps.errors.record({
                source: 'provider',
                message: `Updating PR #${action.prNumber} from ${action.base} failed: ${message}`,
                detail: 'Rule pr-base-update will dispatch a code agent to merge the base in instead.',
              });
              record(
                'rejected',
                `Failed to merge ${action.base} into PR #${action.prNumber}: ${message}. ` +
                  `A code agent will be dispatched to do it.`,
              );
            }
            break;
          }

          case 'requeue_ci_check': {
            const unperformed: string[] = [];
            try {
              for (const check of action.checks) {
                const res = await this.deps.sink.requeueCiCheck({
                  prNumber: action.prNumber,
                  check: check.name,
                  requeueRef: check.requeueRef,
                });
                if (!res.ok) unperformed.push(check.name);
              }
            } catch (err) {
              const message = (err as Error).message;
              this.deps.errors.record({
                source: 'provider',
                message: `Requeueing the expired check(s) on PR #${action.prNumber} failed: ${message}`,
                detail: 'Rule pr-ci-gate will dispatch a code agent to queue the build instead.',
              });
              record(
                'rejected',
                `Failed to requeue the expired check(s) on PR #${action.prNumber}: ${message}. ` +
                  `A code agent will be dispatched to queue the build.`,
              );
              break;
            }
            if (unperformed.length > 0) {
              record(
                'skipped',
                `This provider did not requeue ${unperformed.join(', ')} on PR #${action.prNumber}; ` +
                  `a code agent will be dispatched to queue the build.`,
              );
              break;
            }
            record(
              'executed',
              `Queued a fresh run of ${action.checks.map((c) => c.name).join(', ')} on PR #${action.prNumber} — no agent spent.`,
            );
            break;
          }

          case 'set_work_item_state': {
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
      } finally {
        hold.release();
      }
    }

    return summary;
  }

  private async authorize(
    cycleId: string,
    action: ValidatedAction & { type: 'reply_on_pr' | 'merge_pr' },
  ): Promise<{ outcome: DecisionOutcome; detail: string; recorded: boolean }> {
    const { store } = this.deps;
    const merge = action.type === 'merge_pr';
    const kind: ProposalKind = merge ? 'merge' : 'reply_draft';
    const ref = merge ? mergeProposalRef(action.prNumber) : replyProposalRef(action.prNumber, action.commentId);
    const subject = merge ? `merge of PR #${action.prNumber}` : `reply on PR #${action.prNumber}`;

    const proposals = store.listProposals();
    const signals = this.rejectionSignals(proposals);
    const heldBy = proposalHold(kind, ref, proposals, { rejectionSignals: signals });
    if (heldBy) return { outcome: 'skipped', detail: `Skipped ${subject}: ${heldBy}.`, recorded: false };

    const landing = merge ? store.standingLandingForPr(action.prNumber) : null;

    const autoSend = !merge && (this.deps.autoSendReplies?.() ?? false);

    if (landing || autoSend) {
      const proposal = store.createProposal({
        kind,
        ref,
        action: action as unknown as Action,
        escalationId: null,
      });
      const note = landing
        ? `you authorized landing ${landing.ref} (${landing.rungs.length} pull requests) on ${landing.createdAt}`
        : 'you set "sendPrRepliesWithoutApproval", which sends a drafted reply without asking';
      const accepted =
        store.decideProposal(proposal.id, 'accepted', note, landing ? 'stack_landing' : 'auto_send') ?? proposal;
      const run = await this.runAuthorized(accepted, cycleId);
      return { ...run, recorded: true };
    }

    const again = reaskContext(kind, ref, proposals, { rejectionSignals: signals });
    const preamble = again ? `${again}\n\n` : '';
    const esc = this.deps.escalations.create(
      merge
        ? {
            type: 'approve_change',
            prompt: `${preamble}PR #${action.prNumber} is green, approved and mergeable. Approve merging it (method: ${action.method})?`,
            context: { prNumber: action.prNumber, method: action.method },
          }
        : {
            type: 'review_reply',
            prompt: `${preamble}Draft reply for PR #${action.prNumber}:\n\n${action.draft}`,
            context: { prNumber: action.prNumber, commentId: action.commentId, draft: action.draft },
          },
    );
    const proposal = store.createProposal({ kind, ref, action: action as unknown as Action, escalationId: esc.id });
    return {
      outcome: 'executed',
      detail: merge
        ? `PR #${action.prNumber} is merge-ready; proposed the merge for approval: ${esc.id} / ${proposal.id}. Accepting merges it.`
        : `Drafted PR reply and proposed it for approval: ${esc.id} / ${proposal.id}. Accepting sends it.`,
      recorded: false,
    };
  }

  /**
   * Raise a review reply an agent handed to the harness, from outside the pulse.
   *
   * **The tool does not send anything.** `reply_to_review` builds the same
   * `reply_on_pr` act a rule would and hands it here, so an agent's reply takes the
   * whole route: hold, standing rejection, re-ask, authority, signing, and the
   * escalation if the send fails.
   *
   * The cycle id names the agent rather than a pulse — the decision belongs to the
   * agent's call, not to whatever cycle was running.
   *
   * @public — reached from the MCP tool layer through `McpToolDeps.prReply`.
   */
  async proposeReply(input: {
    agentId: string;
    prNumber: number;
    commentId: string | null;
    draft: string;
    resolve: boolean;
    originRef: string;
    reason: string;
  }): Promise<{ outcome: DecisionOutcome; detail: string }> {
    const cycleId = `agent-reply:${input.agentId}`;
    const action = {
      type: 'reply_on_pr' as const,
      prNumber: input.prNumber,
      commentId: input.commentId,
      draft: input.draft,
      resolve: input.resolve,
      originRef: input.originRef,
      reason: input.reason,
      rule: null,
      admission: null,
    };
    const outbound = await this.authorize(cycleId, action);
    if (!outbound.recorded) {
      this.deps.store.recordDecision({
        cycleId,
        action: action as unknown as Action,
        outcome: outbound.outcome,
        detail: outbound.detail,
      });
    }
    return { outcome: outbound.outcome, detail: outbound.detail };
  }

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
    if (act.kind === 'plan') {
      const settled = releasePlan(store, act.planId, act.originRef);
      return settled.ok
        ? audit('executed', `Approved the plan: ${settled.detail} — authorized by ${by} (${proposal.id}).`)
        : audit('skipped', `Nothing to release for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
    }
    if (act.kind === 'plan_amendment') {
      const settled = applyPlanAmendment(store, act.amendmentId);
      return settled.ok
        ? audit(
            'executed',
            `Approved the change to the plan: ${settled.detail} — authorized by ${by} (${proposal.id}).`,
          )
        : audit('skipped', `Nothing to amend for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
    }
    if (act.kind === 'shortfall') {
      const settled = actOnShortfall(store, act);
      if (settled.ok) store.clearShortfall(act.originRef);
      return settled.ok
        ? audit(
            'executed',
            `Acted on the assessment of ${act.originRef}: ${settled.detail} — authorized by ${by} (${proposal.id}).`,
          )
        : audit('skipped', `Nothing to act on for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
    }
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
      if (act.commentId !== null) {
        this.deps.store.setPrThreadReopened(act.prNumber, act.commentId, false);
        this.recordReplySent(act.prNumber, act.commentId, res.commentRef);
      }
      this.recordReviewPublished(act, res.threadRef);
      const resolution = await this.resolveAnswered(act);
      return audit(
        'executed',
        `Sent the reply on PR #${act.prNumber} — authorized by ${by}${because} (${proposal.id}).${res.ref ? ` ref=${res.ref}` : ''}${resolution}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      if (act.kind === 'merge') this.deps.landings.stopForFailedMerge(act.prNumber, message);
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
              context: { prNumber: act.prNumber, commentId: act.commentId, draft: act.body },
            });
      return audit(
        'rejected',
        `Authorized ${act.kind === 'merge' ? `merge of PR #${act.prNumber}` : `reply on PR #${act.prNumber}`} failed (${message}); escalated so it isn't dropped: ${esc.id}.`,
      );
    }
  }

  private recordReplySent(prNumber: number, threadId: string, commentRef: string | undefined): void {
    if (commentRef !== undefined && commentRef !== '') {
      this.deps.store.recordPrReplySent(prNumber, threadId, commentRef);
      return;
    }
    this.deps.errors.record({
      source: 'provider',
      message: `The reply on PR #${prNumber} went out, but the provider returned no comment id for it.`,
      detail:
        `Thread ${threadId} will keep reading as unanswered work and the fleet will answer it again, because ` +
        `attribution is a record of what was sent and there is nothing to record. Identity is deliberately not ` +
        `used as a fallback: the harness posts under the operator's own credential, so it cannot tell its own ` +
        `reply from theirs.`,
    });
  }

  private recordReviewPublished(
    act: { kind: 'reply_draft'; prNumber: number; commentId: string | null; originRef: string | null },
    threadRef: string | undefined,
  ): void {
    if (act.commentId !== null || threadRef === undefined || threadRef === '') return;
    if (act.originRef !== reviewOrigin(act.prNumber)) return;
    this.deps.store.recordPrReviewPublished(act.prNumber, threadRef);
  }

  private async resolveAnswered(act: {
    prNumber: number;
    commentId: string | null;
    resolve: boolean;
  }): Promise<string> {
    if (!act.resolve || act.commentId === null) return '';
    if (!this.deps.sink.canResolvePrThread()) return ' The thread was left open: this provider cannot resolve one.';
    try {
      const res = await this.deps.sink.resolvePrThread({ prNumber: act.prNumber, commentId: act.commentId });
      return res.ok
        ? ` Resolved thread ${act.commentId}.`
        : ` PR #${act.prNumber} carries no thread ${act.commentId}; left it as it was.`;
    } catch (err) {
      const message = (err as Error).message;
      this.deps.errors.record({
        source: 'provider',
        message: `Sent the reply on PR #${act.prNumber} but could not resolve thread ${act.commentId}: ${message}`,
        detail: 'The thread stays open, so rule pr-review-comment dispatches for it again.',
      });
      return ` The reply went out; resolving thread ${act.commentId} failed (${message}), so it is still open.`;
    }
  }

  private rejectionSignals(proposals: Proposal[]): WorldEvent[] {
    const query = rejectionSignalQuery(proposals);
    return query ? this.deps.store.listWorldEventsSince(query.since, query.refs) : [];
  }

  private abandonUnstarted(task: Task): void {
    const current = this.deps.store.getTask(task.id);
    if (current && isActiveTask(current)) this.deps.store.updateTask(task.id, { status: 'interrupted' });
    if (task.branch) void this.deps.worktrees.remove(task.branch).catch(() => {});
  }

  private async ciEvidenceFor(action: ValidatedAction & { type: 'dispatch_code_agent' }): Promise<string> {
    const reader = this.deps.ciEvidence;
    if (!reader || action.rule !== 'pr-ci-failing') return '';
    const names = action.ciChecks ?? [];
    if (names.length === 0) return '';
    const prNumber = Number(/^pr:(\d+):/.exec(action.originRef ?? '')?.[1]);
    if (!Number.isInteger(prNumber)) return '';

    const pr = this.deps.store.getWorldBaseline()?.pullRequests.find((p) => p.number === prNumber);
    const targets: CiEvidenceTarget[] = (pr?.ciChecks ?? [])
      .filter((c) => c.evidenceRef !== undefined && names.includes(c.name))
      .map((c) => ({ name: c.name, evidenceRef: c.evidenceRef! }));
    if (targets.length === 0) return '';

    try {
      return ciEvidenceNote(await reader.readCiFailureEvidence(prNumber, targets));
    } catch (err) {
      this.deps.errors.record({
        source: 'provider',
        message: `Could not read CI evidence for PR #${prNumber}: ${(err as Error).message}`,
        detail: 'The CI-fix agent was dispatched without it.',
      });
      return '';
    }
  }

  private recordDispatchTask(
    action: ValidatedAction & { type: 'dispatch_code_agent' | 'dispatch_desk_agent' },
    evidence: string,
    retry: RetryResume | null,
  ): Task {
    const { store } = this.deps;
    const guidance = rejectionGuidance(
      [action.originRef, ...(action.type === 'dispatch_code_agent' ? (action.signalRefs ?? []) : [])],
      store.listProposals(),
    );
    const outstanding = outstandingForOrigin(action.originRef, store);
    const prior = priorWorkFor(action.originRef, store, outstanding !== null);
    const delivered = deliveredWorkFor(action.originRef, store);
    const briefing = retroBriefing(action.originRef, store);
    const feature = featureBriefing(action.originRef, store, this.deps.featureBoard);
    const sequence = sequenceBriefing(
      action.originRef,
      store.getWorldBaseline()?.issues ?? [],
      sequenceFeatureOrigin(action.originRef, store),
    );
    const attachments = attachmentsFor(action.originRef, store);
    const note = retry ? retryNote(retry.priorAttempts + 1, action.type === 'dispatch_code_agent') : null;
    const instructions = instructionsFor(action.originRef, store, this.deps.instructionTracker);
    const obstacles = obstaclesFor(action, store);
    const witness = action.type === 'dispatch_code_agent' ? WITNESS_INSTRUCTION : null;
    const prompt = [
      note,
      action.prompt,
      instructions,
      evidence,
      obstacles,
      guidance,
      outstanding,
      prior,
      delivered,
      briefing,
      feature,
      sequence,
      attachments,
      witness,
    ]
      .filter(Boolean)
      .join('\n\n');
    const profile = resolveAgentProfile(this.deps.agentModels, action.rule, action.profile);
    if (action.type === 'dispatch_code_agent')
      return store.createTask({
        kind: 'code',
        title: action.title,
        prompt,
        branch: action.branch,
        originRef: action.originRef,
        originTitle: action.originTitle,
        originSummary: action.originSummary,
        dispatchReason: action.reason,
        rule: action.rule,
        ciChecks: action.ciChecks ?? null,
        mcpServers: action.mcpServers?.length ? action.mcpServers : null,
        model: profile?.model ?? null,
        effort: profile?.effort ?? null,
        profile: profile?.name ?? null,
        profileSource: profile?.source ?? null,
      });
    return store.createTask({
      kind: 'desk',
      title: action.title,
      prompt,
      branch: null,
      originRef: action.originRef,
      originTitle: action.originTitle,
      originSummary: action.originSummary,
      dispatchReason: action.reason,
      rule: action.rule,
      model: profile?.model ?? null,
      effort: profile?.effort ?? null,
      profile: profile?.name ?? null,
      profileSource: profile?.source ?? null,
    });
  }

  private async workingDirectory(
    task: Task,
    action: ValidatedAction & { type: 'dispatch_code_agent' | 'dispatch_desk_agent' },
  ): Promise<string> {
    if (action.type === 'dispatch_code_agent') {
      const at = action.base ?? this.deps.defaultBranch;
      return action.readOnly
        ? this.deps.worktrees.ensureReadOnly(action.branch, at)
        : this.deps.worktrees.ensure(action.branch, at);
    }
    const cwd = resolve(this.deps.deskRoot, task.id);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }
}

function attachmentsFor(originRef: string | null | undefined, store: Store): string | null {
  if (!originRef) return null;
  return attachmentsNote(store.listAttachments(goalOriginFor(originRef) ?? originRef)) || null;
}

function obstaclesFor(
  action: ValidatedAction & { type: 'dispatch_code_agent' | 'dispatch_desk_agent' },
  store: Store,
): string | null {
  const scopes = dispatchFactScopes(
    action.originRef ?? null,
    action.type === 'dispatch_code_agent' ? (action.ciChecks ?? null) : null,
  );
  const goal = corroborationGoal(action.originRef ?? null);
  const paths = goal === null ? [] : store.listGoalFiles(goal).map((file) => file.path);
  if (scopes.length === 0 && paths.length === 0) return null;
  const rows = store.listObstacles().map((obstacle) => ({ obstacle, keys: store.listObstacleKeys(obstacle.id) }));
  return renderObstacleNote(obstaclesForDispatch({ rows, scopes, paths })) || null;
}

function instructionsFor(
  originRef: string | null | undefined,
  store: Store,
  tracker: ((issueNumber: number) => string | null) | undefined,
): string | null {
  const goal = goalOriginFor(originRef ?? null);
  if (!goal) return null;
  const standing = store.listStandingInstructions(goal);
  if (standing.length === 0) return null;
  const number = Number(goal.slice('issue:'.length));
  return operatorInstructionsNote(standing, tracker?.(number) ?? null) || null;
}

function outstandingForOrigin(originRef: string | null | undefined, store: Store): string | null {
  if (!originRef) return null;
  const stored = store.getIssueConclusion(originRef);
  if (!stored || stored.verdict !== 'more_work' || stored.by !== 'agent') return null;
  return outstandingWorkNote(stored.note, stored.updatedAt);
}

function priorWorkFor(originRef: string | null | undefined, store: Store, outstandingShown: boolean): string | null {
  const ref = originRef ?? '';
  const issueOriginRef = goalOriginFor(ref);
  if (!issueOriginRef) return null;
  if (retroSubmitOrigin(ref).ok) return null;
  const plan = store.getPlanByOrigin(issueOriginRef);
  const files = store.listGoalFiles(issueOriginRef);
  const briefing = priorWorkBriefing({
    plan,
    caveatAnswers: plan ? store.listPlanCaveatAnswers(plan.id) : [],
    parts: plan ? store.listPlanParts(plan.id) : [],
    appraisal: store.getAppraisal(issueOriginRef),
    conclusion: outstandingShown ? null : store.getIssueConclusion(issueOriginRef),
    delivery: store.getDelivery(issueOriginRef),
    shortfall: store.getShortfall(issueOriginRef),
    entries: store.listScratchEntries(issueOriginRef),
    files,
    neighbours: store.listGoalNeighbours(issueOriginRef, neighbourSeedPaths(files, plan)),
    forPart: /^issue:\d+:part:/.test(ref),
  });
  return briefing || null;
}

function deliveredWorkFor(originRef: string | null | undefined, store: Store): string | null {
  const issueNumber = assessIssueNumber(originRef ?? '');
  if (issueNumber === null) return null;
  const baseline = store.getWorldBaseline();
  const plan = store.getPlanByOrigin(`issue:${issueNumber}`);
  const partPrs = new Set(
    (plan ? liveParts(store.listPlanParts(plan.id)) : []).flatMap((p) => (p.prNumber === null ? [] : [p.prNumber])),
  );
  const byNumber = new Map<number, PullRequest>();
  for (const pr of store.listArchivedPrs()) byNumber.set(pr.number, pr);
  for (const pr of baseline?.closedPullRequests ?? []) byNumber.set(pr.number, pr);
  const issues = baseline?.issues ?? [];
  const prs = [...byNumber.values()]
    .filter((pr) => partPrs.has(pr.number) || issueForPr(pr, issues)?.number === issueNumber)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || b.number - a.number);
  return deliveredWorkBriefing(prs) || null;
}

function featureBriefing(
  originRef: string | null | undefined,
  store: Store,
  board: FeatureBoardFacts | undefined,
): string | null {
  const target = originRef ? featureSummarySubmitOrigin(originRef) : { ok: false as const, error: '' };
  if (!target.ok || !board) return null;
  const record = featureRecords(store, board).find((f) => f.number === target.featureNumber);
  if (!record) return null;
  const previous = store.getFeatureSummary(target.featureOrigin);
  return renderFeatureDossier(
    record,
    featureReach(store, board),
    previous
      ? [
          `**Where this is:** ${previous.standing}`,
          previous.usable ? `**Usable now:** ${previous.usable}` : null,
          previous.blocked ? `**Blocked:** ${previous.blocked}` : null,
          previous.remaining ? `**Left to do:** ${previous.remaining}` : null,
        ]
          .filter(Boolean)
          .join('\n\n')
      : null,
  );
}

function retroBriefing(originRef: string | null | undefined, store: Store): string | null {
  const target = originRef ? retroSubmitOrigin(originRef) : { ok: false as const, error: '' };
  if (!target.ok) return null;
  const issueOriginRef = target.issueOrigin;
  const dossier = retroDossier(goalRecord(store, issueOriginRef));
  return [retroPad(store.listScratchEntries(issueOriginRef)), dossier].filter(Boolean).join('\n\n');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function describeAmendmentFor(store: Store, amendment: PlanAmendment): string {
  let document: unknown;
  try {
    document = JSON.parse(amendment.document);
  } catch {
    return describeAmendment({ note: amendment.note, diff: null, warnings: [] });
  }
  const parsed = validatePlanDocument(document);
  if (!parsed.ok) return describeAmendment({ note: amendment.note, diff: null, warnings: [] });
  const declared = planPartInputs(parsed.document);
  return describeAmendment({
    note: amendment.note,
    diff: proposedPlanDiff(store.listPlanRevisions(amendment.planId), {
      narrative: planNarrative(parsed.document),
      parts: declared,
    }),
    warnings: amendmentWarnings(store.listPlanParts(amendment.planId), declared),
  });
}

function readyingTitle(action: ValidatedAction): string {
  switch (action.type) {
    case 'dispatch_code_agent':
    case 'dispatch_desk_agent':
      return action.title;
    case 'merge_pr':
      return `Merging pull request #${action.prNumber}`;
    case 'reply_on_pr':
      return `Replying on pull request #${action.prNumber}`;
    case 'escalate_to_human':
      return 'Putting a question to you';
    case 'respond_to_agent':
      return `Answering agent ${action.agentId}`;
    case 'propose_plan':
      return 'Putting a plan to you';
    case 'propose_plan_amendment':
      return 'Putting a change to a plan to you';
    case 'propose_shortfall':
      return 'Putting a shortfall to you';
    default:
      return action.type.replace(/_/g, ' ');
  }
}

function sequenceFeatureOrigin(originRef: string | null | undefined, store: Store): FeatureSequence | null {
  const target = originRef ? featureSequenceSubmitOrigin(originRef) : { ok: false as const, error: '' };
  return target.ok ? store.getFeatureSequence(target.featureOrigin) : null;
}
