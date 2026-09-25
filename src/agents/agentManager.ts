import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { recentOutputExcerpt } from '../escalation/context.js';
import type { Agent, AgentUsage, AccountRateLimits, ApiErrorReading, Task } from '../types.js';
import { extraMcpGrants, isSealedRule } from '../mcp/names.js';
import type { AgentToolTarget } from '../mcp/tools/context.js';
import type { ParsedFlag } from './sentinels.js';
import type { AgentSession } from './session.js';
import { liftNote, type LiftProfile } from './profileLift.js';
import type { RateLimitPark } from './streamJsonSession.js';
import { debugLog } from '../debug.js';
import { AgentParks } from './agentParks.js';
import type { TerminalBy } from './agentToolRecords.js';

// → docs/spec/10-agent-runtimes.md

export interface LimitResumeFailure {
  agentId: string;
  error: string;
}

export class AgentManager extends AgentParks implements AgentToolTarget {
  private readonly terminals = new Map<string, 'done' | 'failed' | 'killed'>();

  spawn(task: Task, cwd: string, resumeSessionId?: string | null): Agent {
    const inherited = this.opts.resumable ? (resumeSessionId ?? null) : null;
    const sessionId = inherited ?? (this.opts.resumable ? randomUUID() : null);
    const { session, eventsKey, mcp } = this.openSession(task, cwd, sessionId, inherited !== null);

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
    const { session, eventsKey, mcp } = this.openSession(task, agent.cwd, agent.sessionId, true);
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
      this.restoreWaiting(agent, task);
    } else {
      const carryOn = nudge ?? this.opts.resumeInput?.() ?? null;
      if (carryOn !== null) this.noteSent(agent.id, session, carryOn);
      this.deliverAfterBoot(agent.id, session, carryOn);
    }

    return true;
  }

  private openSession(
    task: Task,
    cwd: string,
    sessionId: string | null,
    resume: boolean,
  ): { session: AgentSession; eventsKey: string | null; mcp: { token: string; configPath: string | null } | null } {
    const eventsKey = this.opts.fileEvents ? randomUUID() : null;
    const extraServers = task.mcpServers ?? [];
    const mcp = this.opts.mcp?.open(extraServers) ?? null;
    const session = this.opts.createSession({
      command: this.opts.command,
      args: this.opts.buildArgs({
        sessionId: sessionId ?? '',
        extraAllowedTools: extraMcpGrants(extraServers),
        resume,
        mcpConfigPath: mcp?.configPath ?? null,
        model: task.model ?? null,
        effort: task.effort ?? null,
        permissionMode: task.permissionMode ?? null,
        sealed: isSealedRule(task.rule),
      }),
      cwd,
      env: {
        LUBBDUBB_PROMPT: task.prompt,
        LUBBDUBB_TASK_ID: task.id,
        ...this.channels.eventsDirEnv(eventsKey),
      },
      waitingPatterns: this.opts.waitingPatterns,
      sessionId,
      resume,
    });
    return { session, eventsKey, mcp };
  }

  fileEventsDir(agentId: string): string | null {
    return this.channels.fileEventsDir(agentId);
  }

  drainFileEvents(agentId: string): void {
    this.channels.drainFileEvents(agentId);
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
    this.channels.disposeFileEvents(agentId);
    this.channels.releaseMcp(agentId);
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.stalled.delete(agentId);
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
    return this.withCaller(agentId, ({ agent, task }) => {
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
      const successor = this.store.tasks.createTask({
        kind: task.kind,
        title: task.title,
        prompt: `${liftNote(task.profile ?? null, profile.name)}\n\n${task.prompt}`,
        branch: task.branch,
        originRef: task.originRef,
        originTitle: task.originTitle,
        originSummary: task.originSummary,
        dispatchReason: task.dispatchReason,
        rule: task.rule ?? null,
        ciChecks: task.ciChecks ?? null,
        mcpServers: task.mcpServers ?? null,
        model: profile.model,
        effort: profile.effort,
        permissionMode: profile.permissionMode ?? task.permissionMode ?? null,
        permissionAutoApprove: profile.autoApprove,
        profile: profile.name,
        profileSource: 'pin',
      });
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
      this.parked.delete(id);
      this.limited.delete(id);
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
      this.noteResumed(agentId, task.id);
    });

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
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.nudges.delete(agentId);
    this.stalled.delete(agentId);
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
}

const LIMIT_RESUME_MESSAGE =
  'This account hit its usage limit mid-turn, so the harness parked you. The limit has cleared and ' +
  'you have been resumed. Nothing else changed — the worktree and the conversation are the ones you ' +
  'left. Continue the task from where you stopped.';
