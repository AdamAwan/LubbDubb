import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { recentOutputExcerpt } from '../escalation/context.js';
import type { Agent, AgentStatus, AgentUsage, AccountRateLimits, ApiErrorReading, StallPark, Task } from '../types.js';
import type { Store } from '../store/store.js';
import { isSealedRule } from '../mcp/names.js';
import type { AgentToolTarget } from '../mcp/tools/context.js';
import type { ParsedFlag } from './sentinels.js';
import type { AgentSession } from './session.js';
import { liftedTask, type LiftProfile } from './profileLift.js';
import type { RateLimitPark } from './streamJsonSession.js';
import { debugLog } from '../debug.js';
import { HUMAN_BLOCK, renderBlocks } from './streamTranscript.js';
import { AgentChannels } from './agentChannels.js';
import { AgentParks } from './agentParks.js';
import { AgentToolDesk } from './agentToolDesk.js';
import type { AgentManagerEvents, AgentManagerOptions, TerminalBy } from './agentContract.js';

// → docs/spec/10-agent-runtimes.md

export interface LimitResumeFailure {
  agentId: string;
  error: string;
}

export class AgentManager extends EventEmitter implements AgentToolTarget {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly exitCodes = new Map<string, number>();
  private readonly terminals = new Map<string, 'done' | 'failed' | 'killed'>();
  private readonly exited = new Set<string>();
  private readonly channels: AgentChannels;
  private readonly parks: AgentParks;
  private readonly tools: AgentToolDesk;

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
  ) {
    super();
    this.channels = new AgentChannels(store, opts, this);
    this.parks = new AgentParks(store, opts, this, this.channels, {
      hasExited: (agentId) => this.exited.has(agentId),
      noteSent: (agentId, session, text) => this.noteSent(agentId, session, text),
      respond: (agentId, text) => this.respond(agentId, text),
      shedSession: (agentId) => this.shedLimitedSession(agentId),
    });
    this.tools = new AgentToolDesk(store, opts, this, {
      isLive: (agentId) => this.sessions.has(agentId),
      wait: (agentId, task, question, ask) => this.parks.handleWaiting(agentId, task, question, ask),
    });
  }

  readonly ask: AgentToolTarget['ask'] = (...args) => this.tools.ask(...args);
  readonly requestHumanTask: AgentToolTarget['requestHumanTask'] = (...args) => this.tools.requestHumanTask(...args);
  readonly recordProgress: AgentToolTarget['recordProgress'] = (...args) => this.tools.recordProgress(...args);
  readonly filingTarget: AgentToolTarget['filingTarget'] = (...args) => this.tools.filingTarget(...args);
  readonly linkTicket: AgentToolTarget['linkTicket'] = (...args) => this.tools.linkTicket(...args);
  readonly recordConclusion: AgentToolTarget['recordConclusion'] = (...args) => this.tools.recordConclusion(...args);
  readonly recordBlocked: AgentToolTarget['recordBlocked'] = (...args) => this.tools.recordBlocked(...args);
  readonly recordAssessment: AgentToolTarget['recordAssessment'] = (...args) => this.tools.recordAssessment(...args);
  readonly recordGoalMet: AgentToolTarget['recordGoalMet'] = (...args) => this.tools.recordGoalMet(...args);
  readonly recordAppraisal: AgentToolTarget['recordAppraisal'] = (...args) => this.tools.recordAppraisal(...args);
  readonly recordPartOutcome: AgentToolTarget['recordPartOutcome'] = (...args) => this.tools.recordPartOutcome(...args);
  readonly appendScratch: AgentToolTarget['appendScratch'] = (...args) => this.tools.appendScratch(...args);
  readonly readScratch: AgentToolTarget['readScratch'] = (...args) => this.tools.readScratch(...args);
  readonly recordFeatureSummary: AgentToolTarget['recordFeatureSummary'] = (...args) =>
    this.tools.recordFeatureSummary(...args);
  readonly recordFeatureSequence: AgentToolTarget['recordFeatureSequence'] = (...args) =>
    this.tools.recordFeatureSequence(...args);
  readonly recordRetrospective: AgentToolTarget['recordRetrospective'] = (...args) =>
    this.tools.recordRetrospective(...args);
  readonly recordRemedy: AgentToolTarget['recordRemedy'] = (...args) => this.tools.recordRemedy(...args);
  readonly recordThreadLabel: AgentToolTarget['recordThreadLabel'] = (...args) => this.tools.recordThreadLabel(...args);

  spawn(task: Task, cwd: string, resumeSessionId?: string | null): Agent {
    const inherited = this.opts.resumable ? (resumeSessionId ?? null) : null;
    const sessionId = inherited ?? (this.opts.resumable ? randomUUID() : null);
    const { session, eventsKey, mcp } = this.channels.openSession(task, cwd, sessionId, inherited !== null);

    const agent = this.store.agents.createAgent({ taskId: task.id, cwd, pid: null, status: 'starting', sessionId });
    this.channels.bind(agent.id, eventsKey, mcp);
    debugLog(
      'agent',
      `spawn agent=${agent.id} cwd=${cwd} eventsDir=${this.channels.fileEventsDir(agent.id) ?? '<file-events off>'}` +
        `${inherited ? ` resumed=${inherited}` : ''}`,
    );
    this.store.tasks.updateTask(task.id, { status: 'running', agentId: agent.id });
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
    const { session, eventsKey, mcp } = this.channels.openSession(task, agent.cwd, agent.sessionId, true);
    this.channels.bind(agent.id, eventsKey, mcp);
    debugLog(
      'agent',
      `resume agent=${agent.id} cwd=${agent.cwd} eventsDir=${this.channels.fileEventsDir(agent.id) ?? '<file-events off>'}`,
    );

    this.sessions.set(agent.id, session);
    this.store.agents.updateAgent(agent.id, { status: 'running', pid: null, endedAt: null, waitingReason: null });
    this.store.tasks.updateTask(task.id, { status: 'running' });
    this.wireSession(session, agent.id, task);
    try {
      session.start();
    } catch (err) {
      this.sessions.delete(agent.id);
      throw new Error(`resume spawn failed for agent ${agent.id}: ${(err as Error).message}`);
    }

    if (wasWaiting) {
      this.parks.restoreWaiting(agent, task);
    } else {
      const carryOn = nudge ?? this.opts.resumeInput?.() ?? null;
      if (carryOn !== null) this.noteSent(agent.id, session, carryOn);
      this.deliverAfterBoot(agent.id, session, carryOn);
    }

    return true;
  }

  fileEventsDir(agentId: string): string | null {
    return this.channels.fileEventsDir(agentId);
  }

  drainFileEvents(agentId: string): void {
    this.channels.drainFileEvents(agentId);
  }

  resumeParked(agentId: string): { ok: true } | { ok: false; error: string } {
    const park = this.parks.limitPark(agentId);
    if (park === undefined) return { ok: false, error: 'this agent is not parked on a usage limit' };
    return this.tools.forCaller(agentId, ({ agent, task }) => {
      const session = this.sessions.get(agentId);
      if (!session && (!this.opts.resumable || !agent.sessionId)) {
        return { ok: false, error: 'this agent runtime cannot re-open its session, so the park cannot be ended' };
      }
      this.parks.clear(agentId);
      this.store.agents.setAgentResumed(agentId, null);
      this.store.agents.updateAgent(agentId, { status: 'running', waitingReason: null });
      this.store.tasks.updateTask(task.id, { status: 'running' });

      if (session) {
        this.noteSent(agentId, session, LIMIT_RESUME_MESSAGE);
        session.send(LIMIT_RESUME_MESSAGE);
        this.reflectStatus(agentId, task.id, 'running');
        return { ok: true };
      }

      const row = this.store.agents.getAgent(agentId);
      try {
        if (!row || !this.resume(row, task, LIMIT_RESUME_MESSAGE)) throw new Error('the runtime declined the resume');
      } catch (err) {
        this.parks.reinstateLimitPark(agentId, task, park);
        return { ok: false, error: `could not re-open the session: ${(err as Error).message}` };
      }
      return { ok: true };
    });
  }

  /** @public Reached through the structural `fleet` seam on `HarnessDeps` (`src/harness.ts`). */
  resumeExpiredParks(): LimitResumeFailure[] {
    const failures: LimitResumeFailure[] = [];
    this.parks.expireLimitParks((agentId) => {
      const result = this.resumeParked(agentId);
      if (!result.ok) failures.push({ agentId, error: result.error });
    });
    return failures;
  }

  completeExpiredStalls(): string[] {
    return this.parks.completeExpiredStalls((agentId) => this.complete(agentId, 'expiry'));
  }

  limitedAgentIds(): string[] {
    return this.parks.limitedAgentIds();
  }

  stallDeadlines(): StallPark[] {
    return this.parks.stallDeadlines();
  }

  extendStallPark(agentId: string): { ok: true; expiresAt: string } | { ok: false; error: string } {
    return this.parks.extendStallPark(agentId);
  }

  releasePark(agentId: string): void {
    this.parks.releasePark(agentId);
  }

  private noteSent(agentId: string, session: AgentSession, text: string): void {
    if (session.recordsSentMessages) return;
    const note = renderBlocks([{ type: HUMAN_BLOCK, text }], new Date().toISOString());
    if (!note) return;
    this.store.transcripts.appendTranscript(agentId, note);
    this.emit('output', { agentId, delta: note });
  }

  notify(agentId: string, text: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session || this.parks.isParked(agentId)) return false;
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
    this.parks.clear(agentId);
    this.store.agents.setAgentResumed(agentId, null);
    this.store.agents.updateAgent(agentId, { status: 'running', waitingReason: null });
    return true;
  }

  interrupt(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    session.sendRaw('\x03');
    return true;
  }

  kill(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session && !this.parks.isLimited(agentId)) return false;
    session?.kill();
    this.channels.disposeFileEvents(agentId);
    this.channels.releaseMcp(agentId);
    this.parks.clear(agentId);
    this.store.transcripts.flushTranscript(agentId);
    const agent = this.store.agents.getAgent(agentId);
    this.store.agents.updateAgent(agentId, { status: 'killed', endedAt: new Date().toISOString(), pid: null });
    if (agent) this.store.tasks.updateTask(agent.taskId, { status: 'interrupted' });
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

  lift(
    agentId: string,
    profile: LiftProfile,
  ): { ok: true; agentId: string; taskId: string } | { ok: false; error: string } {
    if (!this.sessions.has(agentId)) return { ok: false, error: 'agent is no longer live' };
    return this.tools.forCaller(agentId, ({ agent, task }) => {
      if (!this.opts.resumable || !agent.sessionId)
        return {
          ok: false,
          error:
            'this agent runtime keeps no session id, so its conversation cannot be carried on to another ' +
            'profile — lifting it would start the work cold',
        };
      if (task.profile === profile.name)
        return { ok: false, error: `this agent is already running on "${profile.name}"` };
      const { cwd, sessionId } = agent;
      // The successor task is written before the kill, not after: `reaped` releases the
      // worktree slot for a branch no active task holds, and this row is what holds it.
      const successor = this.store.tasks.createTask(liftedTask(task, profile));
      this.kill(agentId);
      let next;
      try {
        next = this.spawn(successor, cwd, sessionId);
      } catch (err) {
        this.store.tasks.updateTask(successor.id, { status: 'failed' });
        return { ok: false, error: `could not re-open the session on "${profile.name}": ${(err as Error).message}` };
      }
      debugLog('agent', `lifted agent=${agentId} to=${next.id} profile=${profile.name} session=${sessionId}`);
      this.store.decisions.recordDecision({
        cycleId: `human:${agentId}`,
        action: { type: 'no_op', reason: `operator lifted the run to the "${profile.name}" profile` },
        outcome: 'executed',
        detail:
          `Stopped agent ${agentId} (task ${task.id}${task.originRef ? `, ${task.originRef}` : ''}) on ` +
          `"${task.profile ?? 'no profile'}" and re-opened its conversation as agent ${next.id} ` +
          `(task ${successor.id}) on "${profile.name}" in ${cwd}`,
      });
      return { ok: true, agentId: next.id, taskId: successor.id };
    });
  }

  complete(agentId: string, by: 'operator' | 'expiry' = 'operator'): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    const agent = this.store.agents.getAgent(agentId);
    if (!agent) return false;
    const id = agent.id;
    session.kill();
    this.handleTerminal(id, agent.taskId, 'done', by);
    const task = this.store.tasks.getTask(agent.taskId);
    this.store.decisions.recordDecision({
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
      this.channels.disposeFileEvents(id);
      this.channels.releaseMcp(id);
      this.store.transcripts.flushTranscript(id);
      this.store.agents.updateAgent(id, { status: 'interrupted', endedAt: at, pid: null });
      this.sessions.delete(id);
      this.exitCodes.delete(id);
      this.exited.delete(id);
      this.parks.unpark(id);
    }
  }

  private wireSession(session: AgentSession, agentId: string, task: Task): void {
    session.on('output', (delta: string) => {
      this.store.transcripts.appendTranscript(agentId, delta);
      this.emit('output', { agentId, delta });
      this.channels.drainFileEvents(agentId);
    });

    session.on('status', (status) => {
      if (status === 'running') {
        this.store.agents.updateAgent(agentId, { status: 'running', pid: session.pid, waitingReason: null });
        this.reflectStatus(agentId, task.id, 'running');
      }
    });

    session.on('usage', (usage: AgentUsage) => {
      this.store.agents.recordAgentUsage(agentId, usage);
      this.emit('usage', { agentId, taskId: task.id, usage });
    });

    session.on('limits', (limits: AccountRateLimits) => this.store.rateLimits.recordRateLimits(limits));

    session.on('apiError', (reading: ApiErrorReading) => {
      this.store.apiErrors.recordApiError({
        ...reading,
        agentId,
        taskId: task.id,
        originRef: task.originRef ?? null,
        model: task.model ?? null,
      });
      this.opts.errors?.record({
        source: 'agent',
        message: `Agent ${agentId}: the model API refused a turn (${reading.kind}${reading.code ? `: ${reading.code}` : ''}).`,
        detail: reading.message,
      });
    });

    session.on('flag', (flag: ParsedFlag) => {
      const saved = this.store.agents.recordFlag(agentId, flag);
      this.emit('flag', { agentId, taskId: task.id, flag: saved });
    });

    session.on('activity', () => {
      this.store.agents.countAgentStep(agentId);
      this.parks.noteResumed(agentId, task.id);
    });

    session.on('waiting', (reason: string) => this.parks.handleWaiting(agentId, task, reason));
    session.on('stalled', (lastWords: string) => this.parks.handleStalled(session, agentId, task, lastWords));
    session.on('silent', (silenceMs: number) => this.parks.handleSilent(agentId, task, silenceMs));
    session.on('limited', (park: RateLimitPark) => this.parks.handleLimited(agentId, task, park));
    session.on('exit', (code: number) => {
      this.exitCodes.set(agentId, code);
      this.exited.add(agentId);
      if (this.parks.isLimited(agentId)) this.shedLimitedSession(agentId);
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
    const agent = this.store.agents.getAgent(agentId);
    if (!agent?.sessionId) return agent?.resumeAttempts ?? 0;
    if (!existsSync(agent.cwd)) return agent.resumeAttempts;
    if (agent.resumeAttempts >= limit) return agent.resumeAttempts;

    const attempts = this.store.agents.countAgentResumeAttempt(agentId);
    this.channels.disposeFileEvents(agentId);
    this.channels.releaseMcp(agentId);
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exited.delete(agentId);
    debugLog('agent', `auto-resume agent=${agentId} attempt=${attempts}/${limit}`);
    try {
      if (this.resume({ ...agent, resumeAttempts: attempts }, task)) return null;
    } catch (err) {
      this.store.transcripts.appendTranscript(agentId, `\nResume after crash failed: ${(err as Error).message}\n`);
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

  private failSpawn(agentId: string, taskId: string, err: Error): void {
    this.sessions.delete(agentId);
    this.store.transcripts.appendTranscript(agentId, err.message);
    this.store.transcripts.flushTranscript(agentId);
    this.store.agents.updateAgent(agentId, { status: 'failed', endedAt: new Date().toISOString(), pid: null });
    this.store.tasks.updateTask(taskId, { status: 'failed' });
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
    this.channels.drainFileEvents(agentId);
    this.parks.forget(agentId);
    this.store.transcripts.flushTranscript(agentId);
    this.store.agents.updateAgent(agentId, { status, endedAt: new Date().toISOString(), pid: null });
    this.store.tasks.updateTask(taskId, { status });
    this.sessions.delete(agentId);
    const exitCode = this.exitCodes.get(agentId);
    this.exitCodes.delete(agentId);
    if (status === 'failed') {
      this.opts.errors?.record({
        source: 'agent',
        message:
          `Agent ${agentId} failed (task ${taskId})` +
          `${exitCode !== undefined ? `, exit code ${exitCode}` : ''}${failureNote ? `, ${failureNote}` : ''}`,
        detail: isSealedRule(this.store.tasks.getTask(taskId)?.rule)
          ? null
          : recentOutputExcerpt(this.store.transcripts.getTranscript(agentId)) || null,
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
    this.channels.disposeFileEvents(agentId);
    this.channels.releaseMcp(agentId);
    this.emit('reaped', { agentId, taskId, status });
  }
  private shedLimitedSession(agentId: string): void {
    this.channels.disposeFileEvents(agentId);
    this.channels.releaseMcp(agentId);
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exited.delete(agentId);
    this.store.agents.updateAgent(agentId, { pid: null });
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
