import { issueSubtreeNumber } from '../issueOrigins.js';
import type { Store } from '../store/store.js';
import type {
  Agent,
  AgentAsk,
  BugFiling,
  FeatureSequenceEdge,
  HumanTask,
  HumanTaskInput,
  PadDecision,
  PrReviewThread,
  PrThreadLabel,
  Remedy,
  ScratchEntry,
  Task,
} from '../types.js';
import { padWriteTarget } from '../scratch/pad.js';
import { retroSubmitOrigin } from '../retro/retro.js';
import { featureSummarySubmitOrigin, type FeatureSummaryInput } from '../featureSummaries/featureSummary.js';
import { featureSequenceSubmitOrigin, resequenceVerdict } from '../sequence/sequence.js';
import { remedyOrigin, type RemedySubmission } from '../remedies/remedies.js';
import type { ReviewThreadLabelSubmission } from '../review/threadLabels.js';
import { threadStamped } from '../review/prReviewState.js';
import type { AgentToolTarget } from '../mcp/tools/context.js';
import type { AgentEmitter, AgentManagerOptions } from './agentContract.js';
import * as verdicts from './agentVerdicts.js';

// → docs/spec/11-mcp-tools.md

type LinkTicketResult = { ok: true; bug: BugFiling } | { ok: false; error: string };

type FilingTargetResult = { ok: true; kind: 'bug'; storyNumber: number | null } | { ok: false; error: string };

type Caller = { agent: Agent; task: Task };

interface AskFleet {
  isLive(agentId: string): boolean;
  wait(agentId: string, task: Task, question: string, ask: AgentAsk): void;
}

export class AgentToolDesk implements AgentToolTarget {
  private readonly ctx: verdicts.VerdictContext;

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
    private readonly events: AgentEmitter,
    private readonly fleet: AskFleet,
  ) {
    this.ctx = { store, opts, events };
  }

  private withCaller<R extends { ok: true } | { ok: false; error: string }>(
    agentId: string,
    fn: (caller: Caller) => R,
  ): R | { ok: false; error: string } {
    const agent = this.store.agents.getAgent(agentId);
    const task = agent ? this.store.tasks.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    return fn({ agent, task });
  }

  forCaller<R extends { ok: true } | { ok: false; error: string }>(
    agentId: string,
    fn: (caller: Caller) => R,
  ): R | { ok: false; error: string } {
    return this.withCaller(agentId, fn);
  }

  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string } {
    if (!this.fleet.isLive(agentId)) return { ok: false, error: 'agent is no longer live' };
    return this.withCaller(agentId, ({ task }) => {
      const question = ask.question.trim();
      if (!question) return { ok: false, error: 'question must not be empty' };
      this.fleet.wait(agentId, task, question, ask);
      const open = this.store.escalations.listOpenEscalations().find((e) => e.agentId === agentId) ?? null;
      return { ok: true, escalationId: open?.id ?? null };
    });
  }

  readonly recordConclusion: AgentToolTarget['recordConclusion'] = (agentId, verdict, note) =>
    this.withCaller(agentId, ({ task }) => verdicts.recordConclusion(this.ctx, agentId, task, verdict, note));

  readonly recordBlocked: AgentToolTarget['recordBlocked'] = (agentId, obstacleId, note) =>
    this.withCaller(agentId, ({ task }) => verdicts.recordBlocked(this.ctx, agentId, task, obstacleId, note));

  readonly recordAssessment: AgentToolTarget['recordAssessment'] = (agentId, verdict, summary, detail, cause, part) =>
    this.withCaller(agentId, ({ task }) =>
      verdicts.recordAssessment(this.ctx, agentId, task, verdict, summary, detail, cause, part),
    );

  readonly recordGoalMet: AgentToolTarget['recordGoalMet'] = (agentId, summary, detail) =>
    this.withCaller(agentId, ({ task }) => verdicts.recordGoalMet(this.ctx, agentId, task, summary, detail));

  readonly recordAppraisal: AgentToolTarget['recordAppraisal'] = (agentId, verdict, summary, profile, placement) =>
    this.withCaller(agentId, ({ task }) =>
      verdicts.recordAppraisal(this.ctx, agentId, task, verdict, summary, profile, placement),
    );

  readonly recordPartOutcome: AgentToolTarget['recordPartOutcome'] = (agentId, kind, summary, ref) =>
    this.withCaller(agentId, ({ task }) => verdicts.recordPartOutcome(this.ctx, agentId, task, kind, summary, ref));

  requestHumanTask(
    agentId: string,
    input: HumanTaskInput,
  ): { ok: true; task: HumanTask } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const { task: humanTask, created } = this.store.humanTasks.recordHumanTask({
        ...input,
        agentId,
        taskId: task.id,
        originRef: task.originRef,
      });
      this.events.emit('humanTask', { agentId, taskId: task.id, humanTask, created });
      return { ok: true, task: humanTask };
    });
  }

  filingTarget(agentId: string): FilingTargetResult {
    return this.withCaller(agentId, ({ task }): FilingTargetResult => {
      const jobId = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
      const bug = jobId ? this.store.bugFilings.findBugFilingByJobId(jobId) : null;
      if (bug) {
        return { ok: true, kind: 'bug', storyNumber: issueSubtreeNumber(bug.originRef) };
      }
      return {
        ok: false,
        error:
          `link_ticket is only for a job dispatched to raise a bug an operator reported. This ` +
          `task's origin is ${task.originRef ?? '(none)'}, which was not created from one.`,
      };
    });
  }

  linkTicket(agentId: string, ticketRef: string): LinkTicketResult {
    return this.withCaller(agentId, ({ task }): LinkTicketResult => {
      const jobId = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
      const bug = jobId ? this.store.bugFilings.findBugFilingByJobId(jobId) : null;
      if (!bug) {
        return {
          ok: false,
          error:
            `link_ticket is only for a job dispatched to raise a bug an operator reported. This ` +
            `task's origin is ${task.originRef ?? '(none)'}, which was not created from one.`,
        };
      }
      if (!ticketRef.startsWith('issue:')) {
        return { ok: false, error: `A bug must be an issue ref like "issue:314"; got "${ticketRef}".` };
      }
      const linked = this.store.bugFilings.linkBugFiling(bug.jobId, ticketRef);
      if (!linked) {
        return {
          ok: false,
          error: `the bug raised on ${bug.originRef} is ${bug.status}, not awaiting a ticket — nothing to link.`,
        };
      }
      return { ok: true, bug: linked };
    });
  }

  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const notedAt = this.store.agents.recordAgentNote(agentId, note);
      this.events.emit('progress', { agentId, taskId: task.id, note, notedAt });
      return { ok: true, notedAt };
    });
  }

  appendScratch(
    agentId: string,
    note: string,
    topic: string | null,
    decision: PadDecision | null,
  ): { ok: true; entry: ScratchEntry } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const target = padWriteTarget(task.originRef);
      if (!target.ok) return { ok: false, error: target.error };
      const entry = this.store.scratch.appendScratchEntry({
        padRef: target.padRef,
        authorOriginRef: task.originRef ?? target.padRef,
        agentId,
        taskId: task.id,
        topic,
        note,
        decision,
      });
      this.events.emit('scratch', { agentId, taskId: task.id, entry });
      return { ok: true, entry };
    });
  }

  readScratch(agentId: string): { ok: true; padRef: string; entries: ScratchEntry[] } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const target = padWriteTarget(task.originRef);
      if (!target.ok) return { ok: false, error: target.error };
      return { ok: true, padRef: target.padRef, entries: this.store.scratch.listScratchEntries(target.padRef) };
    });
  }

  recordRetrospective(
    agentId: string,
    summary: string,
    document: string,
  ): { ok: true; issueOrigin: string } | { ok: false; error: string } {
    return this.withCaller(agentId, (caller) => {
      const { task } = caller;
      const origin = retroSubmitOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      this.store.scratch.recordRetrospective({
        originRef: origin.issueOrigin,
        summary,
        document,
        agentId,
        taskId: task.id,
      });
      this.events.emit('retrospective', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin });
      return { ok: true, issueOrigin: origin.issueOrigin };
    });
  }

  recordFeatureSummary(
    agentId: string,
    input: FeatureSummaryInput,
  ): { ok: true; featureOrigin: string } | { ok: false; error: string } {
    return this.withCaller(agentId, (caller) => {
      const { task } = caller;
      const origin = featureSummarySubmitOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      this.store.tickets.recordFeatureSummary({
        originRef: origin.featureOrigin,
        ...input,
        standingKey: this.opts.featureStanding?.(origin.featureOrigin) ?? '',
        agentId,
        taskId: task.id,
      });
      return { ok: true, featureOrigin: origin.featureOrigin };
    });
  }

  recordFeatureSequence(
    agentId: string,
    input: { reason: string; unsure: string | null; edges: FeatureSequenceEdge[] },
  ): { ok: true; featureOrigin: string; edges: number; carried: boolean } | { ok: false; error: string } {
    return this.withCaller(agentId, (caller) => {
      const { task } = caller;
      const origin = featureSequenceSubmitOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      const standing = this.opts.featureSequenceStanding?.(origin.featureOrigin) ?? null;
      const members = standing?.members ?? [];
      const previous = this.store.sequences.getFeatureSequence(origin.featureOrigin);
      const verdict = resequenceVerdict(previous, input.edges, members);
      this.store.sequences.recordFeatureSequence({
        originRef: origin.featureOrigin,
        status: verdict.carry ? 'accepted' : 'proposed',
        reason: input.reason,
        unsure: input.unsure,
        standingKey: standing?.key ?? '',
        edges: input.edges,
        members,
        agentId,
        taskId: task.id,
      });
      if (verdict.carry && previous?.answeredBy) {
        this.store.sequences.answerFeatureSequence(origin.featureOrigin, 'accepted', previous.answeredBy);
      }
      return {
        ok: true,
        featureOrigin: origin.featureOrigin,
        edges: input.edges.length,
        carried: verdict.carry,
      };
    });
  }

  recordRemedy(
    agentId: string,
    submission: RemedySubmission,
  ): { ok: true; remedy: Remedy } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const scope = remedyOrigin(task.originRef);
      if (!scope.ok) return { ok: false, error: scope.error };
      const remedy = this.store.remedies.recordRemedy({
        kind: scope.kind,
        originRef: scope.originRef,
        prNumber: scope.prNumber,
        cause: submission.cause,
        guard: submission.guard,
        summary: submission.summary,
        checks: task.ciChecks ?? [],
        agentId,
        taskId: task.id,
      });
      this.events.emit('remedy', { agentId, taskId: task.id, originRef: scope.originRef });
      return { ok: true, remedy };
    });
  }

  recordThreadLabel(
    agentId: string,
    input: ReviewThreadLabelSubmission,
  ): { ok: true; label: PrThreadLabel } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const thread = this.findReviewThread(input.prNumber, input.threadId);
      const label = this.store.prThreadLabels.recordThreadLabel({
        prNumber: input.prNumber,
        threadId: input.threadId,
        aboutComment: input.aboutComment,
        changedCode: input.changedCode,
        resolved: input.resolved,
        path: thread?.path ?? null,
        author: thread?.author ?? null,
        authorIsBot: this.threadAuthorIsMachine(thread),
        agentId,
        taskId: task.id,
      });
      return { ok: true, label };
    });
  }

  /**
   * The two sources that are facts at observation time, folded into one. The provider's own word
   * first; then the stamp the project declared, which is the only thing that sees a poster the
   * provider reports as an ordinary user. Null is "neither said" — never "a person".
   */
  private threadAuthorIsMachine(thread: PrReviewThread | null): boolean | null {
    if (thread === null) return null;
    if (thread.authorIsBot !== undefined) return thread.authorIsBot;
    const policy = this.opts.reviewPolicy;
    if (policy !== undefined && threadStamped(thread, policy)) return true;
    return null;
  }

  private findReviewThread(prNumber: number, threadId: string): PrReviewThread | null {
    const world = this.store.world.getWorldBaseline();
    if (world === null) return null;
    const pr =
      world.pullRequests.find((p) => p.number === prNumber) ??
      (world.closedPullRequests ?? []).find((p) => p.number === prNumber);
    return pr?.reviewThreads?.find((t) => t.id === threadId) ?? null;
  }
}
