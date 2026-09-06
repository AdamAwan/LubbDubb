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

interface ExecutorDeps {
  store: Store;
  agents: AgentManager;
  worktrees: Worktrees;
  escalations: EscalationInbox;
  /**
   * Where an action is visible while the executor works it — the minutes between a plan
   * naming a dispatch and an agent existing for it.
   */
  readying: ReadyingBoard;
  /** The operator's standing authorizations over whole stacks. */
  landings: StackLandingDesk;
  /** Outbound seam for side-effectful actions the harness may auto-send. */
  sink: ActionSink;
  /**
   * Whether a drafted review reply goes out without being put to the operator
   * (`sendPrRepliesWithoutApproval`). Absent = off, not the config default — an unwired
   * seam that *sends* is the failure worth refusing.
   */
  autoSendReplies?: () => boolean;
  /** Which model each kind of work runs on, or undefined where none is configured. */
  agentModels?: AgentModels;
  deskRoot: string;
  /** Base a *new* agent branch is cut from. */
  defaultBranch: string;
  /** Live cap + pause flag, read by reference each cycle (never a frozen copy). */
  runtime: RuntimeControl;
  /**
   * The one error-recording path, reached by the acts the executor performs itself: a
   * decision row says an act did not happen, and a *provider* failure has to surface in the
   * Errors panel beside the others.
   */
  errors: ErrorRecorder;
  /**
   * What the failing CI checks reported, fetched at dispatch. Optional, and absent changes
   * nothing.
   */
  ciEvidence?: CiEvidenceReader;
  /**
   * How an agent amends the goal's ticket, per issue number — the one thing a standing
   * operator instruction needs that comes from the `issues` provider's config.
   */
  instructionTracker?: (issueNumber: number) => string | null;
  /**
   * What a Feature's dossier is gathered with — container types, watch label and
   * environments, all config.
   */
  featureBoard?: FeatureBoardFacts;
}

export interface ExecutionSummary {
  cycleId: string;
  executed: number;
  deferred: number;
  rejected: number;
}

/**
 * Turns a validated action plan into real effects under three guard rails: never a second
 * agent for work already in flight (origin de-duplication), never a second agent on a
 * branch a live task holds, never above the concurrency cap.
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

      // On the board for as long as the executor holds it — see
      // {@link ReadyingBoard}. The `finally` is the point: an action that throws
      // must take its row with it, or the cockpit draws work nobody is doing.
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
            // Two ways the same work can already be in flight: a task on this
            // origin, and a job standing in for it. The second closes the window a
            // requeue filed after the snapshot the dispatcher decided from.
            if (origin && (store.findActiveTaskByOrigin(origin) || store.findStandingJobByOrigin(origin))) {
              record('skipped', `Skipped: work for ${origin} is already in flight.`);
              break;
            }
            // The branch half of the same gate. For every world-driven rule, origin
            // and branch are 1:1, so this is a no-op for them (asserted in
            // test/jobQueue.test.ts, because a rule breaking that property would
            // otherwise break it silently). Rule `manual-job` and the LLM dispatcher
            // can name a branch the origin does not determine, and `ensure` is
            // reuse-first — so letting either through puts two live claude processes
            // in one worktree directory.
            //
            // **Deferred, not skipped**: `skipped` means "this work is already being
            // done", where the collision here is transient. The job stays `queued`
            // and the gate re-tests next cycle.
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
            // Held outside the `try` so the catch can settle a row the throw left
            // behind — see {@link ActionExecutor.abandonUnstarted}.
            let task: Task | null = null;
            try {
              // Before the row is written, so the stored prompt is the prompt the
              // agent gets.
              hold.at('ci-evidence');
              const evidence = action.type === 'dispatch_code_agent' ? await this.ciEvidenceFor(action) : '';
              // Whether this dispatch continues the last agent's conversation.
              // Decided before the row, since its note is part of the stored prompt.
              const retry = retryResumeFor(origin, store);
              task = this.recordDispatchTask(action, evidence, retry);
              // A desk retry keeps the previous scratch directory; a code retry goes
              // through reuse-first `ensure`, which lands it back on the slot still
              // checked out on the branch so `--resume` finds its transcript.
              //
              // The step the row is on for nearly all of its life: a slot handed over
              // from another branch pays a `git clean -ffdx` and a cold checkout.
              // → `docs/spec/09-execution.md#handing-a-slot-over`
              hold.at('slot-handover');
              const cwd =
                retry && action.type === 'dispatch_desk_agent'
                  ? retry.previous.cwd
                  : await this.workingDirectory(task, action);
              // `claude --resume` resolves the transcript inside the *launch cwd's*
              // project directory, so a retry landing elsewhere has nothing to
              // re-attach to — and the failure looks only like a cold run.
              const inherit = retry && retry.previous.cwd === cwd ? retry.previous.sessionId : null;
              const agent = this.deps.agents.spawn(task, cwd, inherit);
              // Read off the row, not the request: a non-resumable runtime silently
              // declines the inheritance.
              const resumed = inherit !== null && agent.sessionId === inherit;
              liveCount += 1;
              // A job leaves the queue only once its agent is running, so a
              // capped/paused dispatch keeps it queued.
              if (action.jobId) store.markJobDispatched(action.jobId, task.id);
              // Same rule: a dispatch the cap/pause gate held leaves the part `ready`.
              if (action.type === 'dispatch_code_agent' && action.partId)
                store.markPartDispatched(action.partId, task.id, action.branch);
              // Same rule again, and here it keeps one press of the button to one
              // agent: the store's write is guarded on the row still being `pending`.
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
            // The authorized path audits itself, so there is only counting left.
            if (outbound.recorded) tally(outbound.outcome);
            else record(outbound.outcome, outbound.detail);
            break;
          }

          case 'propose_plan': {
            // The one proposal with no act to send, born here with the others so
            // "who may put something to a human" has a single answer. The hold is
            // re-asked here because every path reaching the executor must be
            // covered, not just the one that checks first.
            const ref = planProposalRef(action.originRef);
            const heldBy = planProposalHold(ref, store.listProposals());
            if (heldBy) {
              record('skipped', `Skipped proposing the plan for ${action.originRef}: ${heldBy}.`);
              break;
            }
            const esc = this.deps.escalations.create({
              type: 'approve_change',
              prompt: action.prompt,
              // Diagnosis and approach ride in `detail`, not the prompt: the card
              // renders it as its own labelled body above the buttons.
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
            // Born here with the other proposals, and the hold re-asked here, for
            // `propose_plan`'s reason.
            const ref = planAmendmentProposalRef(action.amendmentId);
            const heldBy = planAmendmentHold(ref, store.listProposals());
            if (heldBy) {
              record('skipped', `Skipped proposing the amendment to the plan for ${action.originRef}: ${heldBy}.`);
              break;
            }
            const amendment = store.getPlanAmendment(action.amendmentId);
            // Settled between the rule and here. Skipped rather than proposed: a card
            // for a settled amendment is one no answer can act on.
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
              // Built here rather than in the rule, because it is a reading of the
              // plan as it stands when the card is created.
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
            // Born here with the other proposals, and the hold re-asked, for
            // `propose_plan`'s reason.
            //
            // Unlike a plan this uses the *full* `proposalHold`, all three arms: a
            // shortfall is proposed off a row that persists until its arm is
            // performed, so without the durable `rejected` arm one refusal would be
            // re-asked every pulse. It still expires on world signal, or a replan
            // refused once would be vetoed for good.
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
              // The write-up rides in `detail`, not the prompt, so a re-ask
              // prepending to the prompt cannot push it further from the buttons.
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
            // The `behind` arm of rule `pr-base-update`, performed rather than
            // dispatched. Neither authorized nor proposed: it is a write to a branch
            // the harness owns, of a merge the provider has said is clean, and the
            // agent path took it without asking anyone.
            //
            // The branch gate again, because every path reaching the executor must be
            // covered: an agent holding the branch has a worktree cut from a commit
            // this merge would move. **Deferred, not skipped** — `skipped` is what
            // the next cycle reads as "fall back to an agent".
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
              // `ok: false` is the provider having no such operation — a
              // configuration, not a failure, so audited and not recorded as an
              // error. The row is what the next cycle falls back to an agent on.
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
            // The expired arm of rule `pr-ci-gate`, performed rather than dispatched,
            // for `update_pr_branch`'s reasons.
            //
            // **No branch gate here, and that is not an omission**: a requeue writes
            // to a policy evaluation, not the branch, so nothing an agent's worktree
            // was cut from moves.
            const unperformed: string[] = [];
            try {
              for (const check of action.checks) {
                const res = await this.deps.sink.requeueCiCheck({
                  prNumber: action.prNumber,
                  check: check.name,
                  requeueRef: check.requeueRef,
                });
                // `ok: false` is the provider saying nothing was queued — no such
                // operation, or it declined. Audited, never recorded as an error.
                if (!res.ok) unperformed.push(check.name);
              }
            } catch (err) {
              const message = (err as Error).message;
              this.deps.errors.record({
                source: 'provider',
                message: `Requeueing the expired check(s) on PR #${action.prNumber} failed: ${message}`,
                detail: 'Rule pr-ci-gate will dispatch a code agent to queue the build instead.',
              });
              // Deliberately whole-act: the checks that did queue stop being expired
              // and drop out of the gate by themselves.
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
            // Mechanical bookkeeping, not a publish-to-the-world action, so it runs
            // directly rather than through the auto-send gate. Idempotent.
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

  /**
   * The one place an outbound act is authorized. Neither is a number, and nothing here is
   * to become one.
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

    // Repeated here because the hold must cover *every* path reaching the executor,
    // not only the one the rule checks. Re-read per action rather than hoisted: a
    // proposal created earlier in this same plan stops a second identical ask.
    const proposals = store.listProposals();
    const signals = this.rejectionSignals(proposals);
    const heldBy = proposalHold(kind, ref, proposals, { rejectionSignals: signals });
    if (heldBy) return { outcome: 'skipped', detail: `Skipped ${subject}: ${heldBy}.`, recorded: false };

    // The operator's standing authorization over a whole chain, asked only of a
    // merge. Asked after the hold, so a rejection they gave still governs, and
    // before the escalation, so an authorized chain does not fill the inbox with
    // the questions it exists to answer.
    const landing = merge ? store.standingLandingForPr(action.prNumber) : null;

    // The wider standing authority: a config key saying a drafted reply need not be
    // put to them at all. Replies only. Below the hold, because "you need not ask
    // me" is not "ignore what I said no to", and it can only ever *accept* — a
    // machine "no" is durable and would mean the question is never put to anyone.
    const autoSend = !merge && (this.deps.autoSendReplies?.() ?? false);

    if (landing || autoSend) {
      const proposal = store.createProposal({
        kind,
        ref,
        action: action as unknown as Action,
        // No inbox item: nothing is being asked. An escalation appears only if the
        // act then fails, which `runAuthorized` owns.
        escalationId: null,
      });
      // The row was created `pending` one statement ago, so this compare-and-set
      // always wins; `?? proposal` is narrowing, not a fallback path. The note names
      // *which* authority, so a reply they clicked reads apart from one their config
      // sent.
      const note = landing
        ? `you authorized landing ${landing.ref} (${landing.rungs.length} pull requests) on ${landing.createdAt}`
        : 'you set "sendPrRepliesWithoutApproval", which sends a drafted reply without asking';
      const accepted =
        store.decideProposal(proposal.id, 'accepted', note, landing ? 'stack_landing' : 'auto_send') ?? proposal;
      const run = await this.runAuthorized(accepted, cycleId);
      return { ...run, recorded: true };
    }

    // Not the harness's to authorize: draft it and put it to a human. On a *re*-ask
    // over a rejection the world has overtaken, the question names the refusal and
    // what has happened since, or it reads as the harness having forgotten.
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
    /** The review thread being answered, or null for a reply on the pull request itself. */
    commentId: string | null;
    draft: string;
    /** The agent's verdict: this thread is dealt with, so resolve it once the reply lands. */
    resolve: boolean;
    /** The caller's dispatch origin, carried so the send can attribute what it created. */
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
    // The authorized path audits itself: write the row only when it did not.
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

  /** Perform an act that was authorized. */
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
    // A plan act publishes nothing: accepting it releases rule `plan-part` onto the
    // plan's parts. Here so an approved decomposition lands in the decision log in
    // the same shape, under the same authority, as an approved merge.
    if (act.kind === 'plan') {
      const settled = releasePlan(store, act.planId, act.originRef);
      return settled.ok
        ? audit('executed', `Approved the plan: ${settled.detail} — authorized by ${by} (${proposal.id}).`)
        : audit('skipped', `Nothing to release for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
    }
    // An amendment publishes nothing either: it ingests the amended document over a
    // plan that stays released, so the parts being worked carry on. Here for the
    // plan act's reason.
    if (act.kind === 'plan_amendment') {
      const settled = applyPlanAmendment(store, act.amendmentId);
      return settled.ok
        ? audit(
            'executed',
            `Approved the change to the plan: ${settled.detail} — authorized by ${by} (${proposal.id}).`,
          )
        : audit('skipped', `Nothing to amend for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
    }
    // A shortfall publishes nothing either: it sends the plan back to a planner or
    // appends one part for rule `plan-part`. Here for the plan act's reason.
    if (act.kind === 'shortfall') {
      const settled = actOnShortfall(store, act);
      // The row is consumed by the effect it drove; leaving it would re-propose the
      // arm once the settle window lapsed. A *rejection* deliberately leaves it —
      // the verdict is still true, the operator simply declined to act.
      if (settled.ok) store.clearShortfall(act.originRef);
      return settled.ok
        ? audit(
            'executed',
            `Acted on the assessment of ${act.originRef}: ${settled.detail} — authorized by ${by} (${proposal.id}).`,
          )
        : audit('skipped', `Nothing to act on for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
    }
    // The decider's own reason, carried verbatim rather than re-derived.
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
      // The operator's reopen is spent the moment the fleet answers it. Without the
      // clear, the mark holds the thread open against every later reading and the
      // rule dispatches for it every pulse. A no-op on a thread nobody reopened.
      // → `docs/spec/07-pull-requests.md#reopening-a-thread`
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
      // A merge a standing intent authorized and that would not go through ends the
      // intent; otherwise it is re-proposed, re-authorized and retried every cycle.
      // Only that PR's intent is touched — a failed human-accepted merge stops nothing.
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

  /**
   * Write down that the harness sent this reply — the sole place attribution is recorded,
   * because this is the sole place a reply goes out. A record, never an identity test: the
   * harness posts under the operator's own credential. →
   * `docs/spec/07-pull-requests.md#review-threads` **A send the provider would not name is
   * recorded as a failure, never guessed at.** Without an id the thread keeps reading as
   * work and the fleet answers it again; falling back to the author would settle the thread
   * and lose the reviewer. The `errors.record` stops that re-dispatch loop being silent.
   */
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

  /**
   * Write down the thread the fleet's review published its findings into — the only thing
   * that can later say whether anybody dealt with them. Attributed off the act's
   * **origin**, never off what the comment says.
   */
  private recordReviewPublished(
    act: { kind: 'reply_draft'; prNumber: number; commentId: string | null; originRef: string | null },
    threadRef: string | undefined,
  ): void {
    if (act.commentId !== null || threadRef === undefined || threadRef === '') return;
    if (act.originRef !== reviewOrigin(act.prNumber)) return;
    this.deps.store.recordPrReviewPublished(act.prNumber, threadRef);
  }

  /**
   * Mark the thread resolved when the agent that wrote the reply said it had dealt with it,
   * reporting what happened as a clause on the reply's own audit line.
   */
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

  /** The world since each standing rejection, for the hold gate. */
  private rejectionSignals(proposals: Proposal[]): WorldEvent[] {
    const query = rejectionSignalQuery(proposals);
    return query ? this.deps.store.listWorldEventsSince(query.since, query.refs) : [];
  }

  /**
   * Settle a task row whose dispatch threw before its agent ever ran. Releasing a branch
   * never leased is a no-op.
   */
  private abandonUnstarted(task: Task): void {
    const current = this.deps.store.getTask(task.id);
    if (current && isActiveTask(current)) this.deps.store.updateTask(task.id, { status: 'interrupted' });
    if (task.branch) void this.deps.worktrees.remove(task.branch).catch(() => {});
  }

  /**
   * Create the task row — and the one place a dispatch prompt picks up what an operator
   * said when they refused an act for this exact origin.
   */
  /**
   * The failing output of the checks this dispatch is about, ready to append — or `''`,
   * which composes the prompt as it was before this existed.
   */
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
      // The reader is documented not to throw; this keeps that a documentation bug
      // rather than a failed dispatch.
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
    // The origin *and* the signals folded under it, both exact refs — never a
    // widening to the world item, which must not happen here.
    const guidance = rejectionGuidance(
      [action.originRef, ...(action.type === 'dispatch_code_agent' ? (action.signalRefs ?? []) : [])],
      store.listProposals(),
    );
    // What the last agent on this issue said was left. Appended, and only on an
    // exact origin match — a `more_work` verdict is about *this* issue.
    const outstanding = outstandingForOrigin(action.originRef, store);
    // What the earlier agents on this goal worked out. Passed the outstanding
    // note's verdict so the two never both render it.
    const prior = priorWorkFor(action.originRef, store, outstanding !== null);
    // Where this goal's pull requests are in the checkout. Scoped to the exact
    // assess origin, not the goal: it indexes a run the harness believes is over.
    const delivered = deliveredWorkFor(action.originRef, store);
    // A retrospective agent has no worktree and no world, so what it can say is
    // what it is handed. The pad goes first — nothing else could supply it.
    const briefing = retroBriefing(action.originRef, store);
    // The same for a Feature. Resolved here rather than in the rule, because no
    // rule may read prose; the summary on file rides in this block so a re-write
    // revises rather than restarts. → `docs/spec/17-cockpit.md#the-feature-summary`
    const feature = featureBriefing(action.originRef, store, this.deps.featureBoard);
    // And the same for a sequencer. Off the world baseline rather than the ticket
    // mirror, because Predecessor links are a hydration field the mirror lacks.
    const sequence = sequenceBriefing(
      action.originRef,
      store.getWorldBaseline()?.issues ?? [],
      // The order on file rides here too, so a re-sequence revises rather than restarts.
      sequenceFeatureOrigin(action.originRef, store),
    );
    // The images the operator attached, scoped to the *goal* rather than the exact
    // origin — see `attachmentsFor`.
    const attachments = attachmentsFor(action.originRef, store);
    // The retry note, the one block that goes *ahead* of the rendered prompt: the
    // agent must know it is on covered ground before it reads the restatement, or
    // the restatement is simply a second task.
    const note = retry ? retryNote(retry.priorAttempts + 1, action.type === 'dispatch_code_agent') : null;
    // What the operator has asked for since anyone last concluded the goal. Scoped
    // to the *goal*, and first among the appended blocks — the only one that
    // changes what the work is.
    const instructions = instructionsFor(action.originRef, store, this.deps.instructionTracker);
    // What the fleet has already run into on these checks and files
    // (`docs/spec/27-obstacles.md`). Here rather than in a rule, because every
    // dispatch passes through this method.
    //
    // **There is no fleet-wide block here and there never will be**: everything on
    // the board is keyed, and a keyed thing goes to the dispatches it is about.
    const obstacles = obstaclesFor(action, store);
    // The witness log's one standing instruction: record the forks. Code agents
    // only, and last, because it is about how to work rather than what the work is.
    // → docs/spec/31-review-packs.md#the-witness-log
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
    // The model and depth, resolved once as one profile and stored, so a resumed
    // agent re-launches on what it started on. `action.profile` is the origin's pin
    // and beats the rule's entry, and stays a pure function of the dispatch — so a
    // retry, a re-dispatch and a boot-resume all land on the same profile.
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
        // What kind of work this is and which checks it answers — on the task,
        // because a decision row carries the rule but nothing links it to the agent.
        rule: action.rule,
        ciChecks: action.ciChecks ?? null,
        // `AgentManager.resume` rebuilds the launch from this row, and an agent
        // re-attached without the browser it was launched with holds a conversation
        // full of tool calls it can no longer make.
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

  /**
   * The directory the agent will run in: the branch's worktree for code, a per-task scratch
   * directory for desk.
   */
  private async workingDirectory(
    task: Task,
    action: ValidatedAction & { type: 'dispatch_code_agent' | 'dispatch_desk_agent' },
  ): Promise<string> {
    // A stacked plan part names the branch it forks from; everything else takes the
    // configured integration branch. **`readOnly` picks the shape, and nothing else
    // does** — one call site, so no rule can arrange its own.
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

/**
 * The previous agent's "there is more to do here" note — or null when there is none to
 * carry.
 */
/** The images attached to the goal being dispatched for, or null. */
function attachmentsFor(originRef: string | null | undefined, store: Store): string | null {
  if (!originRef) return null;
  return attachmentsNote(store.listAttachments(goalOriginFor(originRef) ?? originRef)) || null;
}

/**
 * What the obstacle board has to say about this dispatch, or null. Both are read for the
 * **goal**, never the concern.
 */
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

/** The operator's standing instructions on the goal being dispatched for, or null. */
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

/**
 * The rows behind {@link priorWorkBriefing}, gathered for the goal this dispatch belongs to
 * — or null for every dispatch that is not on one. Everything else resolves to null and is
 * handed nothing.
 */
function priorWorkFor(originRef: string | null | undefined, store: Store, outstandingShown: boolean): string | null {
  const ref = originRef ?? '';
  const issueOriginRef = goalOriginFor(ref);
  if (!issueOriginRef) return null;
  if (retroSubmitOrigin(ref).ok) return null;
  const plan = store.getPlanByOrigin(issueOriginRef);
  const files = store.listGoalFiles(issueOriginRef);
  const briefing = priorWorkBriefing({
    plan,
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

/**
 * The rows behind {@link deliveredWorkBriefing}, gathered for the goal an assessor has been
 * dispatched on — or null for every other dispatch. Keyed on the exact assess origin, since
 * the archive is written before the world's window and the fresher reading wins
 * ([14](docs/spec/14-persistence.md)).
 */
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
    // Newest close first: merging the two lists loses the archive's own order, and a
    // trimmed list should keep the last merges.
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || b.number - a.number);
  return deliveredWorkBriefing(prs) || null;
}

/**
 * Everything a retrospective agent is given beyond its prompt: the issue's scratchpad, then
 * the record the harness kept — or null for every other dispatch.
 */
/**
 * Everything a feature-summary agent is given beyond its prompt: every item under the
 * Feature, where each stands, and the summary on file if there is one.
 */
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
    // Read here, not in the gather: the pulse must not pay for a reading nothing
    // compares.
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
  // The reading is `goalRecord`'s and the rendering is this call's, so a
  // retrospective and the operator's own Claude cannot see two different histories.
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

/**
 * What a readying row says it is for — the dispatcher's own `title` where there is one, so
 * the row and the agent that follows it name the work the same way.
 */
/**
 * The body of an amendment card: the author's reason, what the change does to the plan, and
 * what it leaves running whatever the answer.
 */
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

/** The order on file for the Feature this dispatch is sequencing, or null. */
function sequenceFeatureOrigin(originRef: string | null | undefined, store: Store): FeatureSequence | null {
  const target = originRef ? featureSequenceSubmitOrigin(originRef) : { ok: false as const, error: '' };
  return target.ok ? store.getFeatureSequence(target.featureOrigin) : null;
}
