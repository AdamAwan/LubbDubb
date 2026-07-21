import { EventEmitter } from 'node:events';
import type { Store } from '../store/store.js';
import type { WhitelistRule } from '../config.js';
import type { Agent, AgentStatus, Task } from '../types.js';
import type { AgentSession, SessionFactory } from './session.js';

export interface AgentManagerOptions {
  command: string;
  args: string[];
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
  /** Delay before sending the initial input, giving an interactive CLI time to start. */
  promptDelayMs?: number;
  /** Extra literal substrings a PTY session treats as "waiting for input". */
  waitingPatterns?: string[];
}

interface AgentManagerEvents {
  output: [{ agentId: string; delta: string }];
  waiting: [{ agentId: string; taskId: string; reason: string }];
  autoAnswered: [{ agentId: string; taskId: string; reason: string; response: string }];
  done: [{ agentId: string; taskId: string; status: AgentStatus }];
  status: [{ agentId: string; taskId: string; status: AgentStatus }];
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

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
  ) {
    super();
  }

  /** Spawn an agent for a task in the given working directory. */
  spawn(task: Task, cwd: string): Agent {
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.args,
      cwd,
      env: { LUBBDUBB_PROMPT: task.prompt, LUBBDUBB_TASK_ID: task.id },
      waitingPatterns: this.opts.waitingPatterns,
    });

    const agent = this.store.createAgent({ taskId: task.id, cwd, pid: null, status: 'starting' });
    this.store.updateTask(task.id, { status: 'running', agentId: agent.id });
    this.sessions.set(agent.id, session);

    session.on('output', (delta: string) => {
      this.store.appendTranscript(agent.id, delta);
      this.emit('output', { agentId: agent.id, delta });
    });

    session.on('status', (status) => {
      if (status === 'running') {
        this.store.updateAgent(agent.id, { status: 'running', pid: session.pid, waitingReason: null });
        this.reflectStatus(agent.id, task.id, 'running');
      }
    });

    session.on('waiting', (reason: string) => this.handleWaiting(agent.id, task, reason));

    session.on('done', () => this.handleTerminal(agent.id, task.id, 'done'));
    session.on('failed', () => this.handleTerminal(agent.id, task.id, 'failed'));

    session.start();

    // Hand the agent its task. For a real `claude` REPL this is typed in after a
    // short boot delay; the mock agent takes its prompt from the environment and
    // opts out by returning null.
    const initial = this.opts.initialInput?.(task) ?? null;
    if (initial !== null) {
      const delay = this.opts.promptDelayMs ?? 0;
      const deliver = (): void => {
        if (!this.sessions.has(agent.id)) return; // killed/finished before we could send
        try {
          session.send(initial);
        } catch {
          /* session already gone */
        }
      };
      // Stream transport: stdin is ready at once, deliver synchronously. Interactive
      // terminal: wait for the REPL to boot before typing.
      if (delay <= 0) deliver();
      else setTimeout(deliver, delay).unref?.();
    }

    return agent;
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
    if (agent) this.reflectStatus(agentId, agent.taskId, 'killed');
    return true;
  }

  isLive(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  // -- internals -----------------------------------------------------------

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

  private handleTerminal(agentId: string, taskId: string, status: 'done' | 'failed'): void {
    this.store.flushTranscript(agentId); // make the finished agent's transcript durable
    this.store.updateAgent(agentId, { status, endedAt: new Date().toISOString(), pid: null });
    this.store.updateTask(taskId, { status });
    this.sessions.delete(agentId);
    this.reflectStatus(agentId, taskId, status);
    this.emit('done', { agentId, taskId, status });
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
