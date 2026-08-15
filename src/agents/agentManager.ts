import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import { recentOutputExcerpt } from '../escalation/context.js';
import type { WhitelistRule } from '../config.js';
import type {
  Agent,
  AgentAsk,
  AgentFlag,
  AgentStatus,
  AgentUsage,
  Finding,
  FindingInput,
  HumanTask,
  HumanTaskInput,
  IssueConclusion,
  IssueConclusionVerdict,
  PartOutcomeKind,
  PlanPart,
  ScratchEntry,
  ShortfallCause,
  Task,
  WorkItemFiling,
  BugFiling,
} from '../types.js';

/**
 * What `link_ticket` settled. A filing job is created for a finding, for a work
 * item, *or* for a bug an operator raised — never more than one, so the arms are
 * exclusive — kept as a union rather than three nullable fields so a caller
 * cannot read the ones that were not filled.
 */
type LinkTicketResult =
  | { ok: true; finding: Finding; filing?: undefined; bug?: undefined }
  | {
      ok: true;
      filing: WorkItemFiling;
      finding?: undefined;
      bug?: undefined;
      /** How many of the operator's images moved from the filing job onto the ticket (issue #249). */
      attachments: number;
    }
  | { ok: true; bug: BugFiling; finding?: undefined; filing?: undefined }
  | { ok: false; error: string };
import { conclusionOrigin } from '../issueConclusion.js';
import { assessmentOrigin, type AssessmentVerdict } from '../mcp/assessment.js';
import { assayerOrigin, type GoalAssayVerdictName } from '../mcp/goalAssay.js';
import { goalFingerprint } from '../intake/assay.js';
import { padWriteTarget } from '../scratch/pad.js';
import { retroSubmitOrigin } from '../retro/retro.js';
import { partConclusionOrigin } from '../mcp/partOutcome.js';
import type { AgentToolTarget } from '../mcp/tools/context.js';
import type { ParsedFlag } from './sentinels.js';
import { classifyArtifact, type FileEventRecord, type FileEventsSpool } from './fileEvents.js';
import { PLAN_FILE, isPlanFile, parsePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument } from '../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../plans/planning.js';
import { liveParts } from '../plans/parts.js';
import type { AgentSession, SessionFactory } from './session.js';
import type { RateLimitPark } from './streamJsonSession.js';
import { debugEnabled, debugLog } from '../debug.js';

/**
 * The MCP tool channel, as {@link AgentManager} needs it. Narrow by design: the
 * manager mints a credential per launch and hands it back when the agent leaves
 * the fleet, and knows nothing about sockets or the tool surface.
 */
interface McpChannel {
  /** Mint a per-launch credential. `configPath` is null when tools can't be wired. */
  open(): { token: string; configPath: string | null };
  /** Complete the credential's identity once the agent row exists. */
  bind(token: string, agentId: string): void;
  /** Revoke a credential and drop its launch config. */
  release(token: string): void;
}

interface AgentManagerOptions {
  command: string;
  /**
   * Builds the argv for a launch. `sessionId` is the id the agent runs under and
   * `resume` re-attaches to it (`claude --resume`) instead of starting fresh.
   * `mcpConfigPath` wires that launch's tool channel, or is null for none.
   * `model` and `effort` are the task's resolved `--model` / `--effort` values,
   * either null to pass no flag.
   * Runtimes that don't support session ids (mock/stream) ignore the first two.
   */
  buildArgs: (opts: {
    sessionId: string;
    resume: boolean;
    mcpConfigPath: string | null;
    model: string | null;
    effort: string | null;
  }) => string[];
  /**
   * What a goal's work runs on today, for the one decision `recordAssay` has to
   * make about a proposal (issue #342).
   *
   * A function rather than the config, so the manager stays as ignorant of
   * labels, profiles and precedence as it is of rules — it asks one question and
   * gets one name. Unset (every runtime with no `agentModels`, and the tests that
   * do not care) means no proposal is ever stored and no gate can ever hold.
   */
  goalProfile?: {
    /** The profile `issue:<n>`'s work would run on now: its tag, or the configured default. */
    effective: (issueOrigin: string) => string | null;
  };
  whitelistedApprovals: WhitelistRule[];
  /** Builds the underlying runtime (PTY or stream-JSON) for a launch spec. */
  createSession: SessionFactory;
  /**
   * If set, the string it returns is delivered to the session as the first
   * message once the process has had `promptDelayMs` to boot. Used to hand a
   * real `claude` agent its task. Return null to send nothing (e.g. the mock
   * agent, which reads its prompt from the environment).
   */
  initialInput?: (task: Task) => string | null;
  /**
   * Message nudging a *resumed* agent to continue. Delivered only when re-attaching
   * an agent that was mid-work (not parked on a question) — `--resume` re-opens the
   * session idle and awaiting input. Null to send nothing.
   */
  resumeInput?: () => string | null;
  /** Delay before sending the initial input, giving an interactive CLI time to start. */
  promptDelayMs?: number;
  /** Extra literal substrings a PTY session treats as "waiting for input". */
  waitingPatterns?: string[];
  /**
   * Whether this runtime can capture a session id and be resumed after a restart.
   * True only for the interactive PTY `claude`; the mock and stream runtimes leave
   * agents without a session id, so boot reconciliation falls back to interrupting.
   */
  resumable?: boolean;
  /**
   * `agentResumeAttempts` — how many times a live agent whose process dies mid-run
   * is re-attached before it is settled as failed. Unset or 0 means a mid-run death
   * is terminal, which is also what every unresumable runtime gets regardless.
   */
  resumeAttempts?: number;
  /**
   * Per-session path the PTY status-line capture writes its payload to,
   * exported to the spawned process as LUBBDUBB_STATUS_FILE. Only meaningful
   * for runtimes with a session id (PTY); unset for stream/mock.
   */
  statusFile?: (sessionId: string) => string;
  /**
   * Spool for the file-events `PostToolUse` hook. When set, each launch gets a
   * per-agent dir exported as `$LUBBDUBB_EVENTS_DIR`; the hook drops written
   * paths there and {@link AgentManager.drainFileEvents} folds them into the
   * files list / artifact chips. Unset (mock runtime) → no capture.
   */
  fileEvents?: FileEventsSpool;
  /** Folder(s) whose files are promoted to artifacts (any extension); relative or absolute. See {@link classifyArtifact}. */
  docsFolderPrefix?: string | string[];
  /**
   * The typed tool channel (issue #108). When set, each launch gets its own
   * credential and `--mcp-config`; unset leaves agents on the sentinels alone,
   * which is a supported configuration, not a degraded one.
   */
  mcp?: McpChannel;
  /**
   * `planning.requireApproval` — carried only so a `plan.json` a planner writes
   * lands the same way one submitted through `plan_submit` does. It is a policy
   * the *ingestion* needs, not the fleet, and it is here rather than read from a
   * config because this class deliberately takes a store and options and nothing
   * else. Unset = the default (no approval gate).
   */
  requirePlanApproval?: boolean;
  /**
   * The disk half of a blueprint's attachments (issue #249). Present so
   * {@link AgentManager.linkTicket} can move an operator's images off the filing
   * job and onto the ticket that filing created; unset in tests and runtimes that
   * never file, where a re-key has nothing to move.
   */
  attachments?: AttachmentRelocator;
  /** Central error sink: agent failures (spawn errors, crashes + exit codes) are recorded here. */
  errors?: ErrorRecorder;
}

/**
 * What this class needs of {@link ../jobs/attachmentFiles.js AttachmentFiles}:
 * to empty one ref's directory into another's. Narrow for the reason
 * {@link McpChannel} is — the manager moves files it never wrote and never reads.
 */
interface AttachmentRelocator {
  relocate(
    fromRef: string,
    toRef: string,
    files: { id: string; path: string }[],
    nextIndex: number,
  ): { id: string; index: number; path: string }[];
}

interface AgentManagerEvents {
  output: [{ agentId: string; delta: string }];
  /** `ask` is present only when the park came through the `escalate` tool, which can carry structure. */
  waiting: [{ agentId: string; taskId: string; reason: string; ask?: AgentAsk }];
  autoAnswered: [{ agentId: string; taskId: string; reason: string; response: string }];
  /**
   * `by` distinguishes the agent declaring itself finished (a sentinel, a clean
   * exit) from an operator declaring it so through {@link AgentManager.complete}.
   * The record is identical either way — that is the point — but only the second
   * leaves an escalation nobody can answer, so the composition root needs to tell
   * them apart to dismiss it.
   */
  done: [{ agentId: string; taskId: string; status: AgentStatus; by: 'agent' | 'operator' }];
  /**
   * The agent finished (done/failed) *and* its OS process has actually exited —
   * the two arrive in either order (PTY: sentinel first, exit later; stream:
   * exit first). Only now is it safe to touch resources the process pinned,
   * e.g. removing its worktree cwd.
   */
  reaped: [{ agentId: string; taskId: string; status: 'done' | 'failed' }];
  status: [{ agentId: string; taskId: string; status: AgentStatus }];
  usage: [{ agentId: string; taskId: string; usage: AgentUsage }];
  /** The agent surfaced an artifact/link mid-run (already persisted, deduped by ref). */
  flag: [{ agentId: string; taskId: string; flag: AgentFlag }];
  /** The agent filed something outside its own task (already persisted). `created` is false for a verbatim repeat. */
  finding: [{ agentId: string; taskId: string; finding: Finding; created: boolean }];
  /** The agent asked for work only a person can do (already persisted). `created` is false for a repeat. */
  humanTask: [{ agentId: string; taskId: string; humanTask: HumanTask; created: boolean }];
  /** The agent said what it is working on (already persisted onto its row, replacing the previous note). */
  progress: [{ agentId: string; taskId: string; note: string; notedAt: string }];
  /** The agent said whether its issue is finished (already persisted against the issue origin). */
  conclusion: [{ agentId: string; taskId: string; conclusion: IssueConclusion }];
  assessment: [{ agentId: string; taskId: string; issueOrigin: string; verdict: AssessmentVerdict }];
  /** The assayer said whether its issue's goal can be worked from (already persisted against the issue origin). */
  assay: [{ agentId: string; taskId: string; issueOrigin: string; verdict: GoalAssayVerdictName }];
  /** The agent closed its plan part without a pull request (already persisted on the part row). */
  partOutcome: [{ agentId: string; taskId: string; part: PlanPart }];
  /** The agent left a note on its issue's shared pad (already persisted, append-only). */
  scratch: [{ agentId: string; taskId: string; entry: ScratchEntry }];
  /** The retrospective for a delivered goal was written (already persisted against the issue origin). */
  retrospective: [{ agentId: string; taskId: string; issueOrigin: string }];
  /** The file-events hook recorded one or more written files (the "files changed" list grew). */
  files: [{ agentId: string; taskId: string }];
  /**
   * A parked agent was seen making a tool call — i.e. it carried on working rather
   * than waiting, so the open alert against it is probably stale. Already persisted
   * as `Agent.resumedAt`; emitted so the cockpit learns now rather than next poll.
   */
  resumed: [{ agentId: string; taskId: string; resumedAt: string }];
  /**
   * The account's usage limit ran out under this agent, so it is parked rather than
   * failed (issue #318). Already persisted as `waiting` with `reason` on the row;
   * emitted so a listener hears the *cause*, which the row alone only spells out in
   * prose. `resetsAt` is null when `claude` did not say when the window turns over.
   */
  limited: [{ agentId: string; taskId: string; reason: string; resetsAt: string | null }];
}

/**
 * Owns the fleet of live PTY agent sessions: spawn, stream, detect
 * waiting/done, feed input, kill. It maps {@link PtySession} events onto store
 * updates and re-emits them for the server to broadcast. Whitelisted waiting
 * prompts are auto-answered here; everything else surfaces as a `waiting` event
 * for the harness to escalate.
 *
 * The `implements AgentToolTarget` is load-bearing: it is what makes the eleven
 * tool-facing methods below a *checked* contract rather than eleven coincidences.
 * Satisfying it structurally meant a method could be renamed, or the interface
 * grown, with nothing failing — `withCaller`'s own argument, one level up. The
 * clause costs a `import type` and nothing else: it is erased at compile time, and
 * the runtime edge it would notionally create already runs this way round (this
 * file value-imports `assessmentOrigin`, `assayerOrigin` and `partConclusionOrigin`
 * from `src/mcp/`, while `src/mcp/` reaches back only for types).
 */
export class AgentManager extends EventEmitter implements AgentToolTarget {
  private readonly sessions = new Map<string, AgentSession>();
  // Exit code per agent, captured from the session's `exit` event so a `failed`
  // terminal can be recorded with its cause (the code arrives before `failed`).
  private readonly exitCodes = new Map<string, number>();
  // The two halves of a 'reaped' emission: terminal status recorded vs process
  // exit observed. Their order differs per runtime, so track both.
  private readonly terminals = new Map<string, 'done' | 'failed'>();
  private readonly exited = new Set<string>();
  // agentId → its file-events spool key, so we can drain (and later dispose) the
  // dir the hook writes to. Present only when a spool is wired and the launch got one.
  private readonly eventsKeys = new Map<string, string>();
  // agentId → its MCP credential, revoked when the agent leaves the fleet.
  private readonly mcpTokens = new Map<string, string>();
  // Agents currently parked on a human. The convergence latch for the two ways an
  // agent can ask: the `escalate` tool and the WAITING sentinel are two detectors
  // of one transition, so whichever arrives first owns it and the second is a
  // no-op until the park is released. Same discipline as `noteSentinel`'s two PTY
  // detectors, and for the same reason — two detectors that quietly disagree is a
  // bug this codebase has already paid for once.
  private readonly parked = new Set<string>();
  // agentId → the reason it is parked on a *spent account limit* rather than on a
  // question (issue #318). A subset of `parked` with a different ending: nobody can
  // answer it, so the way out is {@link resumeParked}, not a reply. In memory
  // because it describes a park this process is holding — a restart hands the same
  // rows to the recovery desk, which asks the operator the wider question.
  private readonly limited = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
  ) {
    super();
  }

  /**
   * Spawn an agent for a task in the given working directory.
   *
   * `resumeSessionId` re-dispatches an origin **into the conversation its last
   * agent had** instead of a cold one (issue #333), so attempt two does not re-read
   * the repository and `CLAUDE.md` to re-derive what attempt one already worked
   * out. Ignored by a runtime that cannot resume, which is what makes it safe to
   * pass unconditionally: the caller reads the returned row's `sessionId` to learn
   * whether the re-attach actually happened.
   *
   * **This is a spawn, not {@link AgentManager.resume}, and the difference is the
   * whole reason it is here.** `resume` reuses the agent row, so its in-memory maps
   * are already occupied and a caller must tear the dead launch down first or leak
   * a spool dir and leave an MCP bearer token bound with nothing to revoke it. A
   * retry gets a *new* agent row — `sessions`, `eventsKeys` and `mcpTokens` are all
   * keyed by agent id, so there is nothing to write over and nothing to tear down.
   * The previous agent's teardown already ran when it was reaped.
   *
   * Two rows then share one `sessionId`, which is correct: `--resume` appends to
   * that transcript rather than forking a new id (see `buildClaudeStreamArgs`), so
   * the id names the conversation and the rows name the attempts that spoke into
   * it. Nothing keys on the id being unique per agent — `isRecoveryCandidate` gates
   * on the *task* being outstanding, and attempt one's is settled by the time this
   * runs.
   */
  spawn(task: Task, cwd: string, resumeSessionId?: string | null): Agent {
    // A runtime that cannot resume has no conversation to inherit, so it falls back
    // to a cold launch rather than refusing the dispatch.
    const inherited = this.opts.resumable ? (resumeSessionId ?? null) : null;
    // Choose the session id up front so we own it and can `--resume` this exact
    // conversation after a restart. Only resumable runtimes get one. A retry takes
    // the previous agent's id instead of minting one — the one path where this is
    // not a fresh conversation.
    const sessionId = inherited ?? (this.opts.resumable ? randomUUID() : null);
    // The file-events spool key is independent of the resume session id, so stream
    // agents (no session id) still get one. Minted before the session so the env
    // carries it; mapped to the agent id below for draining.
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    // Minted before the session so the launch config exists to point `--mcp-config`
    // at, and bound to the agent row the moment it exists. Nothing can call a tool
    // in between: `createSession` only builds the session, `start()` is below.
    const mcp = this.opts.mcp?.open() ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: sessionId ?? '',
        // `--resume` on an inherited id, `--session-id` on a minted one, and never
        // both — `appendSessionFlags` owns that choice, and `claude` exits 1 with no
        // stream event at all if a pinned id already has a transcript.
        resume: inherited !== null,
        mcpConfigPath: mcp?.configPath ?? null,
        // Decided at dispatch and stored on the row, so this forwards two strings
        // and never re-derives either from config.
        model: task.model ?? null,
        effort: task.effort ?? null,
      }),
      cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.statusFileEnv(sessionId),
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
      // A synchronous spawn failure (e.g. the claude command can't be resolved)
      // must not leave a half-created agent stuck in `starting`. Tear it down and
      // record the reason on the transcript, then rethrow so the executor surfaces
      // it as a rejected dispatch instead of a mystery `failed` agent.
      this.failSpawn(agent.id, task.id, err as Error);
      throw err;
    }

    // Hand the agent its task. For a real `claude` REPL this is typed in after a
    // short boot delay; the mock agent takes its prompt from the environment and
    // opts out by returning null.
    this.deliverAfterBoot(agent.id, session, this.opts.initialInput?.(task) ?? null);

    return agent;
  }

  /**
   * Re-attach to an agent orphaned by a server restart, continuing its Claude
   * session in the same worktree rather than starting over. Reuses the existing
   * agent row, session id and cwd — no new agent is created. Best-effort: returns
   * false (caller falls back to interrupting) if the runtime can't resume or the
   * agent has no session id. Idempotent: a no-op if the agent is already live.
   *
   * `nudge` overrides the message a mid-work agent is restarted with. Boot passes
   * nothing and gets `resumeInput`'s "you were resumed after a server restart",
   * which is the truth there and a lie to an agent resumed off a usage-limit park
   * — see {@link resumeParked}.
   */
  resume(agent: Agent, task: Task, nudge?: string): boolean {
    if (!this.opts.resumable || !agent.sessionId) return false;
    if (this.sessions.has(agent.id)) return true;

    // `waitingReason` survives the restart and tells us whether the agent was
    // parked on a human question (keep it waiting) or mid-work (nudge it on).
    const wasWaiting = agent.status === 'waiting' || agent.waitingReason != null;
    // A restart wiped the old spool, so mint a fresh key for the resumed session.
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    // A restart revoked the old credential with the process that held it, so a
    // resume mints a fresh one — same agent row, same identity, new bearer token.
    const mcp = this.opts.mcp?.open() ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: agent.sessionId,
        resume: true,
        mcpConfigPath: mcp?.configPath ?? null,
        // The stored values, which is why a restart cannot move a half-finished
        // conversation onto a different model or a different depth.
        model: task.model ?? null,
        effort: task.effort ?? null,
      }),
      cwd: agent.cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.statusFileEnv(agent.sessionId),
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
    // The row goes live again, shedding the death markers from the last run.
    this.store.updateAgent(agent.id, { status: 'running', pid: null, endedAt: null, waitingReason: null });
    this.store.updateTask(task.id, { status: 'running' });
    this.wireSession(session, agent.id, task);
    try {
      session.start();
    } catch (err) {
      // Resume is best-effort; a spawn failure here just drops the session so the
      // boot reconciler falls back to marking the agent interrupted.
      this.sessions.delete(agent.id);
      throw new Error(`resume spawn failed for agent ${agent.id}: ${(err as Error).message}`);
    }

    if (wasWaiting) this.restoreWaiting(agent, task);
    else this.deliverAfterBoot(agent.id, session, nudge ?? this.opts.resumeInput?.() ?? null);

    return true;
  }

  /**
   * End a usage-limit park: the operator saying the account can work again
   * (issue #318).
   *
   * Two shapes of the same park, because exhaustion does not always kill the
   * process. If the session is still up, this is one message down the stdin that
   * is already open. If `claude` exited with the limit — the common case — the
   * conversation is re-opened through {@link resume}, which is why the park keeps
   * the row's `session_id` and its worktree rather than settling anything.
   *
   * Only an agent *this process* parked on a limit is a candidate. A park held
   * across a restart is the recovery desk's question, not this one: the desk
   * offers restore/requeue/remove over a wider choice than "carry on", and two
   * surfaces resuming one row would race for its session id.
   *
   * The park is put back on any failure, so a refused resume leaves the operator
   * where they were rather than with an agent that is neither parked nor running.
   */
  resumeParked(agentId: string): { ok: true } | { ok: false; error: string } {
    const reason = this.limited.get(agentId);
    if (reason === undefined) return { ok: false, error: 'this agent is not parked on a usage limit' };
    return this.withCaller(agentId, ({ agent, task }) => {
      const session = this.sessions.get(agentId);
      if (!session && (!this.opts.resumable || !agent.sessionId)) {
        return { ok: false, error: 'this agent runtime cannot re-open its session, so the park cannot be ended' };
      }
      this.limited.delete(agentId);
      this.parked.delete(agentId);
      this.store.setAgentResumed(agentId, null);
      // Cleared before either arm: `resume` reads the row to decide whether the agent
      // was parked on a *question* (which it re-establishes), and this park is
      // precisely the one it must not put back.
      this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
      this.store.updateTask(task.id, { status: 'running' });

      if (session) {
        session.send(LIMIT_RESUME_MESSAGE);
        this.reflectStatus(agentId, task.id, 'running');
        return { ok: true };
      }

      const row = this.store.getAgent(agentId);
      try {
        if (!row || !this.resume(row, task, LIMIT_RESUME_MESSAGE)) throw new Error('the runtime declined the resume');
      } catch (err) {
        this.reinstateLimitPark(agentId, task, reason);
        return { ok: false, error: `could not re-open the session: ${(err as Error).message}` };
      }
      return { ok: true };
    });
  }

  /** Every agent this process is holding parked on a spent account limit. */
  limitedAgentIds(): string[] {
    return [...this.limited.keys()];
  }

  /** Type text into a live agent (a human response or a follow-up prompt). */
  respond(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    session.send(text);
    this.parked.delete(agentId); // the park is over; the next ask is a new one
    this.limited.delete(agentId); // ...including a limit park an operator typed straight past
    this.store.setAgentResumed(agentId, null); // answered, so "it carried on anyway" is spent
    this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
    return true;
  }

  /**
   * Resolve the caller a tool call arrived as, and run the call against it.
   *
   * **This is `token -> agent -> task -> origin`, and it is the step the whole
   * tool channel rests on.** No write tool takes an agent, task or issue
   * argument: the credential minted at spawn is what says who is calling, so an
   * agent cannot name itself and therefore cannot address another's work. That
   * guarantee is only as good as the resolution, and the resolution used to be
   * copied into all eleven tool-facing methods below — so it held eleven times by
   * inspection rather than once by construction. A twelfth method written from
   * scratch, or one that dropped the `!task` half because its store call happens
   * to take only an `agentId` (as {@link recordProgress}'s genuinely does), would
   * have inherited nothing and failed nothing.
   *
   * A wrapper rather than a `resolveCaller()` a caller may forget to check: the
   * body **cannot run** without a resolved `{agent, task}` in hand, and the
   * refusal it returns is the same sentence for every tool.
   *
   * It deliberately does **not** check liveness — a finding, a note or a verdict
   * cast on an agent's last breath is still true, and {@link ask} is the one
   * caller that needs a live session, which it tests for itself before asking.
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
   * Park an agent on a human question raised through the `escalate` MCP tool.
   *
   * This is the *same* transition the WAITING sentinel drives — deliberately, and
   * routed through the same {@link handleWaiting} so the whitelist, the drain and
   * the store writes can't diverge between the two. The tool is the richer signal
   * (it carries a kind and options); the sentinel is the one that always works.
   * Whichever fires first parks the agent, and the latch makes the second a no-op,
   * so an agent that calls `escalate` *and* prints the sentinel raises one
   * escalation, not two.
   *
   * Returns the escalation the park produced, or `null` for `escalationId` when an
   * operator whitelist rule auto-answered it and the agent was never parked at all.
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

  /**
   * File something an agent noticed outside its own task (the `report_finding`
   * tool). It goes through the manager rather than straight to the store for the
   * same reason a flag does: the cockpit should hear about it the moment it is
   * filed, not on the next pulse, and the `finding` event is what carries it.
   *
   * The agent id comes from the caller's credential, so `agentId -> task ->
   * origin` is the whole attribution and there is nothing an argument could
   * forge. Unlike {@link ask} this does not require a *live* session — a finding
   * is a durable note, and one filed on an agent's last breath is still true.
   */
  recordFinding(agentId: string, input: FindingInput): { ok: true; finding: Finding } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const { finding, created } = this.store.recordFinding(agentId, task.id, task.originRef, input);
      this.emit('finding', { agentId, taskId: task.id, finding, created });
      return { ok: true, finding };
    });
  }

  /**
   * Ask for work only a person can do (the `request_human_task` tool). Routed
   * through the manager for {@link recordFinding}'s reason: the cockpit should
   * hear about it the moment it is filed, and the `humanTask` event is what
   * carries it.
   *
   * Not requiring a live session is deliberate here too, and for a sharper reason
   * than a finding's: the commonest moment to realise a person is needed is the
   * moment an agent is giving up on doing something itself.
   */
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
   * Record the ticket a filing agent created (the `link_ticket` tool): the
   * finding it was dispatched for moves `filing -> filed`.
   *
   * The finding is reached from the credential — agent → task → the `job:<id>`
   * origin it was dispatched on → the finding that job was created for — so the
   * tool takes only a ref. An agent on any other task resolves to no finding and
   * is told so, which is the whole access check: there is no id to point at
   * someone else's.
   *
   * Routed through the manager for the same reason as {@link recordFinding}: the
   * `finding` event is what repaints the cockpit now rather than next pulse.

   */
  linkTicket(agentId: string, ticketRef: string): LinkTicketResult {
    return this.withCaller(agentId, ({ task }): LinkTicketResult => {
      const jobId = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
      const finding = jobId ? this.store.findFindingByJobId(jobId) : null;
      // A job is created for at most one of the two, so there is nothing to
      // disambiguate — the credential resolves to a finding, a work-item filing, or
      // neither, and neither is the whole access check.
      const filing = jobId && !finding ? this.store.findWorkItemFilingByJobId(jobId) : null;
      const bug = jobId && !finding && !filing ? this.store.findBugFilingByJobId(jobId) : null;
      if (!finding && !filing && !bug) {
        return {
          ok: false,
          error:
            `link_ticket is only for a job dispatched to file a finding as a ticket, to file a work ` +
            `item for unrecorded work, or to raise a bug an operator reported. This task's origin is ` +
            `${task.originRef ?? '(none)'}, which was created from none of them.`,
        };
      }

      if (bug) {
        // The same check the work-item arm makes, for its reason: a bug is an issue
        // in both trackers the harness reads, and a `pr:` ref here would be a link
        // the cockpit draws as a work item and the tracker knows as something else.
        if (!ticketRef.startsWith('issue:')) {
          return {
            ok: false,
            error: `A bug must be an issue ref like "issue:314"; got "${ticketRef}".`,
          };
        }
        // Idempotence in the write, as in both arms below.
        const linked = this.store.linkBugFiling(bug.jobId, ticketRef);
        if (!linked) {
          return {
            ok: false,
            error: `the bug raised on ${bug.originRef} is ${bug.status}, not awaiting a ticket — nothing to link.`,
          };
        }
        return { ok: true, bug: linked };
      }

      if (filing) {
        // A work item is an issue in both trackers the harness reads (a GitHub issue,
        // an Azure work item), and the graph stands a placeholder node up under that
        // ref when the world never lists it — so guessing a node kind off a `pr:`
        // ref is a case worth removing rather than answering.
        if (!ticketRef.startsWith('issue:')) {
          return {
            ok: false,
            error:
              `A work item must be an issue ref like "issue:314"; got "${ticketRef}". If you filed ` +
              'something else, file the work item too and link that.',
          };
        }
        // Idempotence in the write, as below.
        const linked = this.store.linkWorkItemFiling(filing.jobId, ticketRef);
        if (!linked) {
          return {
            ok: false,
            error: `the work item for ${filing.targetRef} is ${filing.status}, not awaiting a ticket — nothing to link.`,
          };
        }
        // The images the operator attached to the blueprint this filing came from
        // now belong to the ticket (issue #249). Done here rather than in the tool,
        // because the filing — and so the `job:<id>` the images are keyed under —
        // is resolved from the credential, and this is the one moment the harness
        // learns which issue that blueprint became.
        const moved = this.rekeyAttachments(filing.targetRef, ticketRef);
        // No bespoke event: the Work panel is fetch-on-open, and the parent edge it
        // draws is written by the next pulse's fold, not from here.
        return { ok: true, filing: linked, attachments: moved };
      }

      // Idempotence lives in the write, not in a read-then-check here.
      const linked = this.store.linkFindingTicket(finding!.id, ticketRef);
      if (!linked) {
        return {
          ok: false,
          error: `finding ${finding!.id} is ${finding!.status}, not awaiting a ticket — nothing to link.`,
        };
      }
      this.emit('finding', { agentId, taskId: task.id, finding: linked, created: false });
      return { ok: true, finding: linked };
    });
  }

  /**
   * Move an operator's attachments from the ref they arrived on to the one the
   * work now lives under, returning how many moved (issue #249).
   *
   * **Why the attachments move at all.** A code blueprint carrying a screenshot is
   * not dispatched onto a branch when a tracker is configured: it is filed as a
   * ticket, and the planning funnel — assay, planner, each part agent, the retro —
   * takes over under `issue:<n>`. Left keyed on `job:<id>`, the image would be
   * visible to exactly one agent, the one that filed the ticket and wrote no code.
   * Re-keying is what makes it the *goal's* image rather than the job's.
   *
   * **Failure is recorded, not raised.** The link is the act the agent was
   * dispatched to perform and it has already succeeded in the store; refusing it
   * because a rename failed would leave a filing the operator sees as incomplete
   * over a screenshot. What is lost instead is the image's onward visibility, and
   * that is a recorded error rather than a silent one.
   */
  private rekeyAttachments(fromRef: string, toRef: string): number {
    const rows = this.store.listAttachments(fromRef);
    if (rows.length === 0 || !this.opts.attachments) return 0;
    try {
      const moved = this.opts.attachments.relocate(fromRef, toRef, rows, this.store.nextAttachmentIndex(toRef));
      this.store.rekeyAttachments(toRef, moved);
      return moved.length;
    } catch (err) {
      this.opts.errors?.record({
        source: 'agent',
        message:
          `Could not move ${rows.length} attachment(s) from ${fromRef} to ${toRef}: ${(err as Error).message}. ` +
          `The files are still keyed to the filing job, so the agents working the ticket will not see them.`,
      });
      return 0;
    }
  }

  /**
   * Record what an agent says it is working on (the `note_progress` tool). Like
   * {@link recordFinding} it goes through the manager rather than straight to the
   * store, so the cockpit repaints on the note rather than on the next pulse —
   * a note that lands twenty minutes late has already failed at its one job.
   *
   * Also like a finding, this does not require a *live* session: the note is a
   * durable line on the agent's row, and one written on an agent's last breath is
   * the summary of the run.

   */
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const notedAt = this.store.recordAgentNote(agentId, note);
      this.emit('progress', { agentId, taskId: task.id, note, notedAt });
      return { ok: true, notedAt };
    });
  }

  /**
   * Append to the shared pad for the issue this agent is working (the
   * `scratch_append` tool).
   *
   * The pad is resolved from the credential by {@link padWriteTarget} — an agent
   * cannot name it, so it cannot reach another goal's record — and it is refused
   * outright outside an issue subtree rather than scoped down, because an agent
   * handed a silent success believes its note was recorded.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordProgress}'s reason: the event is what lets a reader hear about
   * this now rather than on the next pulse.

   */
  appendScratch(
    agentId: string,
    note: string,
    topic: string | null,
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
      });
      this.emit('scratch', { agentId, taskId: task.id, entry });
      return { ok: true, entry };
    });
  }

  /**
   * Read the whole pad for this agent's issue — every agent on the goal, in the
   * order they wrote (the `scratch_read` tool).
   *
   * Same access rule as the write, and a caller outside an issue subtree is
   * **refused** rather than handed an empty pad: an empty pad reads as "nobody has
   * written anything", which is a different and untrue answer.

   */
  readScratch(agentId: string): { ok: true; padRef: string; entries: ScratchEntry[] } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const target = padWriteTarget(task.originRef);
      if (!target.ok) return { ok: false, error: target.error };
      return { ok: true, padRef: target.padRef, entries: this.store.listScratchEntries(target.padRef) };
    });
  }

  /**
   * Record the retrospective this agent was dispatched to write (the `retro_submit`
   * tool).
   *
   * {@link retroSubmitOrigin} resolves the issue from the credential and refuses
   * every other caller by name, so the agent that *did* the work cannot write the
   * account of it. Idempotence is in the store's upsert: a second submission
   * revises one row.

   */
  recordRetrospective(
    agentId: string,
    summary: string,
    document: string,
  ): { ok: true; issueOrigin: string } | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
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
   * Record whether the issue an agent was dispatched for is finished (the
   * `conclude_work` tool).
   *
   * The issue is reached from the credential — agent → task → its `issue:<n>`
   * origin — so the tool takes no issue argument and an agent working anything
   * else resolves to nothing it may conclude. That check is
   * {@link conclusionOrigin}'s, and it is the structural half of "done means the
   * issue is finished, not my bit of it": a part agent is *refused* rather than
   * having its verdict quietly scoped to its part.
   *
   * Routed through the manager rather than straight to the store for the same
   * reason as {@link recordFinding}: the `conclusion` event repaints the cockpit
   * now rather than on the next pulse. Like a finding it needs no *live* session
   * — a verdict cast on an agent's last breath is the one that matters most.

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
      this.emit('conclusion', { agentId, taskId: task.id, conclusion });
      return { ok: true, conclusion };
    });
  }

  /**
   * Record an assessor's verdict on the issue it was dispatched to judge.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse.
   *
   * The two verdicts land in two different rows, because they are two verdicts
   * with opposite polarity. `delivered` is the harness's park and **gates pickup**;
   * a shortfall gates nothing and exists to *release* work, which is why it is a
   * table of its own rather than a column on the delivery (see
   * {@link IssueShortfall}). Their mutual exclusion is enforced in the store, so it
   * is not re-implemented here.
   *
   * It deliberately no longer writes `issue_conclusions`. That row is the working
   * agent's own declaration about its own run, keyed on the issue — so an assessor
   * writing into it overwrote the agent's note, author and timestamp, with no
   * precedence between the two parties for the resolver to read. That was a bug
   * independent of this feature (issue #159), and `resolveIssueConclusion` now
   * ranks the two records instead.
   *
   * **The plan-aware refusals are here rather than in `validateAssessment`**
   * because they are store questions, and they are the tool channel's whole point:
   * a structured payload whose rejection the agent never hears costs a whole agent
   * to discover, which is the `plan.json` lesson. Each names the alternative, the
   * way `conclusionOrigin` and `partConclusionOrigin` do.

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

      // The discriminator is the plan *row*, not its parts: a `single` verdict is a
      // plan, and replanning one is the honest response to "one pull request was not
      // enough" — it re-runs the planner, which may now decompose it.
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
   * Record an assayer's verdict on the goal it was dispatched to judge.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse.
   *
   * **The fingerprint is taken from the task, not from the world**, and that is
   * the load-bearing line. `originTitle`/`originSummary` are the issue's title and
   * body captured at dispatch — the exact text this agent was handed and therefore
   * the exact text it judged. Re-reading the issue here would stamp the verdict
   * with whatever the ticket says *now*, so an edit made while the assayer was
   * running would be silently swallowed: the verdict would claim to be about text
   * nobody assayed, and `assayHold`'s first arm — the one that re-opens the
   * question when the ticket changes — could never fire for it.

   */
  recordAssay(
    agentId: string,
    verdict: GoalAssayVerdictName,
    summary: string,
    profile: string | null,
  ):
    | { ok: true; issueOrigin: string; verdict: GoalAssayVerdictName; profileHeld: boolean }
    | { ok: false; error: string } {
    return this.withCaller(agentId, ({ task }) => {
      const origin = assayerOrigin(task.originRef);
      if (!origin.ok) return { ok: false, error: origin.error };

      // Whether the proposal needs a human is decided **here**, once, because this
      // is where the ticket's own tag and the operator's config are both in hand.
      // Deciding it at read time instead would put a config lookup inside
      // `assayHold`, and a caller that forgot to wire it would gate the whole
      // fleet rather than none of it.
      const proposedProfile = this.opts.goalProfile && profile ? profile : null;
      const profileHeld =
        proposedProfile !== null && proposedProfile !== this.opts.goalProfile?.effective(origin.issueOrigin);
      this.store.recordAssay({
        originRef: origin.issueOrigin,
        verdict,
        summary,
        goalRef: goalFingerprint(task.originTitle, task.originSummary),
        by: 'assayer',
        proposedProfile,
        profileDiverges: profileHeld,
        agentId,
        taskId: task.id,
      });
      this.emit('assay', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
      return { ok: true, issueOrigin: origin.issueOrigin, verdict, profileHeld };
    });
  }

  /**
   * Record what a plan part produced, for a part that finished without a pull
   * request — a write-up, or the determination that nothing needed building.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse. Identity is structural — the part is resolved from the
   * credential's task origin, so an agent cannot conclude a sibling's work, and
   * {@link partConclusionOrigin} refuses every other kind of caller by name.

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
      // The store's guard does the work: only a part still being worked moves, so a
      // second call merges nothing and a merged or retired part cannot be re-labelled.
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

  /**
   * Send Ctrl-C (raw ETX) to a live agent to interrupt its current work. Status
   * is not mutated here — the agent's own output/exit drives what happens next.
   */
  interrupt(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    session.sendRaw('\x03');
    return true;
  }

  kill(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    // A usage-limit park is the one state with no live session and no ending: the
    // process went with the limit and the row is deliberately still unsettled. The
    // operator must be able to abandon one — "resume" cannot be the only verdict on
    // a park that could otherwise sit there until the next restart offers recovery.
    if (!session && !this.limited.has(agentId)) return false;
    session?.kill();
    this.disposeFileEvents(agentId); // fold any last writes in, then drop the spool
    this.releaseMcp(agentId); // the credential dies with the agent, not with the process
    this.parked.delete(agentId);
    this.limited.delete(agentId); // a killed agent's park is over, and nothing may resume it
    this.store.flushTranscript(agentId); // make the killed agent's transcript durable
    const agent = this.store.getAgent(agentId);
    this.store.updateAgent(agentId, { status: 'killed', endedAt: new Date().toISOString(), pid: null });
    if (agent) this.store.updateTask(agent.taskId, { status: 'interrupted' });
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId); // a deliberate kill's exit code is not a failure cause
    this.exited.delete(agentId); // and a killed agent is never 'reaped' — its worktree stays
    if (agent) this.reflectStatus(agentId, agent.taskId, 'killed');
    return true;
  }

  /**
   * The operator declaring an agent finished — the sibling of {@link kill}, and
   * its inverse in exactly one respect.
   *
   * The clean `done` terminal was reachable only by the *agent*, via the sentinel.
   * An agent that does the work and never prints one (in stream mode a turn ending
   * without it doesn't fail — it parks `waiting` awaiting direction) could then be
   * ended only by `kill`, which records the opposite: task `interrupted`, worktree
   * kept, and an abandonment in the log. This is the missing verdict.
   *
   * It stops the process and then routes through the *same* {@link handleTerminal}
   * the sentinel drives, so nothing about a completed agent differs from a finished
   * one. `session.kill()` marking the session `killed` internally is fine and
   * load-bearing: that flag only stops the *session* reclassifying its own exit —
   * here the manager decides the record, and it decides `done`.
   *
   * The one line that is the inverse of `kill`: `exited` is left alone rather than
   * deleted. Both runtimes emit `exit` before their killed early-return, so the exit
   * still lands, {@link maybeReap} finds a `done` terminal, and the reap removes the
   * worktree — the clean finish, which is the whole point of saying done instead of
   * killing. Credential revocation and spool disposal ride along there as usual.
   *
   * Liveness is the whole guard: an agent that has already ended is not a candidate,
   * since re-labelling a settled record is a different question with a different
   * answer. Returns false in that case, which the route turns into a 409.
   */
  complete(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    const agent = this.store.getAgent(agentId);
    if (!agent) return false;
    // Everything below names the agent by the id on the row we just loaded, never
    // by the argument. They are equal by construction — the two lookups above both
    // hit, and the session map is keyed on ids this class minted — so this is about
    // provenance: `complete` is the one path here reached straight from a request
    // parameter (`POST /api/agents/:id/complete`), and these ids go on to be written
    // into an audit row and, on the failure arm downstream, a log line. Reading the
    // canonical value back off the record keeps a caller's string out of both.
    const id = agent.id;
    session.kill();
    this.handleTerminal(id, agent.taskId, 'done', 'operator');
    // Audited under the cycle id the cockpit reads as yours, the way an act decided
    // outside a pulse already is. No proposal: there is nothing to authorize — the
    // act is the operator's own and already taken, where a proposal is a standing
    // verdict a rule re-reads every pulse.
    const task = this.store.getTask(agent.taskId);
    this.store.recordDecision({
      cycleId: `human:${id}`,
      action: { type: 'no_op', reason: 'operator marked the work complete' },
      outcome: 'executed',
      detail: `Marked agent ${id} done (task ${agent.taskId}${task?.originRef ? `, ${task.originRef}` : ''})`,
    });
    return true;
  }

  isLive(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  /**
   * Stop every live agent because the *server* is going down — distinct from
   * {@link kill}, which is a deliberate per-agent stop. Agents are left in the
   * resumable `interrupted` state (not `killed`) so the next boot re-attaches
   * them; `waitingReason` and the task status are preserved as the signal for
   * how to resume. A cockpit kill stays dead because it alone marks `killed`.
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
      this.disposeFileEvents(id); // fold any pending writes in; a resume mints a fresh spool
      this.releaseMcp(id); // a resume mints a fresh credential, same as the spool
      this.store.flushTranscript(id); // make the transcript durable before we exit
      this.store.updateAgent(id, { status: 'interrupted', endedAt: at, pid: null });
      this.sessions.delete(id);
      this.exitCodes.delete(id);
      this.exited.delete(id);
      // Not `parked`: `waitingReason` is preserved as the resume signal, and
      // `restoreWaiting` re-establishes the latch when the agent comes back.
      this.parked.delete(id);
      // The row keeps its reason, so the desk still says why it was parked; what
      // does not survive is this process's offer to resume it.
      this.limited.delete(id);
    }
  }

  // -- internals -----------------------------------------------------------

  /** The LUBBDUBB_STATUS_FILE env entry for a launch, when status capture is wired. */
  private statusFileEnv(sessionId: string | null): Record<string, string> {
    if (!sessionId || !this.opts.statusFile) return {};
    return { LUBBDUBB_STATUS_FILE: this.opts.statusFile(sessionId) };
  }

  /** The LUBBDUBB_EVENTS_DIR env entry for a launch, when the file-events hook is wired. */
  private eventsDirEnv(key: string | null): Record<string, string> {
    if (!key || !this.opts.fileEvents) return {};
    const env: Record<string, string> = { LUBBDUBB_EVENTS_DIR: this.opts.fileEvents.dirFor(key) };
    // Turn the hook's own breadcrumb logging on so a "did it even fire?" answer
    // survives on the agent's side too, not just ours.
    if (debugEnabled()) env.LUBBDUBB_EVENTS_DEBUG = '1';
    return env;
  }

  /** The spool dir an agent's writes land in (where LUBBDUBB_EVENTS_DIR points), or null. */
  fileEventsDir(agentId: string): string | null {
    const key = this.eventsKeys.get(agentId);
    return key && this.opts.fileEvents ? this.opts.fileEvents.dirFor(key) : null;
  }

  /**
   * Drain the file-events spool for an agent, folding each captured write into
   * the files list (and, for report-like paths, an artifact chip). Public so the
   * composition root / tests can force a drain; also called opportunistically as
   * output flows and once more when the agent finishes. Idempotent — the spool
   * hands each record out exactly once.
   */
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
    // The planner's side channel rides the same hook. It has to be read *here*,
    // inside the drain, while `agent.cwd` still exists: the composition root
    // removes a done agent's worktree on the reap, so any later read finds nothing.
    if (isPlanFile(path)) this.ingestPlan(agent, path);
    if (promoted) {
      // Reuse the flag path so a report becomes a chip through the exact same
      // dedup / artifact-serving machinery as an explicitly-flagged one.
      const flag = this.store.recordFlag(agent.id, { kind, label: basename(path), ref: path });
      this.emit('flag', { agentId: agent.id, taskId: agent.taskId, flag });
    }
  }

  /**
   * Persist a planning agent's plan from the `plan.json` it just wrote.
   *
   * The plan is stored whatever its size — a one-part plan is a first-class
   * row — because without one the planner re-runs on the same issue every cycle.
   * This is also where a **replan** lands: same file, same hook, and the merge on
   * slug is what lets an in-flight part keep its branch and PR across an amendment.
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
      // No plan row is written, so the issue stays in the funnel: the planner is
      // retried, and the attempt cap eventually fails it open to `single`.
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id} wrote an invalid ${PLAN_FILE} for issue #${number}: ${parsed.error}`,
      });
      return;
    }
    const doc = parsed.document;
    const origin = issueOrigin(number);
    // The write itself is shared with the `plan_submit` tool, so the file path and
    // the tool path cannot drift into two different notions of what a plan means.
    const result = ingestPlanDocument(this.store, {
      doc,
      originRef: origin,
      title: task.originTitle ?? task.title,
      requireApproval: this.opts.requirePlanApproval,
    });
    debugLog(
      'fileEvents',
      `agent=${agent.id} plan ingested issue=#${number} parts=${doc.parts.length} status=${result.status} ` +
        `retired=${result.retired.length}`,
    );
  }

  /** Final drain + spool teardown for an agent that's leaving the fleet. */
  private disposeFileEvents(agentId: string): void {
    const key = this.eventsKeys.get(agentId);
    if (!key || !this.opts.fileEvents) return;
    this.drainFileEvents(agentId); // catch writes from the last turn before dropping the dir
    // One-shot dump of the hook's own breadcrumbs before the dir goes away. Empty
    // lines here (with debug on) mean the hook never ran — the fault is upstream of
    // the spool (`--settings`/matcher/PATH), not in draining or classification.
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
      // Piggyback the spool drain on the output stream: an agent that writes a
      // file also produces output around it, so captured writes surface promptly
      // without a polling timer. A no-op when no spool is wired / nothing pending.
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

    // An artifact/link the agent surfaced: persist (deduped by ref) and re-emit
    // the stored flag so the server can stream it to the cockpit.
    session.on('flag', (flag: ParsedFlag) => {
      const saved = this.store.recordFlag(agentId, flag);
      this.emit('flag', { agentId, taskId: task.id, flag: saved });
    });

    session.on('activity', () => this.noteResumed(agentId, task.id));

    session.on('waiting', (reason: string) => this.handleWaiting(agentId, task, reason));
    session.on('limited', (park: RateLimitPark) => this.handleLimited(agentId, task, park));
    // Both runtimes emit `exit` (with the process exit code) before `failed`, so
    // the code is in hand by the time the terminal transition is recorded.
    session.on('exit', (code: number) => {
      this.exitCodes.set(agentId, code);
      this.exited.add(agentId);
      // A limit park usually outlives its process: `claude` exits with the exhausted
      // account and no terminal transition follows, so the resources the launch held
      // have to be given back here or they are held for as long as the park is.
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
   * settling the task (issue #318).
   *
   * The death of the process is not the death of the session. On a resumable
   * runtime the transcript is on disk and `--resume` picks it up in the same
   * worktree with everything the agent had learned — so failing the task throws
   * away a run that is recoverable, and `requeue` (which exists, and starts over)
   * is not the same thing. What makes that safe rather than a crash loop is the
   * budget: {@link AgentManagerOptions.resumeAttempts}, counted on the agent row so
   * it spans restarts, with the `N+1`th death settling as `failed` naming the count.
   *
   * Returns null when it re-attached, else how many resumes had been spent — which
   * the caller puts in the error, so a loop reads as a loop instead of as a crash.
   *
   * **The teardown is the load-bearing part.** {@link resume} was written for boot,
   * where the in-memory maps are empty; here they are not, and it neither drops the
   * dead session (so its own `sessions.has` guard would return a silent no-op
   * success) nor disposes what the dead process held — it would `set` straight over
   * the spool key and the MCP token, leaking a spool directory and, worse, leaving a
   * bearer credential bound and live with nothing left to revoke it.
   */
  private autoResume(session: AgentSession, agentId: string, task: Task): number | null {
    const limit = this.opts.resumeAttempts ?? 0;
    // A session that is no longer the agent's is one the harness already ended —
    // a cockpit `kill` or an operator `complete`. Those are decided endings, and
    // resurrecting one is precisely what the recovery path must not do.
    if (limit <= 0 || !this.opts.resumable || this.sessions.get(agentId) !== session) return 0;
    const agent = this.store.getAgent(agentId);
    if (!agent?.sessionId) return agent?.resumeAttempts ?? 0;
    // Nothing to resume *into*: the worktree is the session's cwd, and `claude`
    // finds no transcript for the id once it is gone.
    if (!existsSync(agent.cwd)) return agent.resumeAttempts;
    if (agent.resumeAttempts >= limit) return agent.resumeAttempts;

    // Counted before the relaunch, not after it: a resume that dies during
    // `start()` must still have cost a life, or the budget never runs down.
    const attempts = this.store.countAgentResumeAttempt(agentId);
    this.disposeFileEvents(agentId); // fold the dead run's last writes in, then drop its dir
    this.releaseMcp(agentId); // revoke the credential the dead process held
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId); // belongs to the launch that died, not the next one
    this.exited.delete(agentId); // ...and this agent has not been reaped: it is coming back
    debugLog('agent', `auto-resume agent=${agentId} attempt=${attempts}/${limit}`);
    try {
      // `resume` reads `waitingReason` off the row, so an agent that crashed while
      // parked comes back parked on the same still-open escalation.
      if (this.resume({ ...agent, resumeAttempts: attempts }, task)) return null;
    } catch (err) {
      this.store.appendTranscript(agentId, `\nResume after crash failed: ${(err as Error).message}\n`);
    }
    return attempts;
  }

  /**
   * Deliver a first message once the process has had `promptDelayMs` to boot.
   * Stream transport is ready at once (deliver synchronously); an interactive
   * terminal needs the REPL to come up first. No-op when `text` is null.
   */
  private deliverAfterBoot(agentId: string, session: AgentSession, text: string | null): void {
    if (text === null) return;
    const delay = this.opts.promptDelayMs ?? 0;
    const deliver = (): void => {
      if (!this.sessions.has(agentId)) return; // killed/finished before we could send
      try {
        // Prefer the runtime's boot-race-robust initial delivery (the PTY REPL drops
        // the first submitting Enter while it initialises); fall back to a plain send
        // for transports (stream-JSON) that are ready the instant they spawn.
        if (session.deliverInitial) session.deliverInitial(text);
        else session.send(text);
      } catch {
        /* session already gone */
      }
    };
    if (delay <= 0) deliver();
    else setTimeout(deliver, delay).unref?.();
  }

  /**
   * Put a resumed agent back into the parked `waiting` state it held before the
   * restart. The escalation raised then is persisted and, now that the session is
   * live again, an answer routes straight into it; if it's somehow gone, re-raise
   * one so the human is still prompted.
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

  private handleWaiting(agentId: string, task: Task, reason: string, ask?: AgentAsk): void {
    // The convergence point for the two ways an agent asks (see `parked`). An
    // agent already parked is not parked again: re-running the whitelist would
    // auto-answer the same prompt twice, and re-emitting `waiting` would race the
    // inbox's own per-agent dedup rather than relying on it.
    if (this.parked.has(agentId)) return;
    // Parking on a human is the other point where pending writes must surface: the
    // escalation often *is* "review the file I just wrote", and a waiting agent
    // reaches no terminal drain.
    this.drainFileEvents(agentId);
    const rule = this.opts.whitelistedApprovals.find((r) => reason.includes(r.match));
    if (rule) {
      // Auto-answer whitelisted prompts without bothering the human. No latch: the
      // agent is running again, so its next question is a fresh park.
      this.respond(agentId, rule.response);
      this.emit('autoAnswered', { agentId, taskId: task.id, reason, response: rule.response });
      return;
    }
    this.parked.add(agentId);
    // A fresh park is a fresh question, so last park's "it carried on anyway" must
    // not linger and mark the new alert stale on arrival.
    this.store.setAgentResumed(agentId, null);
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('waiting', { agentId, taskId: task.id, reason, ask });
  }

  /**
   * Park an agent because the *account* ran out, not because the agent asked
   * anything (issue #318).
   *
   * It is the same latch and the same three store writes as {@link handleWaiting},
   * and deliberately **not** the same event. `waiting` is what raises an escalation,
   * and an escalation is a question put to a human: this one has no answer, so an
   * inbox row carrying it would be a message nobody can reply to holding a slot in
   * the queue that means "somebody must answer this". What the operator does instead
   * is wait for the window to turn over and resume, which is why the park is
   * announced on its own event and drawn on the agent rather than in the inbox.
   *
   * Nothing is settled: the row keeps its session id, the task stays `waiting`
   * (outstanding, so the work is neither lost nor re-dispatched on top), and the
   * worktree stays on disk — all three are what {@link resumeParked} needs, and all
   * three are what recording this as `failed` used to throw away.
   */
  private handleLimited(agentId: string, task: Task, park: RateLimitPark): void {
    if (this.limited.has(agentId)) return;
    const reason = rateLimitParkReason(park);
    // Same reason as a question park: whatever the agent wrote before the limit bit
    // is part of the record an operator reads before deciding to resume.
    this.drainFileEvents(agentId);
    this.store.flushTranscript(agentId);
    const asked = this.parked.has(agentId);
    this.limited.set(agentId, reason);
    this.parked.add(agentId);
    this.store.setAgentResumed(agentId, null);
    // An agent that asked a question and *then* ran the account out keeps its
    // question on the row: the escalation it raised is still open and still the
    // thing a human must answer, and overwriting the reason with this one would
    // leave that inbox row pointing at a sentence about a limit. The limit is drawn
    // on the agent either way, from the park this registers.
    this.store.updateAgent(agentId, asked ? { status: 'waiting' } : { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('limited', { agentId, taskId: task.id, reason, resetsAt: park.resetsAt });
  }

  /**
   * Give back what the dead launch held while keeping the park itself — the
   * teardown a terminal transition would have done, minus the terminal.
   *
   * The spool and the MCP credential die with the process either way; leaving them
   * bound would leak a live bearer token for the length of a park, which can be
   * hours. `exited`/`exitCodes` are dropped for {@link kill}'s reason: no reap is
   * owed for a process whose work is unfinished, and a stale `exited` entry would
   * make the *resumed* run's first terminal reap a worktree out from under a live
   * agent.
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
  private reinstateLimitPark(agentId: string, task: Task, reason: string): void {
    this.limited.set(agentId, reason);
    this.parked.add(agentId);
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
  }

  /**
   * Record that a *parked* agent made a tool call — it is working, not waiting.
   *
   * Deliberately does **not** un-park it. The park is a latch (see {@link parked})
   * and the runtime's own session status is `waiting` too, so flipping the row back
   * to `running` here would desynchronise the two and let the next turn-end file a
   * *second* escalation on top of the one this is meant to cast doubt on. The park
   * is the harness's model of the session; this is an observation about that model
   * being out of date, and the human resolves the disagreement by answering or
   * dismissing. Idempotent by intent — repeated tool calls just refresh the stamp.
   */
  private noteResumed(agentId: string, taskId: string): void {
    if (!this.parked.has(agentId)) return;
    const resumedAt = new Date().toISOString();
    this.store.setAgentResumed(agentId, resumedAt);
    this.emit('resumed', { agentId, taskId, resumedAt });
  }

  /**
   * Drop the park latch without typing anything into the agent — what dismissing an
   * alert does. Releasing it is the whole point rather than a detail: while the
   * latch is held {@link handleWaiting} early-returns, so an agent whose alert was
   * dismissed could never raise another one. It leaves `status` alone, because the
   * session's own status is untouched and a dismissed alert makes no claim about
   * whether the agent is working.
   */
  releasePark(agentId: string): void {
    this.parked.delete(agentId);
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
    by: 'agent' | 'operator' = 'agent',
    /** Appended to the recorded failure, e.g. how many automatic resumes were spent. */
    failureNote?: string,
  ): void {
    this.drainFileEvents(agentId); // catch a report written just before finishing
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.store.flushTranscript(agentId); // make the finished agent's transcript durable
    this.store.updateAgent(agentId, { status, endedAt: new Date().toISOString(), pid: null });
    this.store.updateTask(taskId, { status });
    this.sessions.delete(agentId);
    const exitCode = this.exitCodes.get(agentId);
    this.exitCodes.delete(agentId);
    if (status === 'failed') {
      // Surface the crash with its cause: the exit code (when the session exposed
      // one) plus a tail of the agent's output, so "why did it die" is answerable
      // from the Errors panel without digging through the transcript.
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
    this.releaseMcp(agentId); // ...and with it the bridge that held the credential
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

/**
 * What a resumed agent is told. Deliberately not `buildResumeMessage`'s "you were
 * resumed after a server restart": nothing restarted, and an agent that believes
 * otherwise re-reads its branch looking for work it did itself minutes ago.
 */
const LIMIT_RESUME_MESSAGE =
  'This account hit its usage limit mid-turn, so the harness parked you and an operator has just ' +
  'resumed you. Nothing else changed — the worktree and the conversation are the ones you left. ' +
  'Continue the task from where you stopped.';

/** How `claude` names each usage window, in words an operator reads. */
const LIMIT_WINDOWS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'seven-day',
  seven_day_opus: 'seven-day Opus',
  seven_day_sonnet: 'seven-day Sonnet',
  seven_day_overage_included: 'seven-day (overage included)',
  overage: 'overage',
};

/**
 * The sentence that goes on the row — and so onto every surface that draws a
 * parked agent. It has one job the status cannot do: say that the *account* ran
 * out rather than the agent, since "waiting" on its own reads as a question
 * somebody has failed to answer.
 *
 * An unknown window name is printed verbatim rather than dropped: `claude` may
 * add one, and a park that names no limit is the failure this exists to prevent.
 */
function rateLimitParkReason(park: RateLimitPark): string {
  const window = park.limitType ? (LIMIT_WINDOWS[park.limitType] ?? park.limitType) : null;
  const what = park.overage
    ? `this account's overage allowance is spent${window ? ` (${window})` : ''}`
    : `this account's ${window ? `${window} ` : ''}usage limit is spent`;
  const when = park.resetsAt ? `, and it resets at ${park.resetsAt}` : '';
  return `Parked on a usage limit: ${what}${when}. Nothing is wrong with the run — resume it once the limit clears.`;
}

/**
 * Reduce a hook-reported write path to worktree-relative when it landed inside the
 * agent's cwd (so the artifact route — confined to the worktree — can serve it),
 * else leave it as reported. `claude`'s file tools report absolute paths.
 *
 * The result is normalised to forward slashes: on Windows `relative()` yields
 * `out\summary.md`, but the stored path is used as an artifact *ref* — served by
 * the URL-oriented `/api/artifacts/:id` route and displayed/linked in the cockpit
 * — so it must match the forward-slash form every other platform produces. `\` is
 * always a separator on the Windows paths these tools report, never a filename
 * char, and POSIX `relative()`/claude already emit `/`, so this is a no-op there.
 */
function toWorktreeRelative(cwd: string, p: string): string {
  const toPosix = (s: string): string => s.replace(/\\/g, '/');
  if (!isAbsolute(p)) return toPosix(p);
  const rel = relative(cwd, p);
  return toPosix(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p);
}
