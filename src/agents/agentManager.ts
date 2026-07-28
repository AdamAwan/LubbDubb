import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  IssueConclusion,
  IssueConclusionVerdict,
  Task,
} from '../types.js';
import { conclusionOrigin } from '../issueConclusion.js';
import { assessmentOrigin, type AssessmentVerdict } from '../mcp/assessment.js';
import type { ParsedFlag } from './sentinels.js';
import { classifyArtifact, type FileEventRecord, type FileEventsSpool } from './fileEvents.js';
import { PLAN_FILE, isPlanFile, parsePlanDocument } from '../plans/planDocument.js';
import { ingestPlanDocument, overriddenSingleMessage } from '../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../plans/planning.js';
import type { AgentSession, SessionFactory } from './session.js';
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
   * Runtimes that don't support session ids (mock/stream) ignore the first two.
   */
  buildArgs: (opts: { sessionId: string; resume: boolean; mcpConfigPath: string | null }) => string[];
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
  /** Central error sink: agent failures (spawn errors, crashes + exit codes) are recorded here. */
  errors?: ErrorRecorder;
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
  /** The agent said what it is working on (already persisted onto its row, replacing the previous note). */
  progress: [{ agentId: string; taskId: string; note: string; notedAt: string }];
  /** The agent said whether its issue is finished (already persisted against the issue origin). */
  conclusion: [{ agentId: string; taskId: string; conclusion: IssueConclusion }];
  assessment: [{ agentId: string; taskId: string; issueOrigin: string; verdict: AssessmentVerdict }];
  /** The file-events hook recorded one or more written files (the "files changed" list grew). */
  files: [{ agentId: string; taskId: string }];
  /**
   * A parked agent was seen making a tool call — i.e. it carried on working rather
   * than waiting, so the open alert against it is probably stale. Already persisted
   * as `Agent.resumedAt`; emitted so the cockpit learns now rather than next poll.
   */
  resumed: [{ agentId: string; taskId: string; resumedAt: string }];
}

/**
 * Owns the fleet of live PTY agent sessions: spawn, stream, detect
 * waiting/done, feed input, kill. It maps {@link PtySession} events onto store
 * updates and re-emits them for the server to broadcast. Whitelisted waiting
 * prompts are auto-answered here; everything else surfaces as a `waiting` event
 * for the harness to escalate.
 */
export class AgentManager extends EventEmitter {
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

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
  ) {
    super();
  }

  /** Spawn an agent for a task in the given working directory. */
  spawn(task: Task, cwd: string): Agent {
    // Choose the session id up front so we own it and can `--resume` this exact
    // conversation after a restart. Only resumable runtimes get one.
    const sessionId = this.opts.resumable ? randomUUID() : null;
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
        resume: false,
        mcpConfigPath: mcp?.configPath ?? null,
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
      resume: false,
    });

    const agent = this.store.createAgent({ taskId: task.id, cwd, pid: null, status: 'starting', sessionId });
    if (eventsKey) this.eventsKeys.set(agent.id, eventsKey);
    if (mcp) {
      this.opts.mcp?.bind(mcp.token, agent.id);
      this.mcpTokens.set(agent.id, mcp.token);
    }
    debugLog(
      'agent',
      `spawn agent=${agent.id} cwd=${cwd} eventsDir=${this.fileEventsDir(agent.id) ?? '<file-events off>'}`,
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
   */
  resume(agent: Agent, task: Task): boolean {
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
    else this.deliverAfterBoot(agent.id, session, this.opts.resumeInput?.() ?? null);

    return true;
  }

  /** Type text into a live agent (a human response or a follow-up prompt). */
  respond(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    session.send(text);
    this.parked.delete(agentId); // the park is over; the next ask is a new one
    this.store.setAgentResumed(agentId, null); // answered, so "it carried on anyway" is spent
    this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
    return true;
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
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    const question = ask.question.trim();
    if (!question) return { ok: false, error: 'question must not be empty' };
    this.handleWaiting(agentId, task, question, ask);
    // Listeners are synchronous, so by now the inbox has either created the
    // escalation or the whitelist answered and moved the agent back to running.
    const open = this.store.listOpenEscalations().find((e) => e.agentId === agentId) ?? null;
    return { ok: true, escalationId: open?.id ?? null };
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
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    const { finding, created } = this.store.recordFinding(agentId, task.id, task.originRef, input);
    this.emit('finding', { agentId, taskId: task.id, finding, created });
    return { ok: true, finding };
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
   *
   * @public — reached only through `AgentToolTarget` (`src/mcp/tools.ts`), which this
   * class satisfies structurally; knip's member analysis is name-based.
   */
  linkTicket(agentId: string, ticketRef: string): { ok: true; finding: Finding } | { ok: false; error: string } {
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    const jobId = task.originRef?.startsWith('job:') ? task.originRef.slice('job:'.length) : null;
    const finding = jobId ? this.store.findFindingByJobId(jobId) : null;
    if (!finding) {
      return {
        ok: false,
        error:
          `link_ticket is only for a job dispatched to file a finding as a ticket. This task's origin ` +
          `is ${task.originRef ?? '(none)'}, which was not created from a finding.`,
      };
    }
    // Idempotence lives in the write, not in a read-then-check here.
    const linked = this.store.linkFindingTicket(finding.id, ticketRef);
    if (!linked) {
      return {
        ok: false,
        error: `finding ${finding.id} is ${finding.status}, not awaiting a ticket — nothing to link.`,
      };
    }
    this.emit('finding', { agentId, taskId: task.id, finding: linked, created: false });
    return { ok: true, finding: linked };
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
   *
   * @public — reached only through `AgentToolTarget` (`src/mcp/tools.ts`), which this
   * class satisfies structurally rather than by an `implements` clause: the tool layer
   * depends on the fleet, never the reverse. knip's member analysis is name-based, so
   * without the tag it reads as uncalled.
   */
  recordProgress(agentId: string, note: string): { ok: true; notedAt: string } | { ok: false; error: string } {
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    const notedAt = this.store.recordAgentNote(agentId, note);
    this.emit('progress', { agentId, taskId: task.id, note, notedAt });
    return { ok: true, notedAt };
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
   *
   * @public — reached only through `AgentToolTarget` (`src/mcp/tools.ts`), which this
   * class satisfies structurally; knip's member analysis is name-based.
   */
  recordConclusion(
    agentId: string,
    verdict: IssueConclusionVerdict,
    note: string,
  ): { ok: true; conclusion: IssueConclusion } | { ok: false; error: string } {
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
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
  }

  /**
   * Record an assessor's verdict on the issue it was dispatched to judge.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse.
   *
   * The two verdicts land in two different places, because they are two
   * statements that already exist. `more_work` *is* what `issue_conclusions`
   * means and what rule 3b's inverse arm already reads — a second source for one
   * statement would be the duplicate-opinion bug. `delivered` is the park, and
   * gates pickup, which no conclusion does. Their mutual exclusion is enforced in
   * the store, so it is not re-implemented here.
   *
   * @public — reached only through `AgentToolTarget` (`src/mcp/tools.ts`), which this
   * class satisfies structurally; knip's member analysis is name-based.
   */
  recordAssessment(
    agentId: string,
    verdict: AssessmentVerdict,
    summary: string,
  ): { ok: true; issueOrigin: string; verdict: AssessmentVerdict } | { ok: false; error: string } {
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    const origin = assessmentOrigin(task.originRef);
    if (!origin.ok) return { ok: false, error: origin.error };

    if (verdict === 'delivered') {
      this.store.recordDelivery({
        originRef: origin.issueOrigin,
        summary,
        by: 'assessor',
        agentId,
        taskId: task.id,
      });
    } else {
      this.store.recordIssueConclusion({
        originRef: origin.issueOrigin,
        verdict: 'more_work',
        note: summary,
        by: 'assessor',
        agentId,
        taskId: task.id,
      });
    }
    this.emit('assessment', { agentId, taskId: task.id, issueOrigin: origin.issueOrigin, verdict });
    return { ok: true, issueOrigin: origin.issueOrigin, verdict };
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
    if (!session) return false;
    session.kill();
    this.disposeFileEvents(agentId); // fold any last writes in, then drop the spool
    this.releaseMcp(agentId); // the credential dies with the agent, not with the process
    this.parked.delete(agentId);
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
   * Persist a planning agent's verdict from the `plan.json` it just wrote.
   *
   * The verdict is stored for *both* outcomes — a `single` plan is a first-class
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
    if (result.overriddenSingle) {
      // Not silently overridden: the planner asked for something the world no
      // longer allows, and the operator has open PRs that explain why. (The tool
      // path can say this to the agent as well; the file path has no way to.)
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agent.id}: ${overriddenSingleMessage(origin, result.overriddenSingle.liveParts)}`,
      });
    }
    debugLog(
      'fileEvents',
      `agent=${agent.id} plan ingested issue=#${number} verdict=${doc.verdict} status=${result.status} retired=${result.retired.length}`,
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
    // Both runtimes emit `exit` (with the process exit code) before `failed`, so
    // the code is in hand by the time the terminal transition is recorded.
    session.on('exit', (code: number) => {
      this.exitCodes.set(agentId, code);
      this.exited.add(agentId);
      this.maybeReap(agentId, task.id);
    });
    session.on('done', () => this.handleTerminal(agentId, task.id, 'done'));
    session.on('failed', () => this.handleTerminal(agentId, task.id, 'failed'));
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
  ): void {
    this.drainFileEvents(agentId); // catch a report written just before finishing
    this.parked.delete(agentId);
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
        message: `Agent ${agentId} failed (task ${taskId})${exitCode !== undefined ? `, exit code ${exitCode}` : ''}`,
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
