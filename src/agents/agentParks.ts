import type { AgentAsk, StallPark, Task, Agent } from '../types.js';
import type { Store } from '../store/store.js';
import { isSealedRule } from '../mcp/names.js';
import type { AgentSession } from './session.js';
import { STALL_NUDGE, silenceReason, stallReason } from './agentProtocol.js';
import type { RateLimitPark } from './streamJsonSession.js';
import { debugLog } from '../debug.js';
import type { AgentChannels } from './agentChannels.js';
import type { AgentEmitter, AgentManagerOptions } from './agentContract.js';

// → docs/spec/10-agent-runtimes.md

interface LimitPark {
  reason: string;
  resetsAt: string | null;
}

interface StallClock {
  at: number;
  grace: number;
}

interface ParkHost {
  hasExited(agentId: string): boolean;
  noteSent(agentId: string, session: AgentSession, text: string): void;
  respond(agentId: string, text: string): boolean;
  shedSession(agentId: string): void;
}

const SEALED_WAITING =
  'This sealed agent stopped and is waiting. What it said is kept from every other reader — read its transcript in the cockpit.';

export class AgentParks {
  private readonly parked = new Set<string>();
  private readonly limited = new Map<string, LimitPark>();
  private readonly nudges = new Map<string, number>();
  private readonly stalled = new Map<string, StallClock>();

  constructor(
    private readonly store: Store,
    private readonly opts: AgentManagerOptions,
    private readonly events: AgentEmitter,
    private readonly channels: Pick<AgentChannels, 'drainFileEvents'>,
    private readonly host: ParkHost,
  ) {}

  isParked(agentId: string): boolean {
    return this.parked.has(agentId);
  }

  isLimited(agentId: string): boolean {
    return this.limited.has(agentId);
  }

  limitPark(agentId: string): LimitPark | undefined {
    return this.limited.get(agentId);
  }

  clear(agentId: string): void {
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.stalled.delete(agentId);
  }

  unpark(agentId: string): void {
    this.parked.delete(agentId);
    this.limited.delete(agentId);
  }

  forget(agentId: string): void {
    this.parked.delete(agentId);
    this.limited.delete(agentId);
    this.nudges.delete(agentId);
    this.stalled.delete(agentId);
  }

  limitedAgentIds(): string[] {
    return [...this.limited.keys()];
  }

  expireLimitParks(resume: (agentId: string) => void): void {
    const now = Date.now();
    for (const [agentId, park] of [...this.limited]) {
      if (!park.resetsAt) continue;
      const resetsAt = Date.parse(park.resetsAt);
      if (!Number.isFinite(resetsAt) || resetsAt > now) continue;
      debugLog('agent', `limit park expired agent=${agentId} resetsAt=${park.resetsAt}`);
      resume(agentId);
    }
  }

  completeExpiredStalls(complete: (agentId: string) => boolean): string[] {
    const now = Date.now();
    const settled: string[] = [];
    for (const [agentId, clock] of [...this.stalled]) {
      if (clock.at > now) continue;
      if (this.limited.has(agentId)) {
        this.stalled.delete(agentId);
        continue;
      }
      debugLog('agent', `stall park expired agent=${agentId}`);
      if (complete(agentId)) settled.push(agentId);
      else this.stalled.delete(agentId);
    }
    return settled;
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

  restoreWaiting(agent: Agent, task: Task): void {
    const reason = agent.waitingReason ?? 'Resumed agent is awaiting your input.';
    this.parked.add(agent.id);
    this.store.agents.updateAgent(agent.id, { status: 'waiting', waitingReason: reason });
    this.store.tasks.updateTask(task.id, { status: 'waiting' });
    this.reflectWaiting(agent.id, task.id);
    const hasOpen = this.store.escalations.listOpenEscalations().some((e) => e.agentId === agent.id);
    if (!hasOpen) this.events.emit('waiting', { agentId: agent.id, taskId: task.id, reason });
  }

  handleStalled(session: AgentSession, agentId: string, task: Task, lastWords: string): void {
    if (this.parked.has(agentId)) return;
    const budget = this.opts.stallNudges ?? 0;
    const spent = this.nudges.get(agentId) ?? 0;
    if (spent < budget && !this.host.hasExited(agentId)) {
      this.nudges.set(agentId, spent + 1);
      this.host.noteSent(agentId, session, STALL_NUDGE);
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

  handleSilent(agentId: string, task: Task, silenceMs: number): void {
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

  handleWaiting(agentId: string, task: Task, said: string, asked?: AgentAsk): void {
    if (this.parked.has(agentId)) return;
    // A sealed agent's own words reach no other reader. → docs/spec/14-persistence.md#the-prediction-judge
    const sealed = isSealedRule(task.rule);
    const reason = sealed ? SEALED_WAITING : said;
    const ask = sealed ? undefined : asked;
    this.channels.drainFileEvents(agentId);
    const rule = this.opts.whitelistedApprovals.find((r) => reason.includes(r.match));
    if (rule) {
      this.host.respond(agentId, rule.response);
      this.events.emit('autoAnswered', { agentId, taskId: task.id, reason, response: rule.response });
      return;
    }
    this.parked.add(agentId);
    this.store.agents.setAgentResumed(agentId, null);
    this.store.agents.updateAgent(agentId, { status: 'waiting', waitingReason: reason });
    this.store.tasks.updateTask(task.id, { status: 'waiting' });
    this.reflectWaiting(agentId, task.id);
    this.events.emit('waiting', { agentId, taskId: task.id, reason, ask });
  }

  handleLimited(agentId: string, task: Task, park: RateLimitPark): void {
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
    this.reflectWaiting(agentId, task.id);
    this.events.emit('limited', { agentId, taskId: task.id, reason, resetsAt: park.resetsAt });
    if (this.host.hasExited(agentId)) this.host.shedSession(agentId);
  }

  reinstateLimitPark(agentId: string, task: Task, park: LimitPark): void {
    this.limited.set(agentId, park);
    this.parked.add(agentId);
    this.store.agents.updateAgent(agentId, { status: 'waiting', waitingReason: park.reason });
    this.store.tasks.updateTask(task.id, { status: 'waiting' });
    this.reflectWaiting(agentId, task.id);
  }

  noteResumed(agentId: string, taskId: string): void {
    if (!this.parked.has(agentId)) return;
    const clock = this.stalled.get(agentId);
    if (clock) clock.at = Math.max(clock.at, Date.now() + clock.grace);
    const resumedAt = new Date().toISOString();
    this.store.agents.setAgentResumed(agentId, resumedAt);
    this.events.emit('resumed', { agentId, taskId, resumedAt });
  }

  releasePark(agentId: string): void {
    this.parked.delete(agentId);
    this.stalled.delete(agentId);
    this.store.agents.setAgentResumed(agentId, null);
  }

  private reflectWaiting(agentId: string, taskId: string): void {
    this.events.emit('status', { agentId, taskId, status: 'waiting' });
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
