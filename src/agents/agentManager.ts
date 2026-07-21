import { EventEmitter } from 'node:events';
import { PtySession } from '../pty/ptySession.js';
import type { PtyBackend } from '../pty/backend.js';
import type { Store } from '../store/store.js';
import type { WhitelistRule } from '../config.js';
import type { Agent, AgentStatus, Task } from '../types.js';

export interface AgentManagerOptions {
  command: string;
  args: string[];
  whitelistedApprovals: WhitelistRule[];
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
  private readonly sessions = new Map<string, PtySession>();

  constructor(
    private readonly backend: PtyBackend,
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
  ) {
    super();
  }

  /** Spawn an agent for a task in the given working directory. */
  spawn(task: Task, cwd: string): Agent {
    const session = new PtySession(this.backend, {
      command: this.opts.command,
      args: this.opts.args,
      cwd,
      env: { LUBBDUBB_PROMPT: task.prompt, LUBBDUBB_TASK_ID: task.id },
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

  kill(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    session.kill();
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
