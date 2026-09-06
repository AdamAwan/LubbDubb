import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import { recentOutputExcerpt } from '../escalation/context.js';
import type { WhitelistRule } from '../config.js';
import type {
  AccountRateLimits,
  Agent,
  AgentAsk,
  AgentFlag,
  AgentStatus,
  AgentUsage,
  ExtraMcpServer,
  HumanTask,
  HumanTaskInput,
  IssueConclusion,
  IssueConclusionVerdict,
  ObstacleBlock,
  PartOutcomeKind,
  PlanPart,
  Remedy,
  PadDecision,
  ScratchEntry,
  ShortfallCause,
  StallPark,
  Task,
  BugFiling,
} from '../types.js';
import { extraMcpGrants } from '../mcp/names.js';

type LinkTicketResult = { ok: true; bug: BugFiling } | { ok: false; error: string };

type FilingTargetResult = { ok: true; kind: 'bug'; storyNumber: number | null } | { ok: false; error: string };
import { conclusionOrigin } from '../issueConclusion.js';
import { assessmentOrigin, type AssessmentVerdict } from '../mcp/assessment.js';
import { appraiserOrigin, type GoalAppraisalVerdictName } from '../mcp/goalAppraisal.js';
import { plannerOrigin } from '../mcp/planNotNeeded.js';
import { goalFingerprint } from '../intake/appraisal.js';
import { padWriteTarget } from '../scratch/pad.js';
import { retroSubmitOrigin } from '../retro/retro.js';
import { featureSummarySubmitOrigin, type FeatureSummaryInput } from '../summaries/featureSummary.js';
import { featureSequenceSubmitOrigin, resequenceVerdict } from '../sequence/sequence.js';
import type { FeatureSequenceEdge } from '../types.js';
import { remedyOrigin, type RemedySubmission } from '../remedies/remedies.js';
import { partConclusionOrigin } from '../mcp/partOutcome.js';
import type { AgentToolTarget } from '../mcp/tools/context.js';
import type { ParsedFlag } from './sentinels.js';
import { classifyArtifact, type FileEventRecord, type FileEventsSpool } from './fileEvents.js';
import { PLAN_FILE, isPlanFile, parsePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument } from '../plans/planIngest.js';
import type { WatchDryRunner } from '../environments/watchDryRun.js';
import { issueOrigin, planOriginIssue } from '../plans/planning.js';
import { liveParts } from '../plans/parts.js';
import type { AgentSession, SessionFactory } from './session.js';
import { STALL_NUDGE, silenceReason, stallReason } from './agentProtocol.js';
import { HUMAN_BLOCK, renderBlocks } from './streamTranscript.js';
import type { RateLimitPark } from './streamJsonSession.js';
import { debugEnabled, debugLog } from '../debug.js';

// → docs/spec/10-agent-runtimes.md

interface McpChannel {
  open(extra?: readonly ExtraMcpServer[]): { token: string; configPath: string | null };
  bind(token: string, agentId: string): void;
  release(token: string): void;
}

interface AgentManagerOptions {
  command: string;
  buildArgs: (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    extraAllowedTools: string[];
    model: string | null;
    effort: string | null;
  }) => string[];
  goalProfile?: {
    effective: (issueOrigin: string) => string | null;
  };
  featureStanding?: (featureOrigin: string) => string | null;
  featureSequenceStanding?: (featureOrigin: string) => { key: string; members: number[] } | null;
  whitelistedApprovals: WhitelistRule[];
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

interface LimitPark {
  reason: string;
  resetsAt: string | null;
}

interface StallClock {
  at: number;
  grace: number;
}

type TerminalBy = 'agent' | 'operator' | 'expiry';

export interface LimitResumeFailure {
  agentId: string;
  error: string;
}

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

export class AgentManager extends EventEmitter implements AgentToolTarget {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly exitCodes = new Map<string, number>();
  private readonly terminals = new Map<string, 'done' | 'failed' | 'killed'>();
  private readonly exited = new Set<string>();
  private readonly eventsKeys = new Map<string, string>();
  private readonly mcpTokens = new Map<string, string>();
  private readonly parked = new Set<string>();
  private readonly limited = new Map<string, LimitPark>();
  private readonly nudges = new Map<string, number>();
  private readonly stalled = new Map<string, StallClock>();

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
  ) {
    super();
  }

  spawn(task: Task, cwd: string, resumeSessionId?: string | null): Agent {
    const inherited = this.opts.resumable ? (resumeSessionId ?? null) : null;
    const sessionId = inherited ?? (this.opts.resumable ? randomUUID() : null);
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    const extraServers = task.mcpServers ?? [];
    const mcp = this.opts.mcp?.open(extraServers) ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: sessionId ?? '',
        extraAllowedTools: extraMcpGrants(extraServers),
        resume: inherited !== null,
        mcpConfigPath: mcp?.configPath ?? null,
        model: task.model ?? null,
        effort: task.effort ?? null,
      }),
      cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.eventsDirEnv(eventsKey),
      },
      waitingPatterns: this.opts.waitingPatterns,
      sessionId,
      resume: inherited !== null,
    });

    const agent = this.store.createAgent({ taskId: task.id, cwd, pid: null, status: 'starting', sessionId });
    if (eventsKey) this.eventsKeys.set(agent.id, eventsKey);
    if (mcp) {
      this.opts.mcp?.bind(mcp.token, agent.id);
      this.mcpTokens.set(agent.id, mcp.token);
    }
    debugLog(
      'agent',
      `spawn agent=${agent.id} cwd=${cwd} eventsDir=${this.fileEventsDir(agent.id) ?? '<file-events off>'}` +
        `${inherited ? ` resumed=${inherited}` : ''}`,
    );
    this.store.updateTask(task.id, { status: 'running', agentId: agent.id });
    this.sessions.set(agent.id, session);
    this.wireSession(session, agent.id, task);
    try {
      session.start();
    } catch (err) {
      this.failSpawn(agent.id, task.id, err as Error);
      throw err;
    }

    this.deliverAfterBoot(agent.id, session, this.opts.initialInput?.(task) ?? null);

    return agent;
  }

  resume(agent: Agent, task: Task, nudge?: string): boolean {
    if (!this.opts.resumable || !agent.sessionId) return false;
    if (this.sessions.has(agent.id)) return true;

    const wasWaiting = agent.status === 'waiting' || agent.waitingReason != null;
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    const extraServers = task.mcpServers ?? [];
    const mcp = this.opts.mcp?.open(extraServers) ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: agent.sessionId,
        resume: true,
        extraAllowedTools: extraMcpGrants(extraServers),
        mcpConfigPath: mcp?.configPath ?? null,
        model: task.model ?? null,
        effort: task.effort ?? null,
      }),
      cwd: agent.cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.eventsDirEnv(eventsKey),
      },
      waitingPatterns: this.opts.waitingPatterns,
      sessionId: agent.sessionId,
      resume: true,
    });
    if (eventsKey) this.eventsKeys.set(agent.id, eventsKey);
    if (mcp) {
      this.opts.mcp?.bind(mcp.token, agent.id);
      this.mcpTokens.set(agent.id, mcp.token);
    }
    debugLog(
      'agent',
      `resume agent=${agent.id} cwd=${agent.cwd} eventsDir=${this.fileEventsDir(agent.id) ?? '<file-events off>'}`,
    );

    this.sessions.set(agent.id, session);
    this.store.updateAgent(agent.id, { status: 'running', pid: null, endedAt: null, waitingReason: null });
    this.store.updateTask(task.id, { status: 'running' });
    this.wireSession(session, agent.id, task);
    try {
      session.start();
    } catch (err) {
      this.sessions.delete(agent.id);
      throw new Error(`resume spawn failed for agent ${agent.id}: ${(err as Error).message}`);
    }

    if (wasWaiting) {
      this.restoreWaiting(agent, task);
    } else {
      const carryOn = nudge ?? this.opts.resumeInput?.() ?? null;
      if (carryOn !== null) this.noteSent(agent.id, session, carryOn);
      this.deliverAfterBoot(agent.id, session, carryOn);
    }

    return true;
  }

  resumeParked(agentId: string): { ok: true } | { ok: false; error: string } {
    const park = this.limited.get(agentId);
    if (park === undefined) return { ok: false, error: 'this agent is not parked on a usage limit' };
    return this.withCaller(agentId, ({ agent, task }) => {
      const session = this.sessions.get(agentId);
      if (!session && (!this.opts.resumable || !agent.sessionId)) {
        return { ok: false, error: 'this agent runtime cannot re-open its session, so the park cannot be ended' };
      }
      this.limited.delete(agentId);
      this.parked.delete(agentId);
      this.stalled.delete(agentId);
      this.store.setAgentResumed(agentId, null);
      this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
      this.store.updateTask(task.id, { status: 'running' });

      if (session) {
        this.noteSent(agentId, session, LIMIT_RESUME_MESSAGE);
        session.send(LIMIT_RESUME_MESSAGE);
        this.reflectStatus(agentId, task.id, 'running');
        return { ok: true };
      }

      const row = this.store.getAgent(agentId);
      try {
        if (!row || !this.resume(row, task, LIMIT_RESUME_MESSAGE)) throw new Error('the runtime declined the resume');
      } catch (err) {
        this.reinstateLimitPark(agentId, task, park);
        return { ok: false, error: `could not re-open the session: ${(err as Error).message}` };
      }
      return { ok: true };
    });
  }

  /** @public Reached through the structural `fleet` seam on `HarnessDeps` (`src/harness.ts`). */
  resumeExpiredParks(): LimitResumeFailure[] {
    const now = Date.now();
    const failures: LimitResumeFailure[] = [];
    for (const [agentId, park] of [...this.limited]) {
      if (!park.resetsAt) continue;
      const resetsAt = Date.parse(park.resetsAt);
      if (!Number.isFinite(resetsAt) || resetsAt > now) continue;
      debugLog('agent', `limit park expired agent=${agentId} resetsAt=${park.resetsAt}`);
      const result = this.resumeParked(agentId);
      if (!result.ok) failures.push({ agentId, error: result.error });
    }
    return failures;
  }

  limitedAgentIds(): string[] {
    return [...this.limited.keys()];
  }

  stallDeadlines(): StallPark[] {
    return [...this.stalled].map(([agentId, clock]) => ({ agentId, expiresAt: new Date(clock.at).toISOString() }));
  }

  extendStallPark(agentId: string): { ok: true; expiresAt: string } | { ok: false; error: string } {
    const clock = this.stalled.get(agentId);
    if (!clock) return { ok: false, error: 'this agent is not parked on an unannounced stop' };
    const at = Date.now() + (this.opts.stallExtendMs ?? 0);
    clock.at = at;
    const expiresAt = new Date(at).toISOString();
    debugLog('agent', `stall park extended agent=${agentId} until=${expiresAt}`);
    return { ok: true, expiresAt };
  }

  completeExpiredStalls(): string[] {
    const now = Date.now();
    const settled: string[] = [];
    for (const [agentId, clock] of [...this.stalled]) {
      if (clock.at > now) continue;
      if (this.limited.has(agentId)) {
        this.stalled.delete(agentId);
        continue;
      }
      debugLog('agent', `stall park expired agent=${agentId}`);
      if (this.complete(agentId, 'expiry')) settled.push(agentId);
      else this.stalled.delete(agentId);
    }
    return settled;
  }

  private noteSent(agentId: string, session: AgentSession, text: string): void {
    if (session.recordsSentMessages) return;
    const note = renderBlocks([{ type: HUMAN_BLOCK, text }], new Date().toISOString());
    if (!note) return;
    this.store.appendTranscript(agentId, note);
    this.emit('output', { agentId, delta: note });
  }

  notify(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session || this.parked.has(agentId)) return false;
    this.noteSent(agentId, session, text);
    try {
      session.send(text);
    } catch {
      return false;
    }
    return true;
  }

  respond(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    this.noteSent(agentId, session, text);
    session.send(text);
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.stalled.delete(agentId);
    this.store.setAgentResumed(agentId, null);
    this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
    return true;
  }

  private withCaller<R extends { ok: true } | { ok: false; error: string }>(
    agentId: string,
    fn: (caller: { agent: Agent; task: Task }) => R,
  ): R | { ok: false; error: string } {
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    return fn({ agent, task });
  }

  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string } {
    if (!this.sessions.has(agentId)) return { ok: false, error: 'agent is no longer live' };
    return this.withCaller(agentId, ({ task }) => {
      const question = ask.question.trim();
      if (!question) return { ok: false, error: 'question must not be empty' };
      this.handleWaiting(agentId, task, question, ask);
      const open = this.store.listOpenEscalations().find((e) => e.agentId === agentId) ?? null;
      return { ok: true, escalationId: open?.id ?? null };
    });
  }

  requestHumanTask(
    agentId: string,
    input: HumanTaskInput,
  ): { ok: true; task: HumanTask } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const { task: humanTask, created } = this.store.recordHumanTask({
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
      const bug = jobId ? this.store.findBugFilingByJobId(jobId) : null;
      if (bug) {
        const parsed = Number(bug.originRef.replace(/^issue:/, '').split(':')[0]);
        return { ok: true, kind: 'bug', storyNumber: Number.isInteger(parsed) ? parsed : null };
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
      const bug = jobId ? this.store.findBugFilingByJobId(jobId) : null;
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
      const linked = this.store.linkBugFiling(bug.jobId, ticketRef);
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
      const notedAt = this.store.recordAgentNote(agentId, note);
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
      const entry = this.store.appendScratchEntry({
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
      return { ok: true, padRef: target.padRef, entries: this.store.listScratchEntries(target.padRef) };
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
      this.store.recordRetrospective({
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
      this.store.recordFeatureSummary({
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
      const previous = this.store.getFeatureSequence(origin.featureOrigin);
      const verdict = resequenceVerdict(previous, input.edges, members);
      this.store.recordFeatureSequence({
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
        this.store.answerFeatureSequence(origin.featureOrigin, 'accepted', previous.answeredBy);
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
      const remedy = this.store.recordRemedy({
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

  recordConclusion(
    agentId: string,
    verdict: IssueConclusionVerdict,
    note: string,
  ): { ok: true; conclusion: IssueConclusion } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = conclusionOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      const conclusion = this.store.recordIssueConclusion({
        originRef: origin.originRef,
        verdict,
        note,
        by: 'agent',
        agentId,
        taskId: task.id,
      });
      this.store.settleInstructions(origin.originRef);
      this.emit('conclusion', { agentId, taskId: task.id, conclusion });
      return { ok: true, conclusion };
    });
  }

  recordBlocked(
    agentId: string,
    obstacleId: string,
    note: string,
  ): { ok: true; block: ObstacleBlock } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = conclusionOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      const obstacle = this.store.getObstacle(obstacleId);
      if (!obstacle) {
        return {
          ok: false,
          error:
            `No obstacle has that id (${obstacleId}), so nothing was recorded and your goal is not parked. ` +
            `Name the id raise answered with — and if you have not raised what stopped you, raise it first: ` +
            `a block that names nothing is a goal nothing brings back.`,
        };
      }
      const block = this.store.recordObstacleBlock({
        originRef: origin.originRef,
        obstacleId,
        agentId,
        taskId: task.id,
        note,
      });
      this.store.settleInstructions(origin.originRef);
      return { ok: true, block };
    });
  }

  recordAssessment(
    agentId: string,
    verdict: AssessmentVerdict,
    summary: string,
    detail: string | null = null,
    cause: ShortfallCause | null = null,
    part: string | null = null,
  ): { ok: true; issueOrigin: string; verdict: AssessmentVerdict } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = assessmentOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };

      if (verdict === 'delivered') {
        this.store.recordDelivery({
          originRef: origin.issueOrigin,
          summary,
          detail,
          by: 'assessor',
          agentId,
          taskId: task.id,
        });
        this.emit('assessment', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
        return { ok: true, issueOrigin: origin.issueOrigin, verdict };
      }

      const plan = this.store.listPlans().find((p) => p.originRef === origin.issueOrigin) ?? null;
      const parts = plan ? liveParts(this.store.listPlanParts(plan.id)) : [];

      if (plan === null && (cause === 'plan' || cause === 'part')) {
        return {
          ok: false,
          error:
            `cause "${cause}" says the delivery plan is what fell short, and ${origin.issueOrigin} has no plan — ` +
            `there is nothing to re-plan and no part to follow up. If the issue's own goal is the problem, say ` +
            `cause "goal". If the work simply is not finished, say more_work with no cause: the issue comes ` +
            `back round for pickup with your summary against it.`,
        };
      }
      if (plan !== null && cause === null) {
        return {
          ok: false,
          error:
            `${origin.issueOrigin} has a delivery plan, so a shortfall has to say what fell short or the harness ` +
            `cannot route it: cause "plan" (the split itself is wrong, or a part is missing), "part" (one named ` +
            `part missed its own scope — name it in \`part\`), or "goal" (the issue itself is wrong, and no ` +
            `planner can fix that).`,
        };
      }
      if (cause === 'part' && !parts.some((p) => p.slug === part)) {
        return {
          ok: false,
          error:
            parts.length === 0
              ? `${origin.issueOrigin}'s plan declares no parts — it is a single-pull-request verdict, so there ` +
                `is no "${part}" to follow up. Say cause "plan" if one pull request was not enough; the planner ` +
                `will see your summary and may decompose it.`
              : `"${part}" is not a live part of ${origin.issueOrigin}'s plan. Its parts are: ` +
                `${parts.map((p) => p.slug).join(', ')}. Name one of those, or say cause "plan" if the part you ` +
                `have in mind is one the decomposition is missing.`,
        };
      }

      this.store.recordShortfall({
        originRef: origin.issueOrigin,
        cause,
        partSlug: part,
        summary,
        detail,
        by: 'assessor',
        agentId,
        taskId: task.id,
      });
      this.emit('assessment', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
      return { ok: true, issueOrigin: origin.issueOrigin, verdict };
    });
  }

  recordGoalMet(
    agentId: string,
    summary: string,
    detail: string,
  ): { ok: true; issueOrigin: string } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = plannerOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };

      const plan = this.store.getPlanByOrigin(origin.issueOrigin);
      if (plan) {
        return {
          ok: false,
          error:
            `${origin.issueOrigin} already has a delivery plan, so this is a replan and plan_not_needed ` +
            `cannot settle it: the plan would go on owning the issue, and any part already dispatched or ` +
            `in review would go on running underneath a goal marked delivered. Submit the amended plan ` +
            `with plan_submit — a part that turned out to be unnecessary is one you leave out, and one ` +
            `already in flight is a part whose agent closes it with conclude_part. If you believe the ` +
            `whole goal is already met, raise it: the operator asked for this replan and it is theirs to end.`,
        };
      }

      const shortfall = this.store.getShortfall(origin.issueOrigin);
      if (shortfall) {
        return {
          ok: false,
          error:
            `An assessment of ${origin.issueOrigin} standing right now says the goal is *not* reached — ` +
            `"${shortfall.summary}" — and it was cast against the delivered state rather than against a ` +
            `plan. Recording a delivery here would erase it. Read what it says is missing; if it is wrong, ` +
            `raise that, and if it is right, plan the work it names.`,
        };
      }

      this.store.recordDelivery({
        originRef: origin.issueOrigin,
        summary,
        detail,
        by: 'planner',
        agentId,
        taskId: task.id,
      });
      this.emit('goalMet', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin });
      return { ok: true, issueOrigin: origin.issueOrigin };
    });
  }

  recordAppraisal(
    agentId: string,
    verdict: GoalAppraisalVerdictName,
    summary: string,
    profile: string | null,
    placement?: { missing?: string[]; parent: number | null; areaPath: string | null },
  ):
    | { ok: true; issueOrigin: string; verdict: GoalAppraisalVerdictName; profileHeld: boolean }
    | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = appraiserOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };

      const proposedProfile = this.opts.goalProfile && profile ? profile : null;
      const profileHeld =
        proposedProfile !== null && proposedProfile !== this.opts.goalProfile?.effective(origin.issueOrigin);
      this.store.recordAppraisal({
        originRef: origin.issueOrigin,
        verdict,
        summary,
        missing: placement?.missing ?? [],
        goalRef: goalFingerprint(task.originTitle, task.originSummary),
        by: 'appraiser',
        proposedProfile,
        profileDiverges: profileHeld,
        proposedParent: placement?.parent ?? null,
        proposedAreaPath: placement?.areaPath ?? null,
        agentId,
        taskId: task.id,
      });
      this.emit('appraisal', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
      return { ok: true, issueOrigin: origin.issueOrigin, verdict, profileHeld };
    });
  }

  recordPartOutcome(
    agentId: string,
    kind: PartOutcomeKind,
    summary: string,
    ref: string | null,
  ): { ok: true; part: PlanPart } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = partConclusionOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };
      const plan = this.store.getPlanByOrigin(issueOrigin(origin.issueNumber));
      const part = plan ? this.store.listPlanParts(plan.id).find((p) => p.slug === origin.slug) : undefined;
      if (!part) {
        return { ok: false, error: `no part "${origin.slug}" is recorded for issue #${origin.issueNumber}.` };
      }
      const concluded = this.store.concludePlanPart(part.id, { kind, ref, summary });
      if (!concluded) {
        return {
          ok: false,
          error:
            `part "${origin.slug}" is "${part.status}", and only a part being worked can be concluded. ` +
            `A merged part already finished; a retired one was dropped by a replan.`,
        };
      }
      this.emit('partOutcome', { agentId, taskId: task.id, part: concluded });
      return { ok: true, part: concluded };
    });
  }

  interrupt(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    session.sendRaw('\x03');
    return true;
  }

  kill(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session && !this.limited.has(agentId)) return false;
    session?.kill();
    this.disposeFileEvents(agentId);
    this.releaseMcp(agentId);
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.stalled.delete(agentId);
    this.store.flushTranscript(agentId);
    const agent = this.store.getAgent(agentId);
    this.store.updateAgent(agentId, { status: 'killed', endedAt: new Date().toISOString(), pid: null });
    if (agent) this.store.updateTask(agent.taskId, { status: 'interrupted' });
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.terminals.set(agentId, 'killed');
    if (!session) {
      this.exited.add(agentId);
    }
    if (agent) {
      this.reflectStatus(agentId, agent.taskId, 'killed');
      this.maybeReap(agentId, agent.taskId);
    }
    return true;
  }

  complete(agentId: string, by: 'operator' | 'expiry' = 'operator'): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    const agent = this.store.getAgent(agentId);
    if (!agent) return false;
    const id = agent.id;
    session.kill();
    this.handleTerminal(id, agent.taskId, 'done', by);
    const task = this.store.getTask(agent.taskId);
    this.store.recordDecision({
      cycleId: `${by === 'operator' ? 'human' : 'stall'}:${id}`,
      action: {
        type: 'no_op',
        reason:
          by === 'operator'
            ? 'operator marked the work complete'
            : 'an unannounced stop stood unanswered until its park expired',
      },
      outcome: 'executed',
      detail: `Marked agent ${id} done (task ${agent.taskId}${task?.originRef ? `, ${task.originRef}` : ''})`,
    });
    return true;
  }

  isLive(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  interruptAll(): void {
    const at = new Date().toISOString();
    for (const id of [...this.sessions.keys()]) {
      const session = this.sessions.get(id);
      try {
        session?.kill();
      } catch {
        /* process already gone */
      }
      this.disposeFileEvents(id);
      this.releaseMcp(id);
      this.store.flushTranscript(id);
      this.store.updateAgent(id, { status: 'interrupted', endedAt: at, pid: null });
      this.sessions.delete(id);
      this.exitCodes.delete(id);
      this.exited.delete(id);
      this.parked.delete(id);
      this.limited.delete(id);
    }
  }

  private eventsDirEnv(key: string | null): Record<string, string> {
    if (!key || !this.opts.fileEvents) return {};
    const env: Record<string, string> = { LUBBDUBB_EVENTS_DIR: this.opts.fileEvents.dirFor(key) };
    if (debugEnabled()) env.LUBBDUBB_EVENTS_DEBUG = '1';
    return env;
  }

  fileEventsDir(agentId: string): string | null {
    const key = this.eventsKeys.get(agentId);
    return key && this.opts.fileEvents ? this.opts.fileEvents.dirFor(key) : null;
  }

  drainFileEvents(agentId: string): void {
    const key = this.eventsKeys.get(agentId);
    if (!key || !this.opts.fileEvents) return;
    const records = this.opts.fileEvents.drain(key);
    if (records.length === 0) return;
    const agent = this.store.getAgent(agentId);
    if (!agent) return;
    debugLog('fileEvents', `agent=${agentId} drained ${records.length} record(s)`);
    for (const rec of records) this.ingestFileEvent(agent, rec);
  }

  private ingestFileEvent(agent: Agent, rec: FileEventRecord): void {
    const path = toWorktreeRelative(agent.cwd, rec.path);
    const { promoted, kind } = classifyArtifact(path, this.opts.docsFolderPrefix);
    debugLog(
      'fileEvents',
      `agent=${agent.id} write path=${path} tool=${rec.tool ?? '?'} promoted=${promoted} kind=${kind}`,
    );
    this.store.recordFile(agent.id, { path, tool: rec.tool, promoted });
    this.emit('files', { agentId: agent.id, taskId: agent.taskId });
    if (isPlanFile(path)) this.ingestPlan(agent, path);
    if (promoted) {
      const flag = this.store.recordFlag(agent.id, { kind, label: basename(path), ref: path });
      this.emit('flag', { agentId: agent.id, taskId: agent.taskId, flag });
    }
  }

  private ingestPlan(agent: Agent, relPath: string): void {
    const task = this.store.getTask(agent.taskId);
    const number = planOriginIssue(task?.originRef ?? null);
    if (!task || number === null) {
      debugLog('fileEvents', `agent=${agent.id} wrote ${PLAN_FILE} but is not a planning agent — ignored`);
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(join(agent.cwd, relPath), 'utf8');
    } catch (err) {
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id} flagged ${PLAN_FILE} for issue #${number} but it could not be read: ${(err as Error).message}`,
      });
      return;
    }
    const parsed = parsePlanDocument(raw);
    if (!parsed.ok) {
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id} wrote an invalid ${PLAN_FILE} for issue #${number}: ${parsed.error}`,
      });
      return;
    }
    const doc = parsed.document;
    const origin = issueOrigin(number);
    const result = ingestPlanDocument(this.store, {
      doc,
      originRef: origin,
      title: task.originTitle ?? task.title,
    });
    debugLog(
      'fileEvents',
      `agent=${agent.id} plan ingested issue=#${number} parts=${doc.parts.length} status=${result.status} ` +
        `retired=${result.retired.length}`,
    );
    void this.opts.watch?.run(origin).then(
      (refusals) => {
        if (refusals.length === 0) return;
        this.opts.errors?.record({
          source: 'agent',
          message:
            `Agent ${agent.id} declared a watch on issue #${number} whose queries did not resolve: ` +
            refusals.join('; '),
        });
      },
      (err: unknown) => {
        this.opts.errors?.record({
          source: 'agent',
          message: `The watch dry run for issue #${number} failed: ${(err as Error).message}`,
        });
      },
    );
  }

  private disposeFileEvents(agentId: string): void {
    const key = this.eventsKeys.get(agentId);
    if (!key || !this.opts.fileEvents) return;
    this.drainFileEvents(agentId);
    if (debugEnabled()) {
      const crumbs = this.opts.fileEvents.readDebug(key);
      debugLog('fileEvents', `agent=${agentId} hook fired ${crumbs.length} time(s)`);
      for (const c of crumbs) debugLog('fileEvents', `agent=${agentId} hook: ${c}`);
    }
    this.opts.fileEvents.dispose(key);
    this.eventsKeys.delete(agentId);
  }

  private wireSession(session: AgentSession, agentId: string, task: Task): void {
    session.on('output', (delta: string) => {
      this.store.appendTranscript(agentId, delta);
      this.emit('output', { agentId, delta });
      this.drainFileEvents(agentId);
    });

    session.on('status', (status) => {
      if (status === 'running') {
        this.store.updateAgent(agentId, { status: 'running', pid: session.pid, waitingReason: null });
        this.reflectStatus(agentId, task.id, 'running');
      }
    });

    session.on('usage', (usage: AgentUsage) => {
      this.store.recordAgentUsage(agentId, usage);
      this.emit('usage', { agentId, taskId: task.id, usage });
    });

    session.on('limits', (limits: AccountRateLimits) => this.store.recordRateLimits(limits));

    session.on('flag', (flag: ParsedFlag) => {
      const saved = this.store.recordFlag(agentId, flag);
      this.emit('flag', { agentId, taskId: task.id, flag: saved });
    });

    session.on('activity', () => this.noteResumed(agentId, task.id));

    session.on('waiting', (reason: string) => this.handleWaiting(agentId, task, reason));
    session.on('stalled', (lastWords: string) => this.handleStalled(session, agentId, task, lastWords));
    session.on('silent', (silenceMs: number) => this.handleSilent(agentId, task, silenceMs));
    session.on('limited', (park: RateLimitPark) => this.handleLimited(agentId, task, park));
    session.on('exit', (code: number) => {
      this.exitCodes.set(agentId, code);
      this.exited.add(agentId);
      if (this.limited.has(agentId)) this.shedLimitedSession(agentId);
      this.maybeReap(agentId, task.id);
    });
    session.on('done', () => this.handleTerminal(agentId, task.id, 'done'));
    session.on('failed', () => {
      const attempts = this.autoResume(session, agentId, task);
      if (attempts === null) return;
      this.handleTerminal(
        agentId,
        task.id,
        'failed',
        'agent',
        attempts > 0 ? `after ${attempts} automatic resume${attempts === 1 ? '' : 's'}` : undefined,
      );
    });
  }

  private autoResume(session: AgentSession, agentId: string, task: Task): number | null {
    const limit = this.opts.resumeAttempts ?? 0;
    if (limit <= 0 || !this.opts.resumable || this.sessions.get(agentId) !== session) return 0;
    const agent = this.store.getAgent(agentId);
    if (!agent?.sessionId) return agent?.resumeAttempts ?? 0;
    if (!existsSync(agent.cwd)) return agent.resumeAttempts;
    if (agent.resumeAttempts >= limit) return agent.resumeAttempts;

    const attempts = this.store.countAgentResumeAttempt(agentId);
    this.disposeFileEvents(agentId);
    this.releaseMcp(agentId);
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exited.delete(agentId);
    debugLog('agent', `auto-resume agent=${agentId} attempt=${attempts}/${limit}`);
    try {
      if (this.resume({ ...agent, resumeAttempts: attempts }, task)) return null;
    } catch (err) {
      this.store.appendTranscript(agentId, `\nResume after crash failed: ${(err as Error).message}\n`);
    }
    return attempts;
  }

  private deliverAfterBoot(agentId: string, session: AgentSession, text: string | null): void {
    if (text === null) return;
    const delay = this.opts.promptDelayMs ?? 0;
    const deliver = (): void => {
      if (!this.sessions.has(agentId)) return;
      try {
        session.send(text);
      } catch {
        /* session already gone */
      }
    };
    if (delay <= 0) deliver();
    else setTimeout(deliver, delay).unref?.();
  }

  private restoreWaiting(agent: Agent, task: Task): void {
    const reason = agent.waitingReason ?? 'Resumed agent is awaiting your input.';
    this.parked.add(agent.id);
    this.store.updateAgent(agent.id, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agent.id, task.id, 'waiting');
    const hasOpen = this.store.listOpenEscalations().some((e) => e.agentId === agent.id);
    if (!hasOpen) this.emit('waiting', { agentId: agent.id, taskId: task.id, reason });
  }

  private handleStalled(session: AgentSession, agentId: string, task: Task, lastWords: string): void {
    if (this.parked.has(agentId)) return;
    const budget = this.opts.stallNudges ?? 0;
    const spent = this.nudges.get(agentId) ?? 0;
    if (spent < budget && !this.exited.has(agentId)) {
      this.nudges.set(agentId, spent + 1);
      this.noteSent(agentId, session, STALL_NUDGE);
      debugLog('agent', `stall nudge agent=${agentId} attempt=${spent + 1}/${budget}`);
      try {
        session.send(STALL_NUDGE);
        return;
      } catch {
        // The session went away between the turn ending and the nudge; fall through.
      }
    }
    this.handleWaiting(agentId, task, stallReason(lastWords));
    this.armStallClock(agentId, this.opts.stallParkMs ?? 0, 'stall');
  }

  private handleSilent(agentId: string, task: Task, silenceMs: number): void {
    if (this.parked.has(agentId)) return;
    debugLog('agent', `silence park agent=${agentId} after=${silenceMs}ms`);
    this.handleWaiting(agentId, task, silenceReason(silenceMs));
    this.armStallClock(agentId, this.opts.stallParkMs ?? 0, 'silence', this.opts.silenceParkMs ?? 0);
  }

  private armStallClock(agentId: string, window: number, kind: 'stall' | 'silence', grace = window): void {
    if (window <= 0 || !this.parked.has(agentId) || this.limited.has(agentId)) return;
    this.stalled.set(agentId, { at: Date.now() + window, grace: grace > 0 ? grace : window });
    debugLog('agent', `${kind} park armed agent=${agentId} window=${window}ms grace=${grace}ms`);
  }

  private handleWaiting(agentId: string, task: Task, reason: string, ask?: AgentAsk): void {
    if (this.parked.has(agentId)) return;
    this.drainFileEvents(agentId);
    const rule = this.opts.whitelistedApprovals.find((r) => reason.includes(r.match));
    if (rule) {
      this.respond(agentId, rule.response);
      this.emit('autoAnswered', { agentId, taskId: task.id, reason, response: rule.response });
      return;
    }
    this.parked.add(agentId);
    this.store.setAgentResumed(agentId, null);
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('waiting', { agentId, taskId: task.id, reason, ask });
  }

  private handleLimited(agentId: string, task: Task, park: RateLimitPark): void {
    if (this.limited.has(agentId)) return;
    const reason = rateLimitParkReason(park);
    this.drainFileEvents(agentId);
    this.store.flushTranscript(agentId);
    const asked = this.parked.has(agentId);
    this.limited.set(agentId, { reason, resetsAt: park.resetsAt });
    this.parked.add(agentId);
    this.stalled.delete(agentId);
    this.store.setAgentResumed(agentId, null);
    this.store.updateAgent(agentId, asked ? { status: 'waiting' } : { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('limited', { agentId, taskId: task.id, reason, resetsAt: park.resetsAt });
    if (this.exited.has(agentId)) this.shedLimitedSession(agentId);
  }

  private shedLimitedSession(agentId: string): void {
    this.disposeFileEvents(agentId);
    this.releaseMcp(agentId);
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exited.delete(agentId);
    this.store.updateAgent(agentId, { pid: null });
  }

  private reinstateLimitPark(agentId: string, task: Task, park: LimitPark): void {
    this.limited.set(agentId, park);
    this.parked.add(agentId);
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: park.reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
  }

  private noteResumed(agentId: string, taskId: string): void {
    if (!this.parked.has(agentId)) return;
    const clock = this.stalled.get(agentId);
    if (clock) clock.at = Math.max(clock.at, Date.now() + clock.grace);
    const resumedAt = new Date().toISOString();
    this.store.setAgentResumed(agentId, resumedAt);
    this.emit('resumed', { agentId, taskId, resumedAt });
  }

  releasePark(agentId: string): void {
    this.parked.delete(agentId);
    this.stalled.delete(agentId);
    this.store.setAgentResumed(agentId, null);
  }

  private failSpawn(agentId: string, taskId: string, err: Error): void {
    this.sessions.delete(agentId);
    this.store.appendTranscript(agentId, err.message);
    this.store.flushTranscript(agentId);
    this.store.updateAgent(agentId, { status: 'failed', endedAt: new Date().toISOString(), pid: null });
    this.store.updateTask(taskId, { status: 'failed' });
    this.opts.errors?.record({
      source: 'agent',
      message: `Agent ${agentId} failed to spawn (task ${taskId}): ${err.message}`,
    });
    this.reflectStatus(agentId, taskId, 'failed');
  }

  private handleTerminal(
    agentId: string,
    taskId: string,
    status: 'done' | 'failed',
    by: TerminalBy = 'agent',
    failureNote?: string,
  ): void {
    this.drainFileEvents(agentId);
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.nudges.delete(agentId);
    this.stalled.delete(agentId);
    this.store.flushTranscript(agentId);
    this.store.updateAgent(agentId, { status, endedAt: new Date().toISOString(), pid: null });
    this.store.updateTask(taskId, { status });
    this.sessions.delete(agentId);
    const exitCode = this.exitCodes.get(agentId);
    this.exitCodes.delete(agentId);
    if (status === 'failed') {
      this.opts.errors?.record({
        source: 'agent',
        message:
          `Agent ${agentId} failed (task ${taskId})` +
          `${exitCode !== undefined ? `, exit code ${exitCode}` : ''}${failureNote ? `, ${failureNote}` : ''}`,
        detail: recentOutputExcerpt(this.store.getTranscript(agentId)) || null,
      });
    }
    this.reflectStatus(agentId, taskId, status);
    this.emit('done', { agentId, taskId, status, by });
    this.terminals.set(agentId, status);
    this.maybeReap(agentId, taskId);
  }

  private maybeReap(agentId: string, taskId: string): void {
    const status = this.terminals.get(agentId);
    if (!status || !this.exited.has(agentId)) return;
    this.terminals.delete(agentId);
    this.exited.delete(agentId);
    this.disposeFileEvents(agentId);
    this.releaseMcp(agentId);
    this.emit('reaped', { agentId, taskId, status });
  }

  private releaseMcp(agentId: string): void {
    const token = this.mcpTokens.get(agentId);
    if (!token) return;
    this.mcpTokens.delete(agentId);
    this.opts.mcp?.release(token);
  }

  private reflectStatus(agentId: string, taskId: string, status: AgentStatus): void {
    this.emit('status', { agentId, taskId, status });
  }

  override emit<K extends keyof AgentManagerEvents>(event: K, ...args: AgentManagerEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof AgentManagerEvents>(event: K, listener: (...args: AgentManagerEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

const LIMIT_RESUME_MESSAGE =
  'This account hit its usage limit mid-turn, so the harness parked you. The limit has cleared and ' +
  'you have been resumed. Nothing else changed — the worktree and the conversation are the ones you ' +
  'left. Continue the task from where you stopped.';

const LIMIT_WINDOWS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'seven-day',
  seven_day_opus: 'seven-day Opus',
  seven_day_sonnet: 'seven-day Sonnet',
  seven_day_overage_included: 'seven-day (overage included)',
  overage: 'overage',
};

function rateLimitParkReason(park: RateLimitPark): string {
  const window = park.limitType ? (LIMIT_WINDOWS[park.limitType] ?? park.limitType) : null;
  const what = park.overage
    ? `this account's overage allowance is spent${window ? ` (${window})` : ''}`
    : `this account's ${window ? `${window} ` : ''}usage limit is spent`;
  const when = park.resetsAt ? `, and it resets at ${park.resetsAt}` : '';
  const ending = park.resetsAt
    ? 'the run carries on by itself once the window turns over'
    : 'resume it once the limit clears';
  return `Parked on a usage limit: ${what}${when}. Nothing is wrong with the run — ${ending}.`;
}

function toWorktreeRelative(cwd: string, p: string): string {
  const toPosix = (s: string): string => s.replace(/\\/g, '/');
  if (!isAbsolute(p)) return toPosix(p);
  const rel = relative(cwd, p);
  return toPosix(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p);
}
