import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { Worktrees } from '../worktree/worktreeManager.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { StackLandingDesk } from '../stacks/landingDesk.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { AutoSendConfig } from '../config.js';
import { resolveAgentModel, type AgentModels } from '../agents/modelPolicy.js';
import type { RuntimeControl } from '../runtimeControl.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { ValidatedAction } from '../dispatcher/actions.js';
import type { DispatchResult } from '../dispatcher/dispatcher.js';
import {
  authorityOf,
  mergeProposalRef,
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
import { shortfallRef } from '../delivery/shortfall.js';
import { outstandingWorkNote } from '../mcp/conclusion.js';
import { attachmentsNote } from '../jobs/attachments.js';
import { retroSubmitOrigin } from '../retro/retro.js';
import { padTestimony, retroDossier } from '../retro/dossier.js';
import { priorWorkBriefing } from '../briefing/priorWork.js';
import { ciEvidenceNote, type CiEvidenceReader, type CiEvidenceTarget } from '../ci/ciEvidence.js';
import { padOriginFor } from '../scratch/pad.js';
import { isActiveTask } from '../tasks.js';
import type { Action, DecisionOutcome, Proposal, ProposalKind, Task, WorldEvent } from '../types.js';

interface ExecutorDeps {
  store: Store;
  agents: AgentManager;
  worktrees: Worktrees;
  escalations: EscalationInbox;
  /**
   * The operator's standing authorizations over whole stacks. Asked whether a
   * rung's merge is already authorized, and told when one it authorized failed.
   */
  landings: StackLandingDesk;
  /** Outbound seam for side-effectful actions the harness may auto-send. */
  sink: ActionSink;
  /** Confidence-gated auto-send policy. */
  autoSend: AutoSendConfig;
  /**
   * Which model each kind of work runs on (issue #321), or undefined for a
   * deployment that configures none. Consulted here, at dispatch, because this is
   * where the rule that proposed the run is in hand and where the row that
   * records what it launched on is written.
   */
  agentModels?: AgentModels;
  deskRoot: string;
  /**
   * Base a *new* agent branch is cut from. Passed on every `ensure` so the base is
   * explicit config rather than whatever `repoRoot` is checked out on.
   */
  defaultBranch: string;
  /** Live cap + pause flag, read by reference each cycle (never a frozen copy). */
  runtime: RuntimeControl;
  /**
   * The one error-recording path. Reached by the acts the executor performs
   * itself rather than through a proposal: a decision row says an act did not
   * happen, and the Errors panel is where a *provider* failure has to surface
   * beside the others.
   */
  errors: ErrorRecorder;
  /**
   * What the failing CI checks reported, fetched at dispatch (issue #334).
   *
   * Optional, and absent it changes nothing: a CI-fix dispatch is composed
   * exactly as it was before this existed. Read **here** rather than in the
   * dispatcher because the rule pipeline is synchronous and pure over the world
   * snapshot, and rather than in the world read because that runs every pulse
   * for every open pull request and would pay for a log nobody dispatches on.
   */
  ciEvidence?: CiEvidenceReader;
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
          // Two ways the same work can already be in flight: a task dispatched on
          // this origin, and a job standing in for it — a requeue, whose task says
          // `job:<id>`. The second is what closes the window a requeue filed *after*
          // the snapshot opens, which the dispatcher's `activeOrigins` cannot see
          // because it was decided from a world that predates the requeue (#249).
          if (origin && (store.findActiveTaskByOrigin(origin) || store.findStandingJobByOrigin(origin))) {
            record('skipped', `Skipped: work for ${origin} is already in flight.`);
            break;
          }
          // The branch half of the same gate (issue #116). For every world-driven
          // rule origin and branch are 1:1 (`pr:<n>:*`→`pr.branch`,
          // `issue:<n>`→`issue/<n>`, `issue:<n>:plan`→`plan/issue/<n>`,
          // `issue:<n>:part:<slug>`→`issue/<n>/<slug>`),
          // so the origin check above already *is* a branch check and this one is a
          // no-op for them — asserted in test/jobQueue.test.ts, because a later rule
          // that broke the 1:1 property would otherwise break it silently. Two paths
          // can reach here with a branch the origin doesn't determine: rule `manual-job`, whose
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
          // Held outside the `try` so the catch can settle a row the throw left
          // behind — see {@link ActionExecutor.abandonUnstarted}.
          let task: Task | null = null;
          try {
            // Fetched before the row is written so the prompt stored on the task
            // is the prompt the agent gets — a later append would leave the
            // cockpit showing something the agent never saw.
            const evidence = action.type === 'dispatch_code_agent' ? await this.ciEvidenceFor(action) : '';
            task = this.recordDispatchTask(action, evidence);
            const cwd = await this.workingDirectory(task, action);
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
          // `authorize` re-asks about a merge — rule `plan-approval` suppresses itself, but
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
            // The planner's diagnosis and approach ride in `detail`, not in the
            // prompt, for `propose_shortfall`'s reason: the card renders it as its
            // own labelled body, directly above the two buttons.
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

        case 'propose_shortfall': {
          // Born here with the other three, from a validated action, for
          // `propose_plan`'s reason: proposals are created in one place, so "who
          // may put something to a human" has a single answer. The hold is asked
          // here too — rule `issue-shortfall` suppresses itself, but every path
          // that reaches the executor must be covered, not just the one that
          // happens to check first.
          //
          // Unlike a plan this uses the *full* `proposalHold`, all three arms. A
          // plan proposal is made once per verdict and both settlements rewrite
          // the row the gate reads; a shortfall is proposed off a row that
          // persists until its arm is performed, so without the durable `rejected`
          // arm one refusal would be re-asked every pulse. It expires on world
          // signal like any other rejection, which it must: a replan refused
          // because the issue needed one more look would otherwise be vetoed for
          // good, and that is exactly the phase-4 failure.
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
            // The assessor's write-up rides in `detail`, not in the prompt: the
            // card renders it as its own labelled body, and a re-ask prepending
            // to the prompt must not push it further from the buttons.
            context: {
              originRef: action.originRef,
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
          // dispatched (issue #332). Not authorized and not proposed, for
          // `set_work_item_state`'s reason and one more: this is a write to a
          // branch the harness owns, of a merge the provider has already said is
          // clean, and the agent path took it without asking anyone. Making the
          // cheap path ask a human what the expensive one never did would be a new
          // gate wearing an optimisation's clothes.
          //
          // The branch gate again, for the reason the dispatch path re-checks it:
          // every path reaching the executor must be covered, not only the one
          // that checked first. An agent holding the branch has a worktree cut
          // from a commit this merge would move out from under it — the rule
          // proposes this only for a free branch, and this is what makes that
          // true of the moment it runs. **Deferred, not skipped**: the collision
          // is transient, and `skipped` is the word the next cycle reads as "the
          // cheap path is unavailable here" and falls back to an agent on.
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
            // `ok: false` is the provider saying it has no such operation (Azure
            // DevOps), which is a configuration rather than a failure — so it is
            // audited and *not* recorded as an error. Either way the row is what
            // the next cycle's rule reads to fall back to a code agent, so the PR
            // is never left sitting behind its base.
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

    // Rule `pr-merge-ready` suppresses itself while a merge proposal stands, so on the default
    // path this is asked once — but it is repeated here because it must hold for
    // *every* path that reaches the executor, including the human-authorized
    // `reply_on_pr` included. One predicate, two call sites: the same discipline
    // as the branch gate above.
    //
    // Re-read per action rather than hoisted: a proposal created earlier in this
    // same plan is what stops a second identical action asking twice.
    const proposals = store.listProposals();
    const signals = this.rejectionSignals(proposals);
    const heldBy = proposalHold(kind, ref, proposals, { rejectionSignals: signals });
    if (heldBy) return { outcome: 'skipped', detail: `Skipped ${subject}: ${heldBy}.`, recorded: false };

    // Absent confidence means "no confidence stated" -> treat as 0 -> never auto-send.
    const confidence = action.confidence ?? 0;
    const verdict = autoSendVerdict(this.deps.autoSend, action.type, confidence);
    // The operator's standing authorization over a whole chain, asked only of a
    // merge — a stack landing says nothing about replies. It is a *second*
    // decider, not a widening of the gate above: auto-send answers "the harness
    // cleared its own threshold", this answers "you authorized this chain in
    // advance", and the audit row exists to tell those apart.
    //
    // Asked after the hold, like the gate, so a rejection you gave still governs;
    // and asked *before* the escalation below, so an authorized chain does not
    // fill the inbox with the questions it exists to answer. A rung the operator
    // never authorized is not here, because the intent's scope is the PR numbers
    // it was clicked over.
    const landing = merge ? store.standingLandingForPr(action.prNumber) : null;

    if (verdict.authorized || landing) {
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
      //
      // The landing wins the attribution when both would authorize. An operator
      // who authorized the chain by hand is a stronger and more specific answer
      // to "who authorized this" than a threshold that happens to also clear it.
      const [note, decider] = landing
        ? [
            `you authorized landing ${landing.ref} (${landing.rungs.length} pull requests) on ${landing.createdAt}`,
            'stack_landing' as const,
          ]
        : [verdict.authorized ? verdict.note : '', 'auto_send' as const];
      const accepted = store.decideProposal(proposal.id, 'accepted', note, decider) ?? proposal;
      const run = await this.runAuthorized(accepted, cycleId);
      return { ...run, recorded: true };
    }

    // Not the harness's to authorize: draft it and put it to a human as a
    // proposal they can accept (which performs it) or reject.
    //
    // When this is a *re*-ask over a rejection the world has overtaken, the
    // question names the refusal and what has happened since — otherwise the
    // second ask is indistinguishable from the harness having forgotten the
    // first, which is the duplicate-question failure the gate exists to prevent.
    const again = reaskContext(kind, ref, proposals, { rejectionSignals: signals });
    const preamble = again ? `${again}\n\n` : '';
    const esc = this.deps.escalations.create(
      merge
        ? {
            type: 'approve_change',
            prompt: `${preamble}PR #${action.prNumber} is green, approved and mergeable. Approve merging it (method: ${action.method})?`,
            context: { prNumber: action.prNumber, method: action.method, confidence },
          }
        : {
            type: 'review_reply',
            prompt: `${preamble}Draft reply for PR #${action.prNumber}:\n\n${action.draft}`,
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
    // A plan act publishes nothing: accepting it releases rule `plan-part` onto the plan's
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
    // A shortfall publishes nothing either: accepting it either sends the plan
    // back to a planner (rule `issue-plan` takes over) or appends one part for rule `plan-part` to
    // schedule. It runs here for the plan act's reason — this is the one place an
    // accepted proposal becomes both its effect and its audit row.
    if (act.kind === 'shortfall') {
      const settled = actOnShortfall(store, act);
      // The row is consumed by the effect it drove, which is what "ends on" means
      // for this table: leaving it standing would have the rule re-propose the arm
      // the moment the settle window lapsed, on a plan already back with a planner.
      // A *rejection* deliberately leaves it — the verdict is still true, the
      // operator simply declined to act, and the cockpit chip should keep saying so.
      if (settled.ok) store.clearShortfall(act.originRef);
      return settled.ok
        ? audit(
            'executed',
            `Acted on the assessment of ${act.originRef}: ${settled.detail} — authorized by ${by} (${proposal.id}).`,
          )
        : audit('skipped', `Nothing to act on for ${act.originRef}: ${settled.detail} (${proposal.id}).`);
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
      // A merge a standing intent authorized and that would not go through ends
      // the intent. Otherwise the act is re-proposed once its settle window
      // lapses, authorized again by the same intent, and retried every cycle
      // behind an escalation nobody asked for. Only the intent that authorized
      // *this* PR is touched, and the desk no-ops when there is none — a failed
      // human-accepted merge stops nothing.
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

  /**
   * The world since each standing rejection, for the hold gate. The query is
   * derived from the proposals themselves by the one predicate the harness also
   * uses, so the two askers cannot disagree about what counts as having moved on.
   */
  private rejectionSignals(proposals: Proposal[]): WorldEvent[] {
    const query = rejectionSignalQuery(proposals);
    return query ? this.deps.store.listWorldEventsSince(query.since, query.refs) : [];
  }

  /**
   * Settle a task row whose dispatch threw before its agent ever ran.
   *
   * **This is the whole reason the row is settled rather than left alone.**
   * `queued` is deliberately an *active* status (`src/tasks.ts`), because the row
   * is written before the worktree and the agent exist and must hold the claim
   * across that window. So a row nothing ever started is not inert: it is a
   * permanent claim on its origin (`findActiveTaskByOrigin`, the dispatcher's
   * `activeOrigins`) and on its branch (`findActiveTaskByBranch`) — and the claim
   * on `job:<id>` is what stops the job re-dispatching, which leaves it `queued`,
   * which keeps it standing in for whatever *it* redoes (`STANDING_SQL` in
   * `src/store/jobs.ts`), wedging a second piece of work behind the first. One
   * transient `ensure` failure otherwise shuts a chain of work for the life of the
   * database against an idle fleet, with the harness reporting "nothing
   * actionable" every cycle.
   *
   * `interrupted` is the word a recovery `remove` verdict already writes for work
   * that was claimed and never done (`src/agents/recoveryDesk.ts`), and it is
   * terminal to all three gates, so nothing re-reads the row as in flight. The job
   * or plan part behind the dispatch is untouched: `markJobDispatched` /
   * `markPartDispatched` only run after the spawn, so both are still queued/ready
   * and the next cycle re-dispatches them.
   *
   * Conditional on the row still being active, because
   * {@link AgentManager.spawn} settles its own task as `failed` when the session
   * fails to start — a more specific reading of the same failure, which this must
   * not overwrite.
   */
  private abandonUnstarted(task: Task): void {
    const current = this.deps.store.getTask(task.id);
    if (current && isActiveTask(current)) this.deps.store.updateTask(task.id, { status: 'interrupted' });
  }

  /**
   * Create the task row — and the one place a dispatch prompt picks up what an operator said
   * when they refused an act for this exact origin (issue #109 phase 4).
   *
   * It happens here, not in the dispatcher that composed the prompt, for the
   * reason the branch gate lives here: every dispatch passes through, whatever
   * produced it. That is not a technicality in this case — a `reply_draft` is
   * only ever proposed off a `reply_on_pr`, so the path where
   * a rejected reply exists is precisely the one a rule-dispatcher-side hook
   * would miss.
   *
   * It is appended to the rendered prompt rather than filled into it. Templates
   * are operator-overridable and the loader only rejects *unknown* placeholders,
   * so an override that simply omits a new `{rejection}` token would silently
   * drop a human's words — and it would drop them on exactly the deployments that
   * customised the prompt most. Appending has no fallback to get wrong.
   */
  /**
   * The failing output of the checks this dispatch is about, ready to append —
   * or `''`, which composes the prompt exactly as it was before this existed.
   *
   * Scoped to `pr-ci-failing` and nothing else. Rule `pr-ci-gate` is deliberately
   * out: a waiting check has produced no failure to excerpt, and an **expired**
   * one's last run is against commits the branch has moved past, so its output
   * would point an agent at code that no longer exists — worse than no excerpt.
   *
   * The checks come from the dispatch (names, decided by the CI policy) joined to
   * the world baseline (refs, written by the provider). The baseline is this
   * cycle's world — `recordWorldChanges` writes it before the dispatcher runs —
   * so this is the same reading the decision was made on, not a second one.
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
      // The reader is documented not to throw; this is the backstop that keeps
      // that a documentation bug rather than a failed dispatch.
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
  ): Task {
    const { store } = this.deps;
    // The origin *and* the signals folded under it: a review-comment dispatch
    // names the PR's whole review, while a refused reply draft is filed against
    // the single thread it answered. Both are exact refs — this is not a widening
    // to the world item, which is the thing that must never happen here.
    const guidance = rejectionGuidance(
      [action.originRef, ...(action.type === 'dispatch_code_agent' ? (action.signalRefs ?? []) : [])],
      store.listProposals(),
    );
    // What the last agent on this issue said was left. Appended for the same
    // reason the rejection note is — a `{outstanding}` placeholder would be
    // dropped silently by any operator template override that omitted it — and
    // only on an exact origin match: a `more_work` verdict is about *this* issue,
    // and putting it in front of an agent dispatched for anything else would be
    // the same widening mistake as showing a merge refusal to a CI-fix agent.
    const outstanding = outstandingForOrigin(action.originRef, store);
    // What the earlier agents on this goal worked out. Appended for the reason the
    // two notes above are, and passed the outstanding note's own verdict so the two
    // never both render it: `outstandingForOrigin` owns an agent's `more_work`
    // declaration on an exact origin match.
    const prior = priorWorkFor(action.originRef, store, outstanding !== null);
    // A retrospective agent has no worktree and no world of its own, so what it can
    // say is entirely what it is handed: the pad the working agents left, and the
    // record only the harness kept. Appended for the same reason as the two notes
    // above, and the pad goes first — it is the half nothing else could supply.
    const briefing = retroBriefing(action.originRef, store);
    // The images the operator attached to this goal (issue #249). Appended for the
    // reason the four notes above are, and scoped to the *goal* rather than the
    // exact origin — see `attachmentsFor`.
    const attachments = attachmentsFor(action.originRef, store);
    const prompt = [action.prompt, evidence, guidance, outstanding, prior, briefing, attachments]
      .filter(Boolean)
      .join('\n\n');
    // The model this kind of work runs on, resolved once and stored — so a resumed
    // agent re-launches on what it started on rather than on whatever config says
    // by then, and so the run's cost is readable against what it ran on.
    const model = resolveAgentModel(this.deps.agentModels, action.rule);
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
        // What kind of work this is, and which checks it answers — recorded on
        // the task because a decision row carries the rule but nothing links it
        // to the agent, so it can say a rule fired and never what that cost.
        rule: action.rule,
        ciChecks: action.ciChecks ?? null,
        model,
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
      model,
    });
  }

  /**
   * The directory the agent will run in: the branch's worktree for code, a
   * per-task scratch directory for desk.
   *
   * Split from {@link ActionExecutor.recordDispatchTask} so the two steps a
   * dispatch can fail at — writing the row, and preparing the place — are
   * separately observable at the one call site. That is what lets the caller hold
   * the created task and settle it when this throws; a single method that did both
   * has nothing to hand back on the failing path, which is how a transient
   * `ensure` failure (an `EBUSY` rmdir on Windows) left a live `queued` row
   * wedging its origin and branch for good.
   */
  private async workingDirectory(
    task: Task,
    action: ValidatedAction & { type: 'dispatch_code_agent' | 'dispatch_desk_agent' },
  ): Promise<string> {
    // A stacked plan part names the branch it forks from; everything else takes
    // the configured integration branch.
    if (action.type === 'dispatch_code_agent')
      return this.deps.worktrees.ensure(action.branch, action.base ?? this.deps.defaultBranch);
    const cwd = resolve(this.deps.deskRoot, task.id);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }
}

/**
 * The previous agent's "there is more to do here" note, for an issue being
 * dispatched again — or null when there is none to carry.
 *
 * Only ever the **agent's own** verdict, and only `more_work`. A `done` verdict
 * reaching a dispatched agent would be nonsense (nothing should have dispatched),
 * and an *operator's* `more_work` toggle deliberately carries no note into the
 * prompt: the operator has the cockpit, the tracker and the job queue to say what
 * they want done, whereas this channel exists because an agent has nowhere else
 * to leave a handover.
 */
/**
 * The images attached to the goal being dispatched for — or null when there are
 * none, which is every dispatch that did not come from a blueprint carrying one.
 *
 * In the executor, and for the branch gate's reason: every dispatch passes
 * through here whatever composed it.
 *
 * **The lookup is by goal, not by exact origin** (issue #249). Once a blueprint
 * has been filed as a ticket its images are keyed `issue:<n>`, while the agents
 * that go on to work it are dispatched for `issue:<n>:plan`, `:assay`, `:assess`,
 * `:part:<slug>` and `:retro`. An exact match would put the screenshot in front of
 * the filing agent alone — the one agent that writes no code — so the whole point
 * of the ticket surviving would be lost. `padOriginFor` is the harness's own
 * spelling of "which goal is this origin inside", already used to decide who
 * shares a scratchpad, so the answer here and there cannot drift; an origin
 * outside any issue subtree (a `job:<id>` blueprint that dispatched directly)
 * falls back to itself, which is an exact match.
 *
 * The scoping is deliberately unconditional within a goal: a part agent working
 * something the screenshot has nothing to do with is still shown it. That is the
 * same trade the prior-work briefing already makes, and the alternative — guessing
 * which part an image is "about" — is a guess the harness has no basis for.
 */
function attachmentsFor(originRef: string | null | undefined, store: Store): string | null {
  if (!originRef) return null;
  return attachmentsNote(store.listAttachments(padOriginFor(originRef) ?? originRef)) || null;
}

function outstandingForOrigin(originRef: string | null | undefined, store: Store): string | null {
  if (!originRef) return null;
  const stored = store.getIssueConclusion(originRef);
  if (!stored || stored.verdict !== 'more_work' || stored.by !== 'agent') return null;
  return outstandingWorkNote(stored.note, stored.updatedAt);
}

/**
 * The rows behind {@link priorWorkBriefing}, gathered for the goal this dispatch
 * belongs to — or null for every dispatch that is not on one.
 *
 * **Scoped by `padOriginFor`, not by a fresh predicate.** That is already the
 * harness's answer to "which goal is this agent working", written for the pad and
 * asked here for the same population: the `issue:<n>` root plus its `:plan`,
 * `:assay`, `:assess` and `:part:<slug>` arms. Everything else — a PR concern, a
 * job, a filing — resolves to null and is handed nothing, which is
 * `outstandingForOrigin`'s widening rule at the level of a whole goal: an agent
 * fixing CI on `pr:42` has no use for a planner's write-up about `issue:12` and
 * cannot tell it apart from its own task.
 *
 * **The retro origin is excluded**, though `padOriginFor` accepts it: a
 * retrospective is handed the pad and the whole dossier by {@link retroBriefing},
 * and would otherwise read its own goal's testimony twice in one prompt.
 *
 * In the executor, and for the branch gate's reason: every dispatch passes through
 * here whatever composed it, an accepted proposal's included.
 */
function priorWorkFor(originRef: string | null | undefined, store: Store, outstandingShown: boolean): string | null {
  const ref = originRef ?? '';
  const issueOriginRef = padOriginFor(ref);
  if (!issueOriginRef) return null;
  if (retroSubmitOrigin(ref).ok) return null;
  const plan = store.getPlanByOrigin(issueOriginRef);
  const briefing = priorWorkBriefing({
    plan,
    parts: plan ? store.listPlanParts(plan.id) : [],
    assay: store.getAssay(issueOriginRef),
    conclusion: outstandingShown ? null : store.getIssueConclusion(issueOriginRef),
    delivery: store.getDelivery(issueOriginRef),
    shortfall: store.getShortfall(issueOriginRef),
    entries: store.listScratchEntries(issueOriginRef),
    forPart: /^issue:\d+:part:/.test(ref),
  });
  return briefing || null;
}

/**
 * Everything a retrospective agent is given beyond its prompt: the issue's
 * scratchpad, then the record the harness kept — or null for every other dispatch.
 *
 * It lives in the executor for the branch gate's reason: every dispatch passes
 * through here, so nothing can route around it. Keyed on the **exact** retro
 * origin, because this is a briefing about one finished goal and putting a whole
 * run's audit trail in front of an agent dispatched to fix CI is the widening
 * mistake `outstandingForOrigin` names.
 *
 * The lists are read here rather than threaded through the action: the action is
 * validated data and this is a page of prose assembled at dispatch time, which is
 * also why it is appended to the rendered prompt rather than interpolated into it.
 */
function actionOrigin(action: Action): string | null {
  const ref = (action as { originRef?: unknown }).originRef;
  return typeof ref === 'string' ? ref : null;
}

function retroBriefing(originRef: string | null | undefined, store: Store): string | null {
  const target = originRef ? retroSubmitOrigin(originRef) : { ok: false as const, error: '' };
  if (!target.ok) return null;
  const issueOriginRef = target.issueOrigin;
  const issueNumber = Number(issueOriginRef.slice('issue:'.length));
  const world = store.getWorldBaseline();
  const issue = world?.issues.find((i) => i.number === issueNumber) ?? null;
  const plan = store.getPlanByOrigin(issueOriginRef);
  const parts = plan ? store.listPlanParts(plan.id) : [];
  const prNumbers = new Set<number>(parts.flatMap((p) => (p.prNumber === null ? [] : [p.prNumber])));
  if (issue?.linkedPrNumber) prNumbers.add(issue.linkedPrNumber);
  // The issue's own subtree — the predicate every gate in the dispatcher keys on.
  const mine = (ref: string | null | undefined): boolean =>
    ref === issueOriginRef || (ref?.startsWith(`${issueOriginRef}:`) ?? false);
  const tasks = store.listTasks().filter((t) => mine(t.originRef));
  const taskIds = new Set(tasks.map((t) => t.id));
  const agents = store.listAgents().filter((a) => taskIds.has(a.taskId));

  const dossier = retroDossier({
    issueNumber,
    issueTitle: issue?.title ?? issueOriginRef,
    plan,
    parts,
    pullRequests: (world?.pullRequests ?? []).filter((pr) => prNumbers.has(pr.number)),
    closedPullRequests: (world?.closedPullRequests ?? []).filter((pr) => prNumbers.has(pr.number)),
    decisions: store
      .listDecisions()
      .filter((d) => mine(actionOrigin(d.action)))
      .reverse(),
    escalations: store.listEscalations().filter((e) => (e.taskId ? taskIds.has(e.taskId) : false)),
    proposals: store.listProposals().filter((p) => mine(p.ref)),
    findings: store.listFindings().filter((f) => mine(f.originRef)),
    agentCount: agents.length,
    delivery: store.getDelivery(issueOriginRef),
    shortfall: store.getShortfall(issueOriginRef),
    assay: store.getAssay(issueOriginRef),
    conclusion: store.getIssueConclusion(issueOriginRef),
    // Null rather than 0 when nothing was reported: PTY mode reports no usage at
    // all, and a confident "$0.00" is the one reading that would be a lie.
    costUsd: agents.some((a) => a.costUsd !== null) ? agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) : null,
  });
  return [padTestimony(store.listScratchEntries(issueOriginRef)), dossier].filter(Boolean).join('\n\n');
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
