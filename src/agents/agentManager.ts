import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { ErrorRecorder } from '../errorLog.js';
import { recentOutputExcerpt } from '../escalation/context.js';
import type { WhitelistRule } from '../config.js';
import type { Agent, AgentStatus, AgentUsage, Task } from '../types.js';
import type { AgentSession, SessionFactory } from './session.js';

export interface AgentManagerOptions {
  command: string;
  /**
   * Builds the argv for a launch. `sessionId` is the id the agent runs under and
   * `resume` re-attaches to it (`claude --resume`) instead of starting fresh.
   * Runtimes that don't support session ids (mock/stream) ignore both.
   */
  buildArgs: (opts: { sessionId: string; resume: boolean }) => string[];
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
  /** Central error sink: agent failures (spawn errors, crashes + exit codes) are recorded here. */
  errors?: ErrorRecorder;
}

interface AgentManagerEvents {
  output: [{ agentId: string; delta: string }];
  /** Legible PTY mode only: the settled transcript was rewritten in place — replaces all prior output. */
  transcript: [{ agentId: string; text: string }];
  waiting: [{ agentId: string; taskId: string; reason: string }];
  autoAnswered: [{ agentId: string; taskId: string; reason: string; response: string }];
  done: [{ agentId: string; taskId: string; status: AgentStatus }];
  /**
   * The agent finished (done/failed) *and* its OS process has actually exited —
   * the two arrive in either order (PTY: sentinel first, exit later; stream:
   * exit first). Only now is it safe to touch resources the process pinned,
   * e.g. removing its worktree cwd.
   */
  reaped: [{ agentId: string; taskId: string; status: 'done' | 'failed' }];
  status: [{ agentId: string; taskId: string; status: AgentStatus }];
  usage: [{ agentId: string; taskId: string; usage: AgentUsage }];
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
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({ sessionId: sessionId ?? '', resume: false }),
      cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.statusFileEnv(sessionId),
      },
      waitingPatterns: this.opts.waitingPatterns,
    });

    const agent = this.store.createAgent({ taskId: task.id, cwd, pid: null, status: 'starting', sessionId });
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
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({ sessionId: agent.sessionId, resume: true }),
      cwd: agent.cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.statusFileEnv(agent.sessionId),
      },
      waitingPatterns: this.opts.waitingPatterns,
    });

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
    this.store.updateAgent(agentId, { status: 'running', waitingReason: null });
    return true;
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
      this.store.flushTranscript(id); // make the transcript durable before we exit
      this.store.updateAgent(id, { status: 'interrupted', endedAt: at, pid: null });
      this.sessions.delete(id);
      this.exitCodes.delete(id);
      this.exited.delete(id);
    }
  }

  // -- internals -----------------------------------------------------------

  /** The LUBBDUBB_STATUS_FILE env entry for a launch, when status capture is wired. */
  private statusFileEnv(sessionId: string | null): Record<string, string> {
    if (!sessionId || !this.opts.statusFile) return {};
    return { LUBBDUBB_STATUS_FILE: this.opts.statusFile(sessionId) };
  }

  /** Attach the store-update + re-emit listeners shared by fresh spawns and resumes. */
  private wireSession(session: AgentSession, agentId: string, task: Task): void {
    session.on('output', (delta: string) => {
      this.store.appendTranscript(agentId, delta);
      this.emit('output', { agentId, delta });
    });

    // Legible PTY sessions occasionally re-render the settled text wholesale
    // (an in-place TUI rewrite); the stored transcript follows the rewrite.
    session.on('transcript', (text: string) => {
      this.store.setTranscript(agentId, text);
      this.emit('transcript', { agentId, text });
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
   * restart. The escalation raised then is persisted and, now that the session is
   * live again, an answer routes straight into it; if it's somehow gone, re-raise
   * one so the human is still prompted.
   */
  private restoreWaiting(agent: Agent, task: Task): void {
    const reason = agent.waitingReason ?? 'Resumed agent is awaiting your input.';
    this.store.updateAgent(agent.id, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agent.id, task.id, 'waiting');
    const hasOpen = this.store.listOpenEscalations().some((e) => e.agentId === agent.id);
    if (!hasOpen) this.emit('waiting', { agentId: agent.id, taskId: task.id, reason });
  }

  private handleWaiting(agentId: string, task: Task, reason: string): void {
    const rule = this.opts.whitelistedApprovals.find((r) => reason.includes(r.match));
    if (rule) {
      // Auto-answer whitelisted prompts without bothering the human.
      this.respond(agentId, rule.response);
      this.emit('autoAnswered', { agentId, taskId: task.id, reason, response: rule.response });
      return;
    }
    this.store.updateAgent(agentId, { status: 'waiting', waitingReason: reason });
    this.store.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('waiting', { agentId, taskId: task.id, reason });
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

  private handleTerminal(agentId: string, taskId: string, status: 'done' | 'failed'): void {
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
    this.emit('done', { agentId, taskId, status });
    this.terminals.set(agentId, status);
    this.maybeReap(agentId, taskId);
  }

  /** Emit 'reaped' once a finished agent's process has also exited (whichever came second). */
  private maybeReap(agentId: string, taskId: string): void {
    const status = this.terminals.get(agentId);
    if (!status || !this.exited.has(agentId)) return;
    this.terminals.delete(agentId);
    this.exited.delete(agentId);
    this.emit('reaped', { agentId, taskId, status });
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
