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
import { readyingBreakdown, type ReadyingBoard, type ReadyingHold } from './readying.js';
import type { DispatchResult } from '../dispatcher/dispatcher.js';
import {
  authorityOf,
  mergeProposalRef,
  proposalHold,
  reaskContext,
  readProposedAct,
  replyProposalRef,
} from '../proposals/proposals.js';
import type { CiEvidenceReader } from '../ci/ciEvidence.js';
import { retryResumeFor, type RetryResume } from './retryResume.js';
import { handoverResumeFor, type HandoverResume } from './handoverResume.js';
import { isActiveTask } from '../tasks.js';
import type { Action, CheckDecline, DecisionOutcome, Proposal, ProposalKind, Task } from '../types.js';
import type { FeatureBoardFacts } from '../featureSummaries/featureRecord.js';
import { ciEvidenceFor, dispatchPrompt, type DispatchAction } from './dispatchBriefing.js';
import {
  proposePlan,
  proposePlanAmendment,
  proposeShortfall,
  proposeValidationPlan,
  rejectionSignals,
  type RecordOutcome,
} from './proposalActs.js';
import { requeueCiCheck, setWorkItemState, updatePrBranch } from './providerActs.js';
import { sendAuthorized, settleAuthorized } from './authorizedActs.js';

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
  agentPermissionMode?: string;
  deskRoot: string;
  defaultBranch: string;
  runtime: RuntimeControl;
  errors: ErrorRecorder;
  ciEvidence?: CiEvidenceReader;
  instructionTracker?: (issueNumber: number) => string | null;
  featureBoard?: () => FeatureBoardFacts | null;
}

export interface ExecutionSummary {
  cycleId: string;
  executed: number;
  deferred: number;
  rejected: number;
}

interface AdmissionRefusal {
  outcome: 'skipped' | 'deferred';
  detail: string;
}

interface ActionRun {
  cycleId: string;
  hold: ReadyingHold;
  live: { count: number };
  record: RecordOutcome;
  tally: (outcome: DecisionOutcome) => void;
}

export class ActionExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(cycleId: string, plan: DispatchResult): Promise<ExecutionSummary> {
    const { store } = this.deps;
    const summary: ExecutionSummary = { cycleId, executed: 0, deferred: 0, rejected: 0 };

    for (const bad of plan.rejected) {
      store.decisions.recordDecision({
        cycleId,
        action: { type: 'no_op', reason: 'rejected malformed action' } as Action,
        outcome: 'rejected',
        detail: `Rejected: ${bad.error} — raw: ${safeJson(bad.raw)}`,
      });
      summary.rejected += 1;
    }

    const live = { count: store.agents.countLiveAgents() };

    for (const action of plan.actions) {
      const tally = (outcome: DecisionOutcome): void => {
        if (outcome === 'executed') summary.executed += 1;
        else if (outcome === 'deferred') summary.deferred += 1;
        else if (outcome === 'rejected') summary.rejected += 1;
      };
      const record = (outcome: DecisionOutcome, detail: string): void => {
        store.decisions.recordDecision({ cycleId, action: action as unknown as Action, outcome, detail });
        tally(outcome);
      };

      const hold = this.deps.readying.pickUp({
        cycleId,
        title: readyingTitle(action),
        originRef: 'originRef' in action ? action.originRef : null,
        branch: action.type === 'dispatch_code_agent' ? action.branch : null,
      });
      try {
        await this.perform(action, { cycleId, hold, live, record, tally });
      } finally {
        hold.release();
      }
    }

    return summary;
  }

  private async perform(action: ValidatedAction, run: ActionRun): Promise<void> {
    switch (action.type) {
      case 'dispatch_code_agent':
      case 'dispatch_desk_agent':
        return this.dispatchAgent(action, run);
      case 'escalate_to_human':
        return this.escalate(action, run);
      case 'respond_to_agent':
        return this.respondToAgent(action, run);
      case 'reply_on_pr':
      case 'merge_pr':
        return this.sendOutbound(action, run);
      case 'propose_plan':
        return proposePlan(this.deps, action, run.record);
      case 'propose_validation_plan':
        return proposeValidationPlan(this.deps, action, run.record);
      case 'propose_plan_amendment':
        return proposePlanAmendment(this.deps, action, run.record);
      case 'propose_shortfall':
        return proposeShortfall(this.deps, action, run.record);
      case 'update_pr_branch':
        return updatePrBranch(this.deps, action, run.record);
      case 'requeue_ci_check':
        return requeueCiCheck(this.deps, action, run.record);
      case 'set_work_item_state':
        return setWorkItemState(this.deps, action, run.record);
      case 'no_op':
        return run.record('executed', `No-op: ${action.reason}`);
    }
  }

  private async dispatchAgent(action: DispatchAction, run: ActionRun): Promise<void> {
    const { store } = this.deps;
    const { hold, live, record } = run;
    const refusal = this.admissionRefusal(action, live.count);
    if (refusal) {
      record(refusal.outcome, refusal.detail);
      return;
    }
    let task: Task | null = null;
    let evidence = '';
    let retry: RetryResume | null = null;
    try {
      hold.at('ci-evidence');
      evidence = action.type === 'dispatch_code_agent' ? await ciEvidenceFor(this.deps, action) : '';
      retry = retryResumeFor(action.originRef, store);
      const { slot, inherit, handover } = await this.inheritedSession(action, retry, hold);
      task = this.recordDispatchTask(action, evidence, retry, inherit === null ? null : handover);
      const cwd = slot ?? this.deskScratch(task);
      const agent = this.deps.agents.spawn(task, cwd, inherit);
      const resumed = inherit !== null && agent.sessionId === inherit;
      live.count += 1;
      this.markDispatched(action, task.id);
      const kind = action.type === 'dispatch_code_agent' ? 'code' : 'desk';
      record('executed', spawnDetail(kind, task.id, cwd, resumed, handover) + readyingBreakdown(hold.timings()));
    } catch (err) {
      this.abandonUnstarted(task ?? this.recordDispatchTask(action, evidence, retry, null));
      record('rejected', `Failed to start agent: ${(err as Error).message}${readyingBreakdown(hold.timings())}`);
    }
  }

  private admissionRefusal(action: DispatchAction, liveCount: number): AdmissionRefusal | null {
    const { store, runtime } = this.deps;
    const origin = action.originRef;
    if (origin && (store.tasks.findActiveTaskByOrigin(origin) || store.jobs.findStandingJobByOrigin(origin)))
      return { outcome: 'skipped', detail: `Skipped: work for ${origin} is already in flight.` };
    if (origin && store.ejections.liveEjectionForOrigin(origin))
      return { outcome: 'skipped', detail: `Skipped: an operator holds ${origin} at their own keyboard.` };
    const branchHeld = action.type === 'dispatch_code_agent' ? this.branchRefusal(action.branch) : null;
    if (branchHeld) return branchHeld;
    if (runtime.paused)
      return { outcome: 'deferred', detail: `Deferred: dispatch is paused; will retry when resumed.` };
    if (liveCount >= runtime.cap)
      return {
        outcome: 'deferred',
        detail: `Deferred: concurrency cap ${runtime.cap} reached; will retry next cycle.`,
      };
    return null;
  }

  private branchRefusal(branch: string): AdmissionRefusal | null {
    const { store } = this.deps;
    const ejected = store.ejections.ejectionOnBranch(branch);
    if (ejected)
      return {
        outcome: 'deferred',
        detail:
          `Deferred: branch ${branch} is held by an ejection (${ejected.id}); an operator has its ` +
          'worktree at their own keyboard. Will retry when they hand it back.',
      };
    const held = store.tasks.findActiveTaskByBranch(branch);
    if (held)
      return {
        outcome: 'deferred',
        detail:
          `Deferred: branch ${branch} is held by active task ${held.id}` +
          `${held.originRef ? ` (${held.originRef})` : ''}; a second agent would share its worktree. Will retry when it frees.`,
      };
    return null;
  }

  private async inheritedSession(
    action: DispatchAction,
    retry: RetryResume | null,
    hold: ReadyingHold,
  ): Promise<{ slot: string | null; inherit: string | null; handover: HandoverResume | null }> {
    const { store } = this.deps;
    const handover =
      action.type === 'dispatch_code_agent' && retry === null
        ? handoverResumeFor(action.originRef, store, store.world.getWorldBaseline()?.issues ?? [])
        : null;
    hold.at('slot-handover');
    const slot =
      action.type === 'dispatch_code_agent' ? await this.codeWorkingDirectory(action) : (retry?.previous.cwd ?? null);
    const inherit = retry
      ? slot !== null && retry.previous.cwd === slot
        ? retry.previous.sessionId
        : null
      : handover !== null && handover.previous.cwd === slot
        ? handover.previous.sessionId
        : null;
    return { slot, inherit, handover };
  }

  private markDispatched(action: DispatchAction, taskId: string): void {
    const { store } = this.deps;
    if (action.jobId) store.jobs.markJobDispatched(action.jobId, taskId);
    if (action.type !== 'dispatch_code_agent') return;
    if (action.partId) store.plans.markPartDispatched(action.partId, taskId, action.branch);
    if (action.localValidation) {
      if (action.localValidation.as === 'fix')
        store.localValidations.markLocalValidationFix(action.localValidation.id, taskId);
      else store.localValidations.markLocalValidationDispatched(action.localValidation.id, taskId);
    }
    // One agent per run, across a restart: the conditional `WHERE status = 'pending'` is
    // the store's own and never a check made here first.
    if (action.remoteRun) store.remoteValidation.claimRemoteRun(action.remoteRun.id, taskId);
  }

  private escalate(action: ValidatedAction & { type: 'escalate_to_human' }, run: ActionRun): void {
    const { record } = run;
    const esc = this.deps.escalations.create({
      type: action.escalationType,
      prompt: action.prompt,
      context: action.context,
      taskId: action.taskId,
      agentId: action.agentId,
    });
    record('executed', `Escalated to human: ${esc.id} (${action.escalationType}).`);
  }

  private respondToAgent(action: ValidatedAction & { type: 'respond_to_agent' }, run: ActionRun): void {
    const { record } = run;
    const ok = this.deps.agents.respond(action.agentId, action.response);
    record(
      ok ? 'executed' : 'skipped',
      ok ? `Typed response into agent ${action.agentId}.` : `Agent ${action.agentId} not live; nothing typed.`,
    );
  }

  private async sendOutbound(
    action: ValidatedAction & { type: 'reply_on_pr' | 'merge_pr' },
    run: ActionRun,
  ): Promise<void> {
    const { cycleId, hold, record, tally } = run;
    hold.at('authorizing');
    const outbound = await this.authorize(cycleId, action);
    if (outbound.recorded) tally(outbound.outcome);
    else record(outbound.outcome, outbound.detail);
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

    const proposals = store.escalations.listProposals();
    const signals = rejectionSignals(store, proposals);
    const heldBy = proposalHold(kind, ref, proposals, { rejectionSignals: signals });
    if (heldBy) return { outcome: 'skipped', detail: `Skipped ${subject}: ${heldBy}.`, recorded: false };

    const landing = merge ? store.landings.standingLandingForPr(action.prNumber) : null;

    const autoSend = !merge && (this.deps.autoSendReplies?.() ?? false);

    if (landing || autoSend) {
      const proposal = store.escalations.createProposal({
        kind,
        ref,
        action: action as unknown as Action,
        escalationId: null,
      });
      const note = landing
        ? `you authorized landing ${landing.ref} (${landing.rungs.length} pull requests) on ${landing.createdAt}`
        : 'you set "sendPrRepliesWithoutApproval", which sends a drafted reply without asking';
      const accepted =
        store.escalations.decideProposal(proposal.id, 'accepted', note, landing ? 'stack_landing' : 'auto_send') ??
        proposal;
      const run = await this.runAuthorized(accepted, cycleId);
      return { ...run, recorded: true };
    }

    const again = reaskContext(kind, ref, proposals, { rejectionSignals: signals });
    return { ...this.proposeOutbound(action, kind, ref, again ? `${again}\n\n` : ''), recorded: false };
  }

  private proposeOutbound(
    action: ValidatedAction & { type: 'reply_on_pr' | 'merge_pr' },
    kind: ProposalKind,
    ref: string,
    preamble: string,
  ): { outcome: DecisionOutcome; detail: string } {
    const esc = this.deps.escalations.create(
      action.type === 'merge_pr'
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
    const proposal = this.deps.store.escalations.createProposal({
      kind,
      ref,
      action: action as unknown as Action,
      escalationId: esc.id,
    });
    return {
      outcome: 'executed',
      detail:
        action.type === 'merge_pr'
          ? `PR #${action.prNumber} is merge-ready; proposed the merge for approval: ${esc.id} / ${proposal.id}. Accepting merges it.`
          : `Drafted PR reply and proposed it for approval: ${esc.id} / ${proposal.id}. Accepting sends it.`,
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
      this.deps.store.decisions.recordDecision({
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
    /**
     * The rows the operator struck out of the set they are accepting, carried here rather than read
     * off the proposal because they are the operator's answer and not part of what was asked. Only
     * a `validation_plan` has any. → docs/spec/20-validation.md#declining-a-single-row
     */
    declined: readonly CheckDecline[] = [],
  ): Promise<{ outcome: DecisionOutcome; detail: string }> {
    const { store } = this.deps;
    const authority = authorityOf(proposal, pulseCycleId ?? null);
    const audit = (outcome: DecisionOutcome, detail: string): { outcome: DecisionOutcome; detail: string } => {
      store.decisions.recordDecision({ cycleId: authority.cycleId, action: proposal.action, outcome, detail });
      return { outcome, detail };
    };

    const read = readProposedAct(proposal);
    if (!read.ok) return audit('rejected', `Cannot run the accepted proposal: ${read.error}.`);
    const act = read.act;
    if (act.kind === 'merge' || act.kind === 'reply_draft') {
      const sent = await sendAuthorized(this.deps, act, proposal, authority);
      return audit(sent.outcome, sent.detail);
    }
    const settled = settleAuthorized(store, act, proposal, authority.by, declined);
    return audit(settled.outcome, settled.detail);
  }

  private abandonUnstarted(task: Task): void {
    const current = this.deps.store.tasks.getTask(task.id);
    if (current && isActiveTask(current)) this.deps.store.tasks.updateTask(task.id, { status: 'interrupted' });
    if (!task.branch) return;
    const failed = `releasing ${task.branch} after a failed dispatch: `;
    void this.deps.worktrees
      .remove(task.branch)
      .catch((err: unknown) => this.deps.errors.record({ source: 'cycle', message: failed + (err as Error).message }));
  }

  private recordDispatchTask(
    action: DispatchAction,
    evidence: string,
    retry: RetryResume | null,
    handover: HandoverResume | null,
  ): Task {
    const { store } = this.deps;
    const prompt = dispatchPrompt(this.deps, action, evidence, retry, handover);
    const common = {
      title: action.title,
      prompt,
      originRef: action.originRef,
      originTitle: action.originTitle,
      originSummary: action.originSummary,
      dispatchReason: action.reason,
      rule: action.rule,
      ...this.profileFields(action),
    };
    if (action.type === 'dispatch_code_agent')
      return store.tasks.createTask({
        kind: 'code',
        ...common,
        branch: action.branch,
        ciChecks: action.ciChecks ?? null,
        mcpServers: action.mcpServers?.length ? action.mcpServers : null,
      });
    return store.tasks.createTask({ kind: 'desk', ...common, branch: null });
  }

  private profileFields(action: DispatchAction) {
    const profile = resolveAgentProfile(this.deps.agentModels, action.rule, action.profile);
    return {
      model: profile?.model ?? null,
      effort: profile?.effort ?? null,
      permissionMode: profile?.permissionMode ?? this.deps.agentPermissionMode ?? null,
      permissionAutoApprove: profile?.autoApprove ?? false,
      profile: profile?.name ?? null,
      profileSource: profile?.source ?? null,
    };
  }

  private codeWorkingDirectory(action: ValidatedAction & { type: 'dispatch_code_agent' }): Promise<string> {
    const at = action.base ?? this.deps.defaultBranch;
    return action.readOnly
      ? this.deps.worktrees.ensureReadOnly(action.branch, at)
      : this.deps.worktrees.ensure(action.branch, at);
  }

  private deskScratch(task: Task): string {
    const cwd = resolve(this.deps.deskRoot, task.id);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }
}

function spawnDetail(
  kind: 'code' | 'desk',
  taskId: string,
  cwd: string,
  resumed: boolean,
  handover: HandoverResume | null,
): string {
  if (!resumed) return `Spawned ${kind} agent for task ${taskId} in ${cwd}.`;
  return handover
    ? `Handed ${handover.from}'s conversation on to a ${kind} agent on task ${taskId} in ${cwd}.`
    : `Resumed the previous agent's conversation for a ${kind} agent on task ${taskId} in ${cwd}.`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
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
    case 'propose_validation_plan':
      return 'Putting a validation check set to you';
    case 'propose_plan_amendment':
      return 'Putting a change to a plan to you';
    case 'propose_shortfall':
      return 'Putting a shortfall to you';
    default:
      return action.type.replace(/_/g, ' ');
  }
}
