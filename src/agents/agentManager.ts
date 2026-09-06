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

/** What `link_ticket` settled: the bug filing an operator raised, now carrying its ref. */
type LinkTicketResult = { ok: true; bug: BugFiling } | { ok: false; error: string };

/**
 * Which filing a credential resolves to, and for a bug the story it must relate to.
 * Read before the item is created, so neither type nor relation is ever an agent's argument.
 */
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

/** The MCP tool channel as {@link AgentManager} needs it: a credential per launch, handed back when the agent leaves. */
interface McpChannel {
  /** Mint a per-launch credential; `configPath` is null when tools cannot be wired. `extra` servers share the same document and credential. */
  open(extra?: readonly ExtraMcpServer[]): { token: string; configPath: string | null };
  /** Complete the credential's identity once the agent row exists. */
  bind(token: string, agentId: string): void;
  /** Revoke a credential and drop its launch config. */
  release(token: string): void;
}

interface AgentManagerOptions {
  command: string;
  /**
   * Builds the argv for a launch: the session id and whether to `--resume` it, the
   * tool channel's config path or null, and the task's resolved model/effort or null
   * for no flag. Runtimes without session ids ignore the first two.
   */
  buildArgs: (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    /** Server-level grants for whatever `extra` servers this launch declared. */
    extraAllowedTools: string[];
    model: string | null;
    effort: string | null;
  }) => string[];
  /**
   * What a goal's work runs on today — the one decision `recordAppraisal` makes about
   * a proposal. A function, so the manager stays ignorant of labels and precedence.
   * Unset means no proposal is ever stored and no gate can hold.
   */
  goalProfile?: {
    /** The profile `issue:<n>`'s work would run on now: its tag, or the configured default. */
    effective: (issueOrigin: string) => string | null;
  };
  /**
   * Where a Feature's children stand *now*, digested for the summary stamp. Must be
   * read at submission, never at dispatch, or a key stamped at launch never updates and
   * the Feature is silently never summarised again. Unset stamps an empty key.
   */
  featureStanding?: (featureOrigin: string) => string | null;
  /**
   * Which stories are under a Feature right now — membership, never movement. Stamped
   * at submission like {@link featureStanding}; absent leaves it empty, which only
   * causes an extra proposal, never a missed one. → `docs/spec/33-story-sequencing.md#the-record`
   */
  featureSequenceStanding?: (featureOrigin: string) => { key: string; members: number[] } | null;
  whitelistedApprovals: WhitelistRule[];
  /** Builds the underlying runtime (PTY or stream-JSON) for a launch spec. */
  createSession: SessionFactory;
  /**
   * The first message delivered to the session, once the process has had
   * `promptDelayMs` to boot. Null sends nothing (the mock agent reads its own prompt).
   */
  initialInput?: (task: Task) => string | null;
  /**
   * Message nudging a *resumed* agent to continue — only for one that was mid-work,
   * since `--resume` re-opens the session idle. Null sends nothing.
   */
  resumeInput?: () => string | null;
  /** Delay before sending the initial input, giving an interactive CLI time to start. */
  promptDelayMs?: number;
  /** Extra literal substrings a PTY session treats as "waiting for input". */
  waitingPatterns?: string[];
  /**
   * `agentStallNudges` — how many times an unannounced stop is questioned before it is
   * put to a human. Unset or 0 parks and escalates on the first one.
   */
  stallNudges?: number;
  /**
   * `agentStallParkMs` — how long an unannounced stop stands parked before the harness
   * settles it `done` itself. Unset or 0 means it stands until somebody acts on it.
   */
  stallParkMs?: number;
  /** `agentStallExtendMs` — what one press of Extend adds to that countdown. */
  stallExtendMs?: number;
  /**
   * `agentSilenceParkMs` — how long a stream agent may produce nothing before the
   * runtime calls it silent; unset or 0 means never. Held here as well as on the
   * session as the grace a silence park re-arms on (see {@link StallClock}).
   */
  silenceParkMs?: number;
  /** Whether this runtime can capture a session id and be resumed after a restart. */
  resumable?: boolean;
  /**
   * `agentResumeAttempts` — how many times an agent whose process dies mid-run is
   * re-attached before it is settled failed. Unset or 0 makes a mid-run death terminal.
   */
  resumeAttempts?: number;
  /** Spool for the file-events `PostToolUse` hook, drained by {@link AgentManager.drainFileEvents}. Unset → no capture. */
  fileEvents?: FileEventsSpool;
  /** Folder(s) whose files are promoted to artifacts (any extension); relative or absolute. See {@link classifyArtifact}. */
  docsFolderPrefix?: string | string[];
  /** The typed tool channel: a credential and `--mcp-config` per launch. Unset leaves agents on the sentinels alone. */
  mcp?: McpChannel;
  /**
   * The post-deploy watch's dry run, for a plan that arrived as a *file*. No caller to
   * hand a refusal back to, so it is recorded instead of returned.
   */
  watch?: WatchDryRunner;
  /** Central error sink: agent failures (spawn errors, crashes + exit codes) are recorded here. */
  errors?: ErrorRecorder;
}

/**
 * A usage-limit park this process is holding. `resetsAt` null means `claude` did not
 * say, which is a park only a human can end.
 */
interface LimitPark {
  reason: string;
  /** ISO, from the `rate_limit_event`'s own `resetsAt`. */
  resetsAt: string | null;
}

/**
 * The countdown on a park that settles itself. `at` is when the harness settles unless
 * the operator hits Extend; `grace` is what the agent buys back by doing something, so
 * the countdown cannot finish an agent under its own hands.
 */
interface StallClock {
  at: number;
  grace: number;
}

/** Who reached a terminal: the agent, the operator's "Mark work done", or a stall park expiring. */
type TerminalBy = 'agent' | 'operator' | 'expiry';

/** A park whose window turned over but which could not be resumed. */
export interface LimitResumeFailure {
  agentId: string;
  error: string;
}

interface AgentManagerEvents {
  output: [{ agentId: string; delta: string }];
  /** `ask` is present only when the park came through the `escalate` tool, which can carry structure. */
  waiting: [{ agentId: string; taskId: string; reason: string; ask?: AgentAsk }];
  autoAnswered: [{ agentId: string; taskId: string; reason: string; response: string }];
  /**
   * `by` tells the agent declaring itself finished from one declared so through
   * {@link AgentManager.complete}. The record is identical for all three, but the
   * latter two leave an escalation the composition root has to dismiss.
   */
  done: [{ agentId: string; taskId: string; status: AgentStatus; by: TerminalBy }];
  /**
   * The agent finished *and* its OS process has exited — the two arrive in either
   * order. Only now is it safe to touch resources the process pinned, e.g. its worktree.
   */
  reaped: [{ agentId: string; taskId: string; status: 'done' | 'failed' | 'killed' }];
  status: [{ agentId: string; taskId: string; status: AgentStatus }];
  usage: [{ agentId: string; taskId: string; usage: AgentUsage }];
  /** The agent surfaced an artifact/link mid-run (already persisted, deduped by ref). */
  flag: [{ agentId: string; taskId: string; flag: AgentFlag }];
  /** The agent filed something outside its own task (already persisted). `created` is false for a verbatim repeat. */
  /** The agent asked for work only a person can do (already persisted). `created` is false for a repeat. */
  humanTask: [{ agentId: string; taskId: string; humanTask: HumanTask; created: boolean }];
  /** The agent said what it is working on (already persisted onto its row, replacing the previous note). */
  progress: [{ agentId: string; taskId: string; note: string; notedAt: string }];
  /** The agent said whether its issue is finished (already persisted against the issue origin). */
  conclusion: [{ agentId: string; taskId: string; conclusion: IssueConclusion }];
  assessment: [{ agentId: string; taskId: string; issueOrigin: string; verdict: AssessmentVerdict }];
  /** The appraiser said whether its issue's goal can be worked from (already persisted against the issue origin). */
  appraisal: [{ agentId: string; taskId: string; issueOrigin: string; verdict: GoalAppraisalVerdictName }];
  /** A planner found its issue's goal already met (already persisted as a delivery verdict). */
  goalMet: [{ agentId: string; taskId: string; issueOrigin: string }];
  /** The agent closed its plan part without a pull request (already persisted on the part row). */
  partOutcome: [{ agentId: string; taskId: string; part: PlanPart }];
  /** The agent left a note on its issue's shared pad (already persisted, append-only). */
  scratch: [{ agentId: string; taskId: string; entry: ScratchEntry }];
  /** The retrospective for a delivered goal was written (already persisted against the issue origin). */
  retrospective: [{ agentId: string; taskId: string; issueOrigin: string }];
  /**
   * An agent accounted for why it had to come back to a pull request (already
   * persisted). Nothing schedules off this — it is the repaint.
   */
  remedy: [{ agentId: string; taskId: string; originRef: string }];
  /** The file-events hook recorded one or more written files (the "files changed" list grew). */
  files: [{ agentId: string; taskId: string }];
  /**
   * A parked agent was seen making a tool call, so the open alert against it is
   * probably stale. Already persisted as `Agent.resumedAt`.
   */
  resumed: [{ agentId: string; taskId: string; resumedAt: string }];
  /**
   * The account's usage limit ran out under this agent, so it is parked rather than
   * failed. Already persisted as `waiting`; `resetsAt` is null when `claude` did not say.
   */
  limited: [{ agentId: string; taskId: string; reason: string; resetsAt: string | null }];
}

/**
 * Owns the fleet of live agent sessions: spawn, stream, detect waiting/done, feed
 * input, kill. Whitelisted waiting prompts are auto-answered; everything else surfaces
 * as a `waiting` event. `implements AgentToolTarget` makes the tool-facing methods
 * below a checked contract. → `docs/spec/10-agent-runtimes.md`
 */
export class AgentManager extends EventEmitter implements AgentToolTarget {
  private readonly sessions = new Map<string, AgentSession>();
  // Exit code per agent, so a `failed` terminal records its cause.
  private readonly exitCodes = new Map<string, number>();
  // The two halves of a 'reaped' emission; their order differs per runtime.
  private readonly terminals = new Map<string, 'done' | 'failed' | 'killed'>();
  private readonly exited = new Set<string>();
  // agentId → its file-events spool key, for draining and disposing the hook's dir.
  private readonly eventsKeys = new Map<string, string>();
  // agentId → its MCP credential, revoked when the agent leaves the fleet.
  private readonly mcpTokens = new Map<string, string>();
  // Agents parked on a human; the convergence latch for the `escalate` tool and the
  // WAITING sentinel, so whichever fires first owns it and the second is a no-op.
  private readonly parked = new Set<string>();
  // agentId → the park held for a spent account limit (unanswerable; see resumeParked). In memory only.
  private readonly limited = new Map<string, LimitPark>();
  // agentId → stall nudges sent, a whole-life budget reset by resume. In memory only.
  private readonly nudges = new Map<string, number>();
  // agentId → when its park settles itself `done`, epoch ms. Entered for an unanswered
  // stall or a silence park, never for a park the agent asked for. Every path that ends
  // a stop must drop the clock too (respond, releasePark, handleLimited, resumeParked),
  // with completeExpiredStalls as the backstop.
  private readonly stalled = new Map<string, StallClock>();

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
  ) {
    super();
  }

  /**
   * Spawn an agent for a task in the given working directory. `resumeSessionId`
   * re-dispatches an origin into its last agent's conversation; a runtime that cannot
   * resume ignores it. A re-dispatch re-attaches through here, never through
   * {@link AgentManager.resume}: this writes a new agent row, so two rows sharing one
   * `sessionId` is correct. → `docs/spec/10-agent-runtimes.md#inheriting-a-conversation-on-re-dispatch`
   */
  spawn(task: Task, cwd: string, resumeSessionId?: string | null): Agent {
    // A runtime that cannot resume falls back to a cold launch rather than refusing.
    const inherited = this.opts.resumable ? (resumeSessionId ?? null) : null;
    // Chosen up front so the harness can --resume this exact conversation after a restart.
    const sessionId = inherited ?? (this.opts.resumable ? randomUUID() : null);
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    // Minted before the session so `--mcp-config` has a file; bound to the agent row
    // the moment it exists, before any tool call is possible.
    const extraServers = task.mcpServers ?? [];
    const mcp = this.opts.mcp?.open(extraServers) ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: sessionId ?? '',
        extraAllowedTools: extraMcpGrants(extraServers),
        // `--resume` on an inherited id, `--session-id` on a minted one, never both.
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
      // A synchronous spawn failure must not leave an agent stuck in `starting`.
      this.failSpawn(agent.id, task.id, err as Error);
      throw err;
    }

    this.deliverAfterBoot(agent.id, session, this.opts.initialInput?.(task) ?? null);

    return agent;
  }

  /**
   * Re-attach to an agent orphaned by a server restart, reusing its row, session id and
   * cwd. Best-effort: false when the runtime cannot resume or there is no session id, a
   * no-op when already live. Must be handed a torn-down agent.
   * → `docs/spec/10-agent-runtimes.md#auto-resume-on-a-mid-run-crash`
   */
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
        // Stored values: a restart cannot move a half-finished conversation onto a different model or depth.
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
      // Best-effort: drop the session so the boot reconciler marks the agent interrupted.
      this.sessions.delete(agent.id);
      throw new Error(`resume spawn failed for agent ${agent.id}: ${(err as Error).message}`);
    }

    if (wasWaiting) {
      this.restoreWaiting(agent, task);
    } else {
      const carryOn = nudge ?? this.opts.resumeInput?.() ?? null;
      // Echoed, unlike a fresh dispatch's prompt, so the transcript shows what it was told.
      if (carryOn !== null) this.noteSent(agent.id, session, carryOn);
      this.deliverAfterBoot(agent.id, session, carryOn);
    }

    return true;
  }

  /**
   * End a usage-limit park: the account can work again. Shared by {@link resumeExpiredParks}
   * and the cockpit's Resume. A live session takes a message; an exited one re-opens
   * through {@link resume}. Only a park this process holds is a candidate — one held
   * across a restart is the recovery desk's — and the park is put back on failure.
   * → `docs/spec/10-agent-runtimes.md`
   */
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
      // No unanswered stop is left for a clock to settle, or the resumed agent gets killed mid-turn.
      this.stalled.delete(agentId);
      this.store.setAgentResumed(agentId, null);
      // Cleared before either arm: `resume` must not re-establish this exact park.
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

  /**
   * End every park whose window has already turned over. A park with no `resetsAt` is
   * left alone permanently — the operator's Resume is the only way out. No headroom
   * check: a parked agent held its slot throughout. Returns the parks it could not end.
   */
  resumeExpiredParks(): LimitResumeFailure[] {
    const now = Date.now();
    const failures: LimitResumeFailure[] = [];
    // Copied before iterating: `resumeParked` deletes from the map it walks.
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

  /** Every agent this process is holding parked on a spent account limit. */
  limitedAgentIds(): string[] {
    return [...this.limited.keys()];
  }

  /** Every unannounced-stop park this process holds, and when each settles itself. Asked of the fleet, not derived from the rows. */
  stallDeadlines(): StallPark[] {
    return [...this.stalled].map(([agentId, clock]) => ({ agentId, expiresAt: new Date(clock.at).toISOString() }));
  }

  /** "No, wait" — push a stall park's countdown out by `agentStallExtendMs` from now. Only a counting park can be extended. */
  extendStallPark(agentId: string): { ok: true; expiresAt: string } | { ok: false; error: string } {
    const clock = this.stalled.get(agentId);
    if (!clock) return { ok: false, error: 'this agent is not parked on an unannounced stop' };
    const at = Date.now() + (this.opts.stallExtendMs ?? 0);
    // The grace rides through untouched — that is what the agent buys back by working.
    clock.at = at;
    const expiresAt = new Date(at).toISOString();
    debugLog('agent', `stall park extended agent=${agentId} until=${expiresAt}`);
    return { ok: true, expiresAt };
  }

  /**
   * Settle every stall park whose countdown has run out — the sibling of
   * {@link resumeExpiredParks}. Nothing here is destructive: {@link complete} keeps
   * the branch, commits and PR, and releases the worktree slot. Returns the ids it settled.
   */
  completeExpiredStalls(): string[] {
    const now = Date.now();
    const settled: string[] = [];
    // Copied before iterating: `complete` deletes from the map it walks.
    for (const [agentId, clock] of [...this.stalled]) {
      if (clock.at > now) continue;
      // A limit park has its own ending.
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

  /**
   * Write a message sent to an agent into its transcript. The stream runtime renders
   * only what comes back, so without this a typed message leaves no trace; the PTY
   * runtime carries both halves itself ({@link AgentSession.recordsSentMessages}). The
   * first message of a dispatch is deliberately not echoed — a task prompt is kilobytes.
   */
  private noteSent(agentId: string, session: AgentSession, text: string): void {
    if (session.recordsSentMessages) return;
    const note = renderBlocks([{ type: HUMAN_BLOCK, text }], new Date().toISOString());
    if (!note) return;
    this.store.appendTranscript(agentId, note);
    this.emit('output', { agentId, delta: note });
  }

  /**
   * Type a harness message into a live agent without touching its state: unlike
   * {@link respond} it ends no park and moves no status. A parked agent is skipped
   * outright — typing past a park would look like the answer arriving.
   * → `docs/spec/27-obstacles.md#delivery`
   */
  notify(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session || this.parked.has(agentId)) return false;
    this.noteSent(agentId, session, text);
    try {
      session.send(text);
    } catch {
      return false; // the session went away between the read and the write
    }
    return true;
  }

  /** Type text into a live agent (a human response or a follow-up prompt). */
  respond(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    this.noteSent(agentId, session, text);
    session.send(text);
    this.parked.delete(agentId); // the park is over; the next ask is a new one
    this.limited.delete(agentId); // ...including a limit park an operator typed straight past
    this.stalled.delete(agentId); // ...and a stall park an answer overtook: it is working again
    this.store.setAgentResumed(agentId, null); // answered, so "it carried on anyway" is spent
    this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
    return true;
  }

  /**
   * Resolve the caller a tool call arrived as (`token -> agent -> task -> origin`) and
   * run the call against it. No write tool takes an agent/task/issue argument, so an
   * agent cannot address another's work. Deliberately does not check liveness —
   * {@link ask} is the one caller that needs a live session and tests for it itself.
   */
  private withCaller<R extends { ok: true } | { ok: false; error: string }>(
    agentId: string,
    fn: (caller: { agent: Agent; task: Task }) => R,
  ): R | { ok: false; error: string } {
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    return fn({ agent, task });
  }

  /**
   * Park an agent on a human question raised through the `escalate` MCP tool — the
   * same transition the WAITING sentinel drives, through the same
   * {@link handleWaiting}. `escalationId` is null when a whitelist rule auto-answered
   * and the agent was never parked.
   */
  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string } {
    if (!this.sessions.has(agentId)) return { ok: false, error: 'agent is no longer live' };
    return this.withCaller(agentId, ({ task }) => {
      const question = ask.question.trim();
      if (!question) return { ok: false, error: 'question must not be empty' };
      this.handleWaiting(agentId, task, question, ask);
      // Listeners are synchronous, so by now the inbox has either created the
      // escalation or the whitelist answered and moved the agent back to running.
      const open = this.store.listOpenEscalations().find((e) => e.agentId === agentId) ?? null;
      return { ok: true, escalationId: open?.id ?? null };
    });
  }

  /** Ask for work only a person can do (`request_human_task` tool). Routed through the manager so `humanTask` repaints the cockpit at once. Does not require a live session. */
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

  /**
   * What this agent was dispatched to file, resolved from its credential. Split out of
   * {@link linkTicket} because the harness must know the arm before it files: a bug is
   * a different work item type, linked back to its story.
   */
  filingTarget(agentId: string): FilingTargetResult {
    return this.withCaller(agentId, ({ task }): FilingTargetResult => {
      const jobId = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
      const bug = jobId ? this.store.findBugFilingByJobId(jobId) : null;
      if (bug) {
        // `issue:12` — the story the operator raised it from.
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

  /** Record the ticket a filing job produced (`link_ticket` tool). Resolved via the credential like {@link filingTarget}; an agent on any other task resolves to nothing. */
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
      // A bug is an issue in both trackers.
      if (!ticketRef.startsWith('issue:')) {
        return { ok: false, error: `A bug must be an issue ref like "issue:314"; got "${ticketRef}".` };
      }
      // Idempotence lives in the write, not in a read-then-check here.
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

  /** Record what an agent says it is working on (`note_progress` tool). Through the manager so the cockpit repaints on the note, not the next pulse. */
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const notedAt = this.store.recordAgentNote(agentId, note);
      this.emit('progress', { agentId, taskId: task.id, note, notedAt });
      return { ok: true, notedAt };
    });
  }

  /**
   * Append to the shared pad for the issue this agent is working (`scratch_append`
   * tool). Resolved via {@link padWriteTarget}; a caller outside its subtree is refused
   * outright rather than scoped down.
   */
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

  /** Read the whole pad for this agent's issue (`scratch_read` tool). Same access rule as the write; refused rather than handed an empty pad. */
  readScratch(agentId: string): { ok: true; padRef: string; entries: ScratchEntry[] } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const target = padWriteTarget(task.originRef);
      if (!target.ok) return { ok: false, error: target.error };
      return { ok: true, padRef: target.padRef, entries: this.store.listScratchEntries(target.padRef) };
    });
  }

  /**
   * Record the retrospective this agent was dispatched to write (`retro_submit` tool).
   * {@link retroSubmitOrigin} refuses every other caller by name, so the agent that did
   * the work cannot write its own account; idempotence is the store's upsert.
   */
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

  /**
   * Record the Feature summary this agent was dispatched to write. Every other caller
   * is refused by name. The standing key is stamped here at submission — see
   * {@link AgentManagerOptions.featureStanding}. No event, deliberately: the feature
   * board is fetched when opened and never polled.
   */
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

  /**
   * Record the story order this agent was dispatched to propose. Every other caller is
   * refused by name. Always writes `proposed` — an order holds work, and only a
   * person's acceptance may do that. → `docs/spec/33-story-sequencing.md`
   */
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
      // Carries the operator's answer only when the new order provably extends the old one; else re-asks.
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
      // `recordFeatureSequence` always clears the answer, so re-stating it is an explicit claim.
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

  /**
   * Record why this agent had to come back to a pull request (`report_remedy` tool).
   * {@link remedyOrigin} refuses every other caller by name; checks come from the task
   * row, never the submission. It is only the event record — anything that outlives
   * the PR goes through `raise`. → `docs/spec/18-observability.md`
   */
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

  /**
   * Record whether the issue an agent was dispatched for is finished (`conclude_work`
   * tool). {@link conclusionOrigin} enforces that "done" means the issue, not one part
   * of it — a part agent is refused rather than quietly scoped to its part.
   */
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
      // Settle standing instructions on conclusion, whatever the verdict — dispatch-time settling loses one to a dying agent.
      this.store.settleInstructions(origin.originRef);
      this.emit('conclusion', { agentId, taskId: task.id, conclusion });
      return { ok: true, conclusion };
    });
  }

  /**
   * Park the goal this agent could not finish behind the obstacle that stopped it. It
   * writes no conclusion — a `more_work` row here would send the next agent straight
   * into the same wall. The obstacle must exist, or the park has nothing to lift it.
   * → `docs/spec/27-obstacles.md#blocked-is-an-answer`
   */
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

  /**
   * Record an assessor's verdict on the issue it was dispatched to judge. `delivered`
   * writes the harness's park and gates pickup; a shortfall gates nothing and exists to
   * release work. Their mutual exclusion is enforced in the store, never here. Does not
   * write `issue_conclusions` — `resolveIssueConclusion` ranks the two records instead.
   */
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

      // The discriminator is the plan row, not its parts.
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

  /**
   * Record a planner's "this goal is already met" (`plan_not_needed` tool).
   * {@link plannerOrigin} refuses every other caller by name. Refused when the issue
   * already has a plan row (a replan) or a standing shortfall (an assessor already said
   * the goal is not reached) — recording a delivery in either case would silently
   * overwrite that state.
   */
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

  /**
   * Record an appraiser's verdict on the goal it was dispatched to judge. The
   * fingerprint is taken from the task, not the world: re-reading the issue here would
   * stamp the verdict with what the ticket says *now*, silently swallowing a mid-run
   * edit that `appraisalHold` should have re-opened.
   */
  recordAppraisal(
    agentId: string,
    verdict: GoalAppraisalVerdictName,
    summary: string,
    profile: string | null,
    placement?: { parent: number | null; areaPath: string | null },
  ):
    | { ok: true; issueOrigin: string; verdict: GoalAppraisalVerdictName; profileHeld: boolean }
    | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = appraiserOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };

      // Decided here, once, rather than as a config lookup at read time a caller could forget.
      const proposedProfile = this.opts.goalProfile && profile ? profile : null;
      const profileHeld =
        proposedProfile !== null && proposedProfile !== this.opts.goalProfile?.effective(origin.issueOrigin);
      this.store.recordAppraisal({
        originRef: origin.issueOrigin,
        verdict,
        summary,
        goalRef: goalFingerprint(task.originTitle, task.originSummary),
        by: 'appraiser',
        proposedProfile,
        profileDiverges: profileHeld,
        // Stored exactly as proposed, with no check that the item still lacks the field — a record of what was said.
        proposedParent: placement?.parent ?? null,
        proposedAreaPath: placement?.areaPath ?? null,
        agentId,
        taskId: task.id,
      });
      this.emit('appraisal', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
      return { ok: true, issueOrigin: origin.issueOrigin, verdict, profileHeld };
    });
  }

  /**
   * Record what a plan part produced, for a part that finished without a pull request.
   * Identity is structural: the part is resolved from the credential's task origin, so
   * an agent cannot conclude a sibling's work.
   */
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
      // Only a part still being worked moves.
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

  /** Send Ctrl-C to a live agent. Status is not mutated here — the agent's own output/exit drives it. */
  interrupt(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    session.sendRaw('\x03');
    return true;
  }

  kill(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    // A usage-limit park has no live session and no ending, and the operator must be able to abandon one.
    if (!session && !this.limited.has(agentId)) return false;
    session?.kill();
    this.disposeFileEvents(agentId); // fold any last writes in, then drop the spool
    this.releaseMcp(agentId); // the credential dies with the agent, not with the process
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.stalled.delete(agentId);
    this.store.flushTranscript(agentId);
    const agent = this.store.getAgent(agentId);
    this.store.updateAgent(agentId, { status: 'killed', endedAt: new Date().toISOString(), pid: null });
    if (agent) this.store.updateTask(agent.taskId, { status: 'interrupted' });
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId); // a deliberate kill's exit code is not a failure cause
    // Still has to be reaped, or the worktree lease outlives the process.
    this.terminals.set(agentId, 'killed');
    if (!session) {
      // Usage-limit-park arm: the process already exited, so `exited` needs setting here.
      this.exited.add(agentId);
    }
    if (agent) {
      this.reflectStatus(agentId, agent.taskId, 'killed');
      this.maybeReap(agentId, agent.taskId);
    }
    return true;
  }

  /**
   * The operator declaring an agent finished — routes through the same
   * {@link handleTerminal} the sentinel drives, so a completed agent is recorded
   * identically to a finished one. Liveness is the whole guard: false here becomes a 409.
   */
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
      // `human:` for the click, `stall:` for the countdown — two different answers to
      // "who ended this run".
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

  /**
   * Stop every live agent because the server is going down. Left `interrupted`, never
   * `killed`, so the next boot re-attaches them; `waitingReason` and task status are
   * preserved as the resume signal.
   */
  interruptAll(): void {
    const at = new Date().toISOString();
    for (const id of [...this.sessions.keys()]) {
      const session = this.sessions.get(id);
      try {
        session?.kill();
      } catch {
        /* process already gone */
      }
      this.disposeFileEvents(id); // a resume mints a fresh spool
      this.releaseMcp(id); // ...and a fresh credential
      this.store.flushTranscript(id);
      this.store.updateAgent(id, { status: 'interrupted', endedAt: at, pid: null });
      this.sessions.delete(id);
      this.exitCodes.delete(id);
      this.exited.delete(id);
      this.parked.delete(id); // the row's waitingReason survives; `restoreWaiting` re-latches
      this.limited.delete(id); // only this process's offer to resume is dropped
    }
  }

  // -- internals -----------------------------------------------------------

  /** The LUBBDUBB_EVENTS_DIR env entry for a launch, when the file-events hook is wired. */
  private eventsDirEnv(key: string | null): Record<string, string> {
    if (!key || !this.opts.fileEvents) return {};
    const env: Record<string, string> = { LUBBDUBB_EVENTS_DIR: this.opts.fileEvents.dirFor(key) };
    // The hook's own breadcrumb logging, so "did it even fire?" is answerable agent-side.
    if (debugEnabled()) env.LUBBDUBB_EVENTS_DEBUG = '1';
    return env;
  }

  /** The spool dir an agent's writes land in (where LUBBDUBB_EVENTS_DIR points), or null. */
  fileEventsDir(agentId: string): string | null {
    const key = this.eventsKeys.get(agentId);
    return key && this.opts.fileEvents ? this.opts.fileEvents.dirFor(key) : null;
  }

  /** Drain the file-events spool, folding each captured write into the files list (and, for report-like paths, an artifact chip). Idempotent. */
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

  /** Record one captured write; promote report-like paths to an artifact chip. */
  private ingestFileEvent(agent: Agent, rec: FileEventRecord): void {
    const path = toWorktreeRelative(agent.cwd, rec.path);
    const { promoted, kind } = classifyArtifact(path, this.opts.docsFolderPrefix);
    debugLog(
      'fileEvents',
      `agent=${agent.id} write path=${path} tool=${rec.tool ?? '?'} promoted=${promoted} kind=${kind}`,
    );
    this.store.recordFile(agent.id, { path, tool: rec.tool, promoted });
    this.emit('files', { agentId: agent.id, taskId: agent.taskId });
    // Must read the plan here while `agent.cwd` still exists — the reap removes a done agent's worktree.
    if (isPlanFile(path)) this.ingestPlan(agent, path);
    if (promoted) {
      // Reuse the flag path, so a report becomes a chip through the same dedup machinery.
      const flag = this.store.recordFlag(agent.id, { kind, label: basename(path), ref: path });
      this.emit('flag', { agentId: agent.id, taskId: agent.taskId, flag });
    }
  }

  /**
   * Persist a planning agent's plan from the `plan.json` it just wrote. Stored whatever
   * its size, or the planner re-runs every cycle. A replan lands here too, merged on
   * slug so an in-flight part keeps its branch and PR.
   */
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
      // No plan row, so the issue stays in the funnel until the attempt cap fails it open to `single`.
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id} wrote an invalid ${PLAN_FILE} for issue #${number}: ${parsed.error}`,
      });
      return;
    }
    const doc = parsed.document;
    const origin = issueOrigin(number);
    // Shared with the `plan_submit` tool, so the two paths cannot drift.
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
    // Fire-and-forget: the drain is synchronous. A refusal has no author here, so it is recorded, not returned.
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

  /** Final drain + spool teardown for an agent that's leaving the fleet. */
  private disposeFileEvents(agentId: string): void {
    const key = this.eventsKeys.get(agentId);
    if (!key || !this.opts.fileEvents) return;
    this.drainFileEvents(agentId); // catch writes from the last turn before dropping the dir
    // Empty (with debug on) means the hook never ran, so the fault is upstream of the spool.
    if (debugEnabled()) {
      const crumbs = this.opts.fileEvents.readDebug(key);
      debugLog('fileEvents', `agent=${agentId} hook fired ${crumbs.length} time(s)`);
      for (const c of crumbs) debugLog('fileEvents', `agent=${agentId} hook: ${c}`);
    }
    this.opts.fileEvents.dispose(key);
    this.eventsKeys.delete(agentId);
  }

  /** Attach the store-update + re-emit listeners shared by fresh spawns and resumes. */
  private wireSession(session: AgentSession, agentId: string, task: Task): void {
    session.on('output', (delta: string) => {
      this.store.appendTranscript(agentId, delta);
      this.emit('output', { agentId, delta });
      // Piggyback the spool drain on the output stream, so writes surface without a polling timer.
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

    // One account, so this is not news about this agent; the store's freshest-wins guard keeps reports in order.
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
    // Both runtimes emit `exit` before `failed`, so the code is in hand at the terminal.
    session.on('exit', (code: number) => {
      this.exitCodes.set(agentId, code);
      this.exited.add(agentId);
      // A limit park outlives its process with no terminal following, so give back its resources here.
      if (this.limited.has(agentId)) this.shedLimitedSession(agentId);
      this.maybeReap(agentId, task.id);
    });
    session.on('done', () => this.handleTerminal(agentId, task.id, 'done'));
    session.on('failed', () => {
      const attempts = this.autoResume(session, agentId, task);
      if (attempts === null) return; // re-attached; the row and the task stay live
      this.handleTerminal(
        agentId,
        task.id,
        'failed',
        'agent',
        attempts > 0 ? `after ${attempts} automatic resume${attempts === 1 ? '' : 's'}` : undefined,
      );
    });
  }

  /**
   * A live agent's process died mid-run: re-open its own conversation rather than
   * settling the task. Bounded by {@link AgentManagerOptions.resumeAttempts}, counted
   * on the agent row so it spans restarts. Returns null when it re-attached, else how
   * many resumes had been spent. The teardown below is load-bearing: {@link resume}
   * was written for boot, so it must be handed a torn-down agent or it leaks a spool
   * dir and leaves a bearer credential live. → `docs/spec/10-agent-runtimes.md#auto-resume-on-a-mid-run-crash`
   */
  private autoResume(session: AgentSession, agentId: string, task: Task): number | null {
    const limit = this.opts.resumeAttempts ?? 0;
    // A session no longer the agent's was ended deliberately (kill, complete); do not resurrect it.
    if (limit <= 0 || !this.opts.resumable || this.sessions.get(agentId) !== session) return 0;
    const agent = this.store.getAgent(agentId);
    if (!agent?.sessionId) return agent?.resumeAttempts ?? 0;
    if (!existsSync(agent.cwd)) return agent.resumeAttempts; // nothing to resume into
    if (agent.resumeAttempts >= limit) return agent.resumeAttempts;

    // Counted before the relaunch: a resume that dies during `start()` must still cost a life.
    const attempts = this.store.countAgentResumeAttempt(agentId);
    this.disposeFileEvents(agentId);
    this.releaseMcp(agentId);
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exited.delete(agentId); // not reaped: it is coming back
    debugLog('agent', `auto-resume agent=${agentId} attempt=${attempts}/${limit}`);
    try {
      // `resume` reads `waitingReason`, so a parked crash comes back parked.
      if (this.resume({ ...agent, resumeAttempts: attempts }, task)) return null;
    } catch (err) {
      this.store.appendTranscript(agentId, `\nResume after crash failed: ${(err as Error).message}\n`);
    }
    return attempts;
  }

  /**
   * Deliver a first message once the process has had `promptDelayMs` to boot — stream
   * transport is ready at once, an interactive terminal needs its REPL. No-op on null.
   */
  private deliverAfterBoot(agentId: string, session: AgentSession, text: string | null): void {
    if (text === null) return;
    const delay = this.opts.promptDelayMs ?? 0;
    const deliver = (): void => {
      if (!this.sessions.has(agentId)) return; // killed/finished before we could send
      try {
        session.send(text);
      } catch {
        /* session already gone */
      }
    };
    if (delay <= 0) deliver();
    else setTimeout(deliver, delay).unref?.();
  }

  /**
   * Put a resumed agent back into the parked `waiting` state it held before the
   * restart. The escalation raised then is persisted; if it is gone, re-raise one.
   */
  private restoreWaiting(agent: Agent, task: Task): void {
    const reason = agent.waitingReason ?? 'Resumed agent is awaiting your input.';
    this.parked.add(agent.id); // still parked across the restart; don't re-park on a re-announce
    this.store.updateAgent(agent.id, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agent.id, task.id, 'waiting');
    const hasOpen = this.store.listOpenEscalations().some((e) => e.agentId === agent.id);
    if (!hasOpen) this.emit('waiting', { agentId: agent.id, taskId: task.id, reason });
  }

  /**
   * An agent ended a turn with no sentinel in it. The stop is not itself a question:
   * the agent is asked first, up to `stallNudges` times, and only a stop that survives
   * the budget is put to a person.
   */
  private handleStalled(session: AgentSession, agentId: string, task: Task, lastWords: string): void {
    // An already-parked agent is waiting on a person; nudging would type into that.
    if (this.parked.has(agentId)) return;
    const budget = this.opts.stallNudges ?? 0;
    const spent = this.nudges.get(agentId) ?? 0;
    // A dead process cannot be asked anything — park it.
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

  /**
   * The runtime has heard nothing for `agentSilenceParkMs` — the agent is wedged
   * inside a turn rather than stopped at the end of one, so it is not nudged; it goes
   * straight to the park and the countdown.
   */
  private handleSilent(agentId: string, task: Task, silenceMs: number): void {
    if (this.parked.has(agentId)) return;
    debugLog('agent', `silence park agent=${agentId} after=${silenceMs}ms`);
    this.handleWaiting(agentId, task, silenceReason(silenceMs));
    // Grace is this agent's own silence window, since it just proved it goes quiet that long.
    this.armStallClock(agentId, this.opts.stallParkMs ?? 0, 'silence', this.opts.silenceParkMs ?? 0);
  }

  /** Start a park's countdown — the one place either park's clock is armed. */
  private armStallClock(agentId: string, window: number, kind: 'stall' | 'silence', grace = window): void {
    if (window <= 0 || !this.parked.has(agentId) || this.limited.has(agentId)) return;
    this.stalled.set(agentId, { at: Date.now() + window, grace: grace > 0 ? grace : window });
    debugLog('agent', `${kind} park armed agent=${agentId} window=${window}ms grace=${grace}ms`);
  }

  private handleWaiting(agentId: string, task: Task, reason: string, ask?: AgentAsk): void {
    // Convergence point for the two ways an agent asks; an already-parked agent is not parked again.
    if (this.parked.has(agentId)) return;
    // Pending writes must surface here too — the escalation is often "review the file I just wrote".
    this.drainFileEvents(agentId);
    const rule = this.opts.whitelistedApprovals.find((r) => reason.includes(r.match));
    if (rule) {
      // Auto-answered, so no latch: its next question is a fresh park.
      this.respond(agentId, rule.response);
      this.emit('autoAnswered', { agentId, taskId: task.id, reason, response: rule.response });
      return;
    }
    this.parked.add(agentId);
    // A fresh park is a fresh question; must not mark it stale on arrival.
    this.store.setAgentResumed(agentId, null);
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('waiting', { agentId, taskId: task.id, reason, ask });
  }

  /**
   * Park an agent because the account ran out, not because it asked anything. Same
   * latch and store writes as {@link handleWaiting} but not the same event: `waiting`
   * raises an escalation, this park has no answer. Nothing is settled — session id,
   * task and worktree are all what {@link resumeParked} needs.
   */
  private handleLimited(agentId: string, task: Task, park: RateLimitPark): void {
    if (this.limited.has(agentId)) return;
    const reason = rateLimitParkReason(park);
    this.drainFileEvents(agentId);
    this.store.flushTranscript(agentId);
    const asked = this.parked.has(agentId);
    this.limited.set(agentId, { reason, resetsAt: park.resetsAt });
    this.parked.add(agentId);
    // A stall countdown does not survive the account running out — a limit park has its own ending.
    this.stalled.delete(agentId);
    this.store.setAgentResumed(agentId, null);
    // An agent that asked and then ran the account out keeps its question on the row.
    this.store.updateAgent(agentId, asked ? { status: 'waiting' } : { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('limited', { agentId, taskId: task.id, reason, resetsAt: park.resetsAt });
    // The process may have exited before declaring the park, in which case the exit handler saw no limit yet.
    if (this.exited.has(agentId)) this.shedLimitedSession(agentId);
  }

  /**
   * Give back what the dead launch held while keeping the park. Leaving the credential
   * bound leaks a live bearer token for the length of a park; a stale `exited` entry
   * would make the resumed run's first terminal reap a worktree from under a live agent.
   */
  private shedLimitedSession(agentId: string): void {
    this.disposeFileEvents(agentId);
    this.releaseMcp(agentId);
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exited.delete(agentId);
    this.store.updateAgent(agentId, { pid: null });
  }

  /** Put a limit park back after a resume that could not be carried out. */
  private reinstateLimitPark(agentId: string, task: Task, park: LimitPark): void {
    this.limited.set(agentId, park);
    this.parked.add(agentId);
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: park.reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
  }

  /**
   * Record that a parked agent made a tool call — it is working, not waiting.
   * Deliberately does not un-park it, which would desync the latch and let the next
   * turn-end file a second escalation. Idempotent.
   */
  private noteResumed(agentId: string, taskId: string): void {
    if (!this.parked.has(agentId)) return;
    // Pushed out, not dropped, or an agent that works a minute more then goes quiet parks forever.
    // Never pulled in: an operator's Extend outlives any grace.
    const clock = this.stalled.get(agentId);
    if (clock) clock.at = Math.max(clock.at, Date.now() + clock.grace);
    const resumedAt = new Date().toISOString();
    this.store.setAgentResumed(agentId, resumedAt);
    this.emit('resumed', { agentId, taskId, resumedAt });
  }

  /**
   * Drop the park latch without typing anything into the agent — what dismissing an
   * alert does. `status` is left alone: a dismissed alert makes no claim about whether
   * the agent is working.
   */
  releasePark(agentId: string): void {
    this.parked.delete(agentId);
    // The countdown goes with the alert, or it would finish an agent nobody is watching.
    this.stalled.delete(agentId);
    this.store.setAgentResumed(agentId, null);
  }

  /** Roll back a spawn that threw before the session ever came up. */
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
    /** Appended to the recorded failure, e.g. how many automatic resumes were spent. */
    failureNote?: string,
  ): void {
    this.drainFileEvents(agentId); // catch a report written just before finishing
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
      // Exit code plus a tail of the output, so "why did it die" is answerable from the Errors panel.
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

  /** Emit 'reaped' once a finished agent's process has also exited (whichever came second). */
  private maybeReap(agentId: string, taskId: string): void {
    const status = this.terminals.get(agentId);
    if (!status || !this.exited.has(agentId)) return;
    this.terminals.delete(agentId);
    this.exited.delete(agentId);
    this.disposeFileEvents(agentId); // process is gone; drop its spool dir
    this.releaseMcp(agentId);
    this.emit('reaped', { agentId, taskId, status });
  }

  /** Revoke an agent's MCP credential and remove its launch config. Idempotent. */
  private releaseMcp(agentId: string): void {
    const token = this.mcpTokens.get(agentId);
    if (!token) return;
    this.mcpTokens.delete(agentId);
    this.opts.mcp?.release(token);
  }

  private reflectStatus(agentId: string, taskId: string, status: AgentStatus): void {
    this.emit('status', { agentId, taskId, status });
  }

  // Typed emit/on overrides for a nicer call site.
  override emit<K extends keyof AgentManagerEvents>(event: K, ...args: AgentManagerEvents[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof AgentManagerEvents>(event: K, listener: (...args: AgentManagerEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

/** What a resumed agent is told after a limit park; deliberately not "you were resumed after a server restart", since nothing restarted. */
const LIMIT_RESUME_MESSAGE =
  'This account hit its usage limit mid-turn, so the harness parked you. The limit has cleared and ' +
  'you have been resumed. Nothing else changed — the worktree and the conversation are the ones you ' +
  'left. Continue the task from where you stopped.';

/** How `claude` names each usage window, in words an operator reads. */
const LIMIT_WINDOWS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'seven-day',
  seven_day_opus: 'seven-day Opus',
  seven_day_sonnet: 'seven-day Sonnet',
  seven_day_overage_included: 'seven-day (overage included)',
  overage: 'overage',
};

/** The sentence stored on the row: the account ran out, not the agent — "waiting" alone reads as an unanswered question. */
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

/** Reduce a hook-reported write path to worktree-relative when it landed inside the agent's cwd; normalised to forward slashes since the path is used as an artifact ref. */
function toWorktreeRelative(cwd: string, p: string): string {
  const toPosix = (s: string): string => s.replace(/\\/g, '/');
  if (!isAbsolute(p)) return toPosix(p);
  const rel = relative(cwd, p);
  return toPosix(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p);
}
