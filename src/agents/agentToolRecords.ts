import { EventEmitter } from 'node:events';
import { issueSubtreeNumber } from '../issueOrigins.js';
import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { WhitelistRule } from '../config/config.js';
import type {
  Agent,
  AgentAsk,
  AgentFlag,
  AgentStatus,
  AgentUsage,
  BugFiling,
  ExtraMcpServer,
  FeatureSequenceEdge,
  HumanTask,
  HumanTaskInput,
  IssueConclusion,
  PadDecision,
  PlanPart,
  PrReviewThread,
  PrThreadLabel,
  Remedy,
  ScratchEntry,
  Task,
} from '../types.js';
import type { AssessmentVerdict } from '../mcp/assessment.js';
import type { GoalAppraisalVerdictName } from '../mcp/goalAppraisal.js';
import { padWriteTarget } from '../scratch/pad.js';
import { retroSubmitOrigin } from '../retro/retro.js';
import { featureSummarySubmitOrigin, type FeatureSummaryInput } from '../summaries/featureSummary.js';
import { featureSequenceSubmitOrigin, resequenceVerdict } from '../sequence/sequence.js';
import { remedyOrigin, type RemedySubmission } from '../remedies/remedies.js';
import type { ReviewThreadLabelSubmission } from '../reviewLabels/labels.js';
import { threadStamped } from '../review/prReviewState.js';
import type { PrReviewPolicy } from '../review/policy.js';
import type { FileEventsSpool } from './fileEvents.js';
import type { WatchDryRunner } from '../environments/watchDryRun.js';
import type { SessionFactory } from './session.js';
import type { AgentToolTarget } from '../mcp/tools/context.js';

// → docs/spec/10-agent-runtimes.md

type LinkTicketResult = { ok: true; bug: BugFiling } | { ok: false; error: string };

type FilingTargetResult = { ok: true; kind: 'bug'; storyNumber: number | null } | { ok: false; error: string };

interface McpChannel {
  open(extra?: readonly ExtraMcpServer[]): { token: string; configPath: string | null };
  bind(token: string, agentId: string): void;
  release(token: string): void;
}

export interface AgentManagerOptions {
  command: string;
  buildArgs: (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    extraAllowedTools: string[];
    model: string | null;
    effort: string | null;
    permissionMode: string | null;
    sealed: boolean;
  }) => string[];
  goalProfile?: {
    effective: (issueOrigin: string) => string | null;
  };
  featureStanding?: (featureOrigin: string) => string | null;
  featureSequenceStanding?: (featureOrigin: string) => { key: string; members: number[] } | null;
  whitelistedApprovals: WhitelistRule[];
  reviewPolicy?: PrReviewPolicy;
  createSession: SessionFactory;
  initialInput?: (task: Task) => string | null;
  resumeInput?: () => string | null;
  promptDelayMs?: number;
  waitingPatterns?: string[];
  stallNudges?: number;
  stallParkMs?: number;
  stallExtendMs?: number;
  silenceParkMs?: number;
  resumable?: boolean;
  resumeAttempts?: number;
  fileEvents?: FileEventsSpool;
  docsFolderPrefix?: string | string[];
  mcp?: McpChannel;
  watch?: WatchDryRunner;
  errors?: ErrorRecorder;
}

export type TerminalBy = 'agent' | 'operator' | 'expiry';

interface AgentManagerEvents {
  output: [{ agentId: string; delta: string }];
  waiting: [{ agentId: string; taskId: string; reason: string; ask?: AgentAsk }];
  autoAnswered: [{ agentId: string; taskId: string; reason: string; response: string }];
  done: [{ agentId: string; taskId: string; status: AgentStatus; by: TerminalBy }];
  reaped: [{ agentId: string; taskId: string; status: 'done' | 'failed' | 'killed' }];
  status: [{ agentId: string; taskId: string; status: AgentStatus }];
  usage: [{ agentId: string; taskId: string; usage: AgentUsage }];
  flag: [{ agentId: string; taskId: string; flag: AgentFlag }];
  humanTask: [{ agentId: string; taskId: string; humanTask: HumanTask; created: boolean }];
  progress: [{ agentId: string; taskId: string; note: string; notedAt: string }];
  conclusion: [{ agentId: string; taskId: string; conclusion: IssueConclusion }];
  assessment: [{ agentId: string; taskId: string; issueOrigin: string; verdict: AssessmentVerdict }];
  appraisal: [{ agentId: string; taskId: string; issueOrigin: string; verdict: GoalAppraisalVerdictName }];
  goalMet: [{ agentId: string; taskId: string; issueOrigin: string }];
  partOutcome: [{ agentId: string; taskId: string; part: PlanPart }];
  scratch: [{ agentId: string; taskId: string; entry: ScratchEntry }];
  retrospective: [{ agentId: string; taskId: string; issueOrigin: string }];
  remedy: [{ agentId: string; taskId: string; originRef: string }];
  files: [{ agentId: string; taskId: string }];
  resumed: [{ agentId: string; taskId: string; resumedAt: string }];
  limited: [{ agentId: string; taskId: string; reason: string; resetsAt: string | null }];
}

export class AgentToolRecords
  extends EventEmitter
  implements
    Pick<
      AgentToolTarget,
      | 'requestHumanTask'
      | 'filingTarget'
      | 'linkTicket'
      | 'recordProgress'
      | 'appendScratch'
      | 'readScratch'
      | 'recordRetrospective'
      | 'recordFeatureSummary'
      | 'recordFeatureSequence'
      | 'recordRemedy'
      | 'recordThreadLabel'
    >
{
  constructor(
    protected readonly store: Store,
    protected readonly opts: AgentManagerOptions,
  ) {
    super();
  }

  protected withCaller<R extends { ok: true } | { ok: false; error: string }>(
    agentId: string,
    fn: (caller: { agent: Agent; task: Task }) => R,
  ): R | { ok: false; error: string } {
    const agent = this.store.agents.getAgent(agentId);
    const task = agent ? this.store.tasks.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    return fn({ agent, task });
  }

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
      this.emit('humanTask', { agentId, taskId: task.id, humanTask, created });
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
      this.emit('progress', { agentId, taskId: task.id, note, notedAt });
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
      this.emit('scratch', { agentId, taskId: task.id, entry });
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
      this.emit('retrospective', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin });
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
      this.emit('remedy', { agentId, taskId: task.id, originRef: scope.originRef });
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

  override emit<K extends keyof AgentManagerEvents>(event: K, ...args: AgentManagerEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof AgentManagerEvents>(event: K, listener: (...args: AgentManagerEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
