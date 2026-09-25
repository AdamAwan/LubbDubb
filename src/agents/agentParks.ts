import type { AgentAsk, AgentStatus, StallPark, Task, Agent } from '../types.js';
import { isSealedRule } from '../mcp/names.js';
import type { AgentSession } from './session.js';
import { STALL_NUDGE, silenceReason, stallReason } from './agentProtocol.js';
import { HUMAN_BLOCK, renderBlocks } from './streamTranscript.js';
import type { RateLimitPark } from './streamJsonSession.js';
import { debugLog } from '../debug.js';
import { AgentChannels } from './agentChannels.js';
import { AgentVerdicts } from './agentVerdicts.js';

// → docs/spec/10-agent-runtimes.md

interface LimitPark {
  reason: string;
  resetsAt: string | null;
}

interface StallClock {
  at: number;
  grace: number;
}

const SEALED_WAITING =
  'This sealed agent stopped and is waiting. What it said is kept from every other reader — read its transcript in the cockpit.';

export class AgentParks extends AgentVerdicts {
  protected readonly sessions = new Map<string, AgentSession>();
  protected readonly exitCodes = new Map<string, number>();
  protected readonly exited = new Set<string>();
  protected readonly parked = new Set<string>();
  protected readonly limited = new Map<string, LimitPark>();
  protected readonly nudges = new Map<string, number>();
  protected readonly stalled = new Map<string, StallClock>();
  protected readonly channels = new AgentChannels(this.store, this.opts, this);

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

  protected noteSent(agentId: string, session: AgentSession, text: string): void {
    if (session.recordsSentMessages) return;
    const note = renderBlocks([{ type: HUMAN_BLOCK, text }], new Date().toISOString());
    if (!note) return;
    this.store.transcripts.appendTranscript(agentId, note);
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
    this.store.agents.setAgentResumed(agentId, null);
    this.store.agents.updateAgent(agentId, { status: 'running', waitingReason: null });
    return true;
  }

  ask(agentId: string, ask: AgentAsk): { ok: true; escalationId: string | null } | { ok: false; error: string } {
    if (!this.sessions.has(agentId)) return { ok: false, error: 'agent is no longer live' };
    return this.withCaller(agentId, ({ task }) => {
      const question = ask.question.trim();
      if (!question) return { ok: false, error: 'question must not be empty' };
      this.handleWaiting(agentId, task, question, ask);
      const open = this.store.escalations.listOpenEscalations().find((e) => e.agentId === agentId) ?? null;
      return { ok: true, escalationId: open?.id ?? null };
    });
  }

  protected restoreWaiting(agent: Agent, task: Task): void {
    const reason = agent.waitingReason ?? 'Resumed agent is awaiting your input.';
    this.parked.add(agent.id);
    this.store.agents.updateAgent(agent.id, { status: 'waiting', waitingReason: reason });
    this.store.tasks.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agent.id, task.id, 'waiting');
    const hasOpen = this.store.escalations.listOpenEscalations().some((e) => e.agentId === agent.id);
    if (!hasOpen) this.emit('waiting', { agentId: agent.id, taskId: task.id, reason });
  }

  protected handleStalled(session: AgentSession, agentId: string, task: Task, lastWords: string): void {
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
    this.handleWaiting(agentId, task, stallReason(isSealedRule(task.rule) ? '' : lastWords));
    this.armStallClock(agentId, this.opts.stallParkMs ?? 0, 'stall');
  }

  protected handleSilent(agentId: string, task: Task, silenceMs: number): void {
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

  protected handleWaiting(agentId: string, task: Task, said: string, asked?: AgentAsk): void {
    if (this.parked.has(agentId)) return;
    // A sealed agent's own words reach no other reader. → docs/spec/14-persistence.md#the-prediction-judge
    const sealed = isSealedRule(task.rule);
    const reason = sealed ? SEALED_WAITING : said;
    const ask = sealed ? undefined : asked;
    this.channels.drainFileEvents(agentId);
    const rule = this.opts.whitelistedApprovals.find((r) => reason.includes(r.match));
    if (rule) {
      this.respond(agentId, rule.response);
      this.emit('autoAnswered', { agentId, taskId: task.id, reason, response: rule.response });
      return;
    }
    this.parked.add(agentId);
    this.store.agents.setAgentResumed(agentId, null);
    this.store.agents.updateAgent(agentId, { status: 'waiting', waitingReason: reason });
    this.store.tasks.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('waiting', { agentId, taskId: task.id, reason, ask });
  }

  protected handleLimited(agentId: string, task: Task, park: RateLimitPark): void {
    if (this.limited.has(agentId)) return;
    const reason = rateLimitParkReason(park);
    this.channels.drainFileEvents(agentId);
    this.store.transcripts.flushTranscript(agentId);
    const asked = this.parked.has(agentId);
    this.limited.set(agentId, { reason, resetsAt: park.resetsAt });
    this.parked.add(agentId);
    this.stalled.delete(agentId);
    this.store.agents.setAgentResumed(agentId, null);
    this.store.agents.updateAgent(
      agentId,
      asked ? { status: 'waiting' } : { status: 'waiting', waitingReason: reason },
    );
    this.store.tasks.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
    this.emit('limited', { agentId, taskId: task.id, reason, resetsAt: park.resetsAt });
    if (this.exited.has(agentId)) this.shedLimitedSession(agentId);
  }

  protected shedLimitedSession(agentId: string): void {
    this.channels.disposeFileEvents(agentId);
    this.channels.releaseMcp(agentId);
    this.sessions.delete(agentId);
    this.exitCodes.delete(agentId);
    this.exited.delete(agentId);
    this.store.agents.updateAgent(agentId, { pid: null });
  }

  protected reinstateLimitPark(agentId: string, task: Task, park: LimitPark): void {
    this.limited.set(agentId, park);
    this.parked.add(agentId);
    this.store.agents.updateAgent(agentId, { status: 'waiting', waitingReason: park.reason });
    this.store.tasks.updateTask(task.id, { status: 'waiting' });
    this.reflectStatus(agentId, task.id, 'waiting');
  }

  protected noteResumed(agentId: string, taskId: string): void {
    if (!this.parked.has(agentId)) return;
    const clock = this.stalled.get(agentId);
    if (clock) clock.at = Math.max(clock.at, Date.now() + clock.grace);
    const resumedAt = new Date().toISOString();
    this.store.agents.setAgentResumed(agentId, resumedAt);
    this.emit('resumed', { agentId, taskId, resumedAt });
  }

  releasePark(agentId: string): void {
    this.parked.delete(agentId);
    this.stalled.delete(agentId);
    this.store.agents.setAgentResumed(agentId, null);
  }

  protected reflectStatus(agentId: string, taskId: string, status: AgentStatus): void {
    this.emit('status', { agentId, taskId, status });
  }
}

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
