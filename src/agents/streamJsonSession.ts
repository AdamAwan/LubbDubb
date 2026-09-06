import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentSession, AgentSessionSpec, AgentSessionStatus } from './session.js';
import { DONE_SENTINEL, extractFlags, extractWaitingReason, stripSentinels } from './sentinels.js';
import { resolveExecutable } from './resolveCommand.js';
import type { ProcessReaper } from './processTree.js';
import { assistantText, renderBlocks, type ContentBlock } from './streamTranscript.js';
import type { AccountRateLimits, AgentUsage, RateLimitWindow } from '../types.js';
import { debugLog } from '../debug.js';

/**
 * Minimal child-process shape we depend on — injectable so tests drive a fake
 * process without launching claude.
 */
export interface StreamChild {
  readonly pid: number | undefined;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream;
  on(event: 'exit', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals | number): void;
}

export type Spawner = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => StreamChild;

const defaultSpawner: Spawner = (command, args, opts) => {
  // Resolve the command the same way the PTY backend does, so a missing `claude`
  // fails synchronously with a clear message instead of an unhandled async ENOENT.
  const resolved = resolveExecutable(command, opts.env);
  return nodeSpawn(resolved, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Head of its own process group, so {@link killProcessTree} has a group to signal
    // — the only way to reach a Bash-tool shell the agent left behind on POSIX.
    // Windows is excluded: `detached` there means "own console" and buys nothing.
    detached: process.platform !== 'win32',
  }) as unknown as StreamChild;
};

/**
 * Drives a real `claude` agent over the streaming-JSON protocol — the
 * production runtime. Each user message drives one assistant turn ending in a
 * `result`, whose assistant text is scanned for the harness sentinels: DONE
 * (finished), WAITING (needs a human), neither (`stalled`, see {@link stall}).
 * Only the turn leaving nothing queued is scanned that way — see
 * {@link StreamJsonSession.pendingTurns}. All three are read off a turn
 * *ending*, so an agent wedged **inside** a turn is caught by the wall clock
 * instead — see {@link StreamJsonSession.silenceMs}. An exhausted account ends
 * a turn with nothing the agent did wrong and emits `limited`; see
 * {@link RateLimitPark}. → `docs/spec/10-agent-runtimes.md`
 */
/**
 * Parse one stdout line as a stream-JSON event, tolerating junk glued to its
 * front — anything printing without a trailing newline lands in front of the
 * next event, and a dropped line is a turn end that never happened. Retried
 * from each `{`, taking the first that parses; returns null if none does.
 */
function parseEventLine(line: string): StreamEvent | null {
  for (let i = line.indexOf('{'); i !== -1; i = line.indexOf('{', i + 1)) {
    try {
      return JSON.parse(line.slice(i)) as StreamEvent;
    } catch {
      // This `{` opened something that is not the event; try the next one.
    }
  }
  return null;
}

export class StreamJsonSession extends EventEmitter implements AgentSession {
  private child: StreamChild | null = null;
  private _status: AgentSessionStatus = 'starting';
  private stdoutBuf = '';
  /** Assistant text accumulated within the current turn, for sentinel scanning. */
  private turnText = '';
  /** Messages written to stdin not yet ended in a `result`. A `result` ends *a* turn, not the session; judging an interrupted turn would park an agent about to keep working. */
  private pendingTurns = 0;
  /** The exhaustion the last `rate_limit_event` reported, or null while the account is inside its limits. Held rather than acted on at once, to avoid racing the `result` carrying the turn's usage. */
  private limit: RateLimitPark | null = null;
  /** Whether the limit park has already been announced, so exit doesn't repeat it. */
  private limitParked = false;
  /** The pending silence watchdog (see {@link silenceMs}), or null while not armed — every moment the session is not `running`. */
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly spawn: Spawner = defaultSpawner,
    /** How a kill reaches the agent's *descendants* (see {@link ProcessReaper}). Defaults to no-op, not {@link killProcessTree}, since an injected fake child's pid names an unrelated host process. */
    private readonly reap: ProcessReaper = () => {},
    /** `agentSilenceParkMs` — how long the process may produce nothing at all before the runtime says so, ms. 0 disables it. Any byte on stdout re-arms it. */
    private readonly silenceMs: number = 0,
  ) {
    super();
  }

  get status(): AgentSessionStatus {
    return this._status;
  }
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.child) throw new Error('StreamJsonSession already started');
    this.child = this.spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
    });
    this.setStatus('running');
    this.child.stdout.on('data', (d: Buffer | string) => this.onStdout(d.toString()));
    this.child.on('exit', (code) => this.onExit(code));
  }

  /** Send a user message (initial task or a human answer) as one JSON line. */
  send(text: string): void {
    if (!this.child) throw new Error('StreamJsonSession not started');
    const msg = { type: 'user', message: { role: 'user', content: text } };
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    this.pendingTurns += 1;
    // Deliberately *not* clearing `turnText`: every `result` clears it, and clearing
    // here would erase a sentinel already printed in the turn this lands mid-way
    // through. A done printed before a nudge arrived is still a done.
    if (this._status === 'waiting') this.setStatus('running');
    // Explicitly: a message into an agent that never stopped being `running` is still
    // a fresh start for the clock, and `setStatus` short-circuits on no change.
    this.armSilence();
  }

  /**
   * No-op: the stream-JSON protocol carries structured user messages, not a raw
   * TTY, so control chars like \x03 aren't meaningful over this transport. Kept
   * to satisfy the {@link AgentSession} contract.
   */
  sendRaw(_data: string): void {
    /* intentionally empty — no raw byte channel on the JSON transport */
  }

  /**
   * Stop the agent — **and everything it started**: a Bash-tool shell left
   * running holds the worktree cwd open and wedges the branch. The reap goes
   * **before** `child.kill`, since it resolves descendants through a root pid
   * a dead root no longer has. → `docs/spec/10-agent-runtimes.md#reaping-the-process-subtree`
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    // First, and outside the guard below: a watchdog left armed by a kill that found
    // nothing to signal outlives the session and parks an agent nobody is running.
    this.clearSilence();
    if (this.child && ['starting', 'running', 'waiting'].includes(this._status)) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      const pid = this.child.pid;
      if (pid !== undefined) this.reap(pid);
      this.child.kill(signal);
      this.setStatus('killed');
    }
  }

  // -- internals -----------------------------------------------------------

  private onStdout(chunk: string): void {
    // Liveness is bytes, not events: an unparseable line is still the process saying
    // something, and reading only known events would make an unknown one a park.
    this.armSilence();
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim()) this.handleEvent(line);
    }
  }

  private handleEvent(line: string): void {
    const ev = parseEventLine(line);
    if (!ev) {
      // Genuinely unreadable, as opposed to an event wearing a prefix — banners and
      // stderr bleed, which cannot be recovered into events.
      debugLog('agent', `unparseable stream line (${line.length} bytes)`);
      return;
    }

    if (ev.type === 'assistant') {
      const blocks = contentBlocks(ev);
      // Detection scans the raw assistant text (sentinels intact); display strips them.
      const raw = assistantText(blocks);
      this.turnText += raw;
      // Flags carry no status meaning, so surface them as they land rather than at
      // turn end. A flag always arrives whole in one text block on this transport.
      for (const flag of extractFlags(raw)) this.emit('flag', flag);
      // A tool call is the agent doing rather than saying — the one signal telling
      // "carried on working" from "wrote a closing sentence and stopped".
      if (blocks.some((b) => b.type === 'tool_use')) this.emit('activity');
      // Stamped when the event lands, which on this transport is when it happened:
      // the protocol carries no time and nothing here is replayed.
      const display = renderBlocks(blocks, new Date().toISOString());
      if (display) this.emit('output', display);
      return;
    }

    if (ev.type === 'user') {
      // Incoming user events on stdout are tool results the CLI produced. Render
      // only those blocks — plain-text user content is our own echoed input.
      const results = contentBlocks(ev).filter((b) => b.type === 'tool_result');
      const display = renderBlocks(results, new Date().toISOString());
      if (display) this.emit('output', display);
      return;
    }

    if (ev.type === 'rate_limit_event') {
      // Two reads of one event, and the order says which may act: the windows are
      // observation only, surfaced first so no park is ever downstream of them.
      const reading = rateLimitReading(ev.rate_limit_info, new Date().toISOString());
      if (reading) this.emit('limits', reading);
      // Latest reading wins, including one saying the limit cleared: a window can
      // reset mid-run, and a stale rejection would park an agent allowed to work.
      this.limit = rateLimitPark(ev.rate_limit_info);
      return;
    }

    if (ev.type === 'result') {
      // Usage rides on the turn-end event; surfaced before the status transition so
      // listeners persist it ahead of the waiting/done fan-out.
      const usage = resultUsage(ev);
      if (usage) this.emit('usage', usage);
      const turnText = this.turnText;
      this.turnText = '';
      if (this.pendingTurns > 0) this.pendingTurns -= 1;
      // Done is decided *above* the queued-turn check, and is the only sentinel that
      // is: a queued message makes a question moot but cannot make "I finished"
      // untrue, and a done lost to that race leaves a session holding a worktree.
      if (turnText.includes(DONE_SENTINEL)) {
        this.finish('done');
        return;
      }
      // Only the turn leaving nothing queued is the session coming to rest; reading
      // otherwise parks an agent still working (see {@link pendingTurns}).
      if (this.pendingTurns > 0) return;
      // End of a turn: decide waiting vs an unannounced stop from what it printed.
      if (this.limit) {
        // After the done sentinel deliberately: an agent that finished and *then* hit
        // the limit is finished, and parking it would resurrect a settled ending.
        this.parkOnLimit();
      } else {
        const reason = extractWaitingReason(turnText);
        if (reason !== null) this.setWaiting(reason);
        else this.stall(turnText);
      }
    }
  }

  /**
   * A turn that ended with **no** sentinel: the agent went quiet rather than
   * asking for a human, so this is its own event, not `waiting`. What to do —
   * nudge or park — is {@link AgentManager}'s. Status still moves to `waiting`;
   * `send` puts it back to `running`.
   */
  private stall(turnText: string): void {
    if (this._status === 'waiting' || this._status === 'done') return;
    this.setStatus('waiting');
    this.emit('stalled', stripSentinels(turnText).trim());
  }

  private setWaiting(reason: string): void {
    if (this._status === 'waiting' || this._status === 'done') return;
    this.setStatus('waiting');
    this.emit('waiting', reason);
  }

  /**
   * Announce that the account, not the agent, is what stopped. At most once per
   * session: the exhaustion usually ends the turn *and* kills the process.
   */
  private parkOnLimit(): void {
    if (this.limitParked || this._status === 'done' || this._status === 'killed') return;
    this.limitParked = true;
    // Straight to `waiting`, not through {@link setWaiting}, whose event is the
    // harness's "ask a human" transition. This park has no question in it.
    this.setStatus('waiting');
    this.emit('limited', this.limit);
  }

  private onExit(code: number | null): void {
    this.emit('exit', code ?? 0);
    if (this._status === 'killed' || this._status === 'done') return;
    // An exhausted account is why `claude` exits non-zero here; calling that a failure
    // would settle the agent row over something nobody did wrong.
    if (this.limit) {
      this.parkOnLimit();
      return;
    }
    this.finish(code === 0 ? 'done' : 'failed');
  }

  private finish(status: 'done' | 'failed'): void {
    if (this._status === 'done' || this._status === 'failed') return;
    this.setStatus(status);
    this.emit(status);
    try {
      this.child?.stdin.end();
    } catch {
      /* ignore */
    }
  }

  private setStatus(status: AgentSessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
    // The one place every transition passes through, which keeps the watchdog off
    // every legitimately silent status — an agent parked on a person may wait all
    // night, and a clock on that park is what this must never become.
    this.armSilence();
  }

  /** Start the silence window over, or leave it stopped if not running. Idempotent; called on every sign of life. */
  private armSilence(): void {
    this.clearSilence();
    if (this.silenceMs <= 0 || this._status !== 'running') return;
    this.silenceTimer = setTimeout(() => {
      // Dropped before the announcement: nothing re-arms until the agent or the
      // harness says something, or the same wedge would be announced on a loop.
      this.silenceTimer = null;
      this.emit('silent', this.silenceMs);
    }, this.silenceMs);
    // A live agent holds the process open through its child, not through a timer of
    // ours: unref'd, so a shutdown that reaped the child does not wait out the window.
    this.silenceTimer.unref?.();
  }

  private clearSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }
}

/**
 * What `claude` says about the account's usage limits on `rate_limit_event`.
 * Every field but `status` is optional, so a park must survive a payload
 * naming no window and no reset. Kept as `string`, not a narrower union, so a
 * value the CLI adds tomorrow doesn't read as "not exhausted".
 */
interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
  /** Every window's *current* utilisation, keyed by `rateLimitType`'s names. Absent on an older `claude` — the cockpit then degrades to its rolling cost window. `utilization` is a fraction, not a percentage. */
  unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown } | undefined>;
}

/** An account limit that is spent, as the harness carries it. */
export interface RateLimitPark {
  /** Which window ran out (`five_hour`, `seven_day`…) verbatim, or null when unstated. */
  limitType: string | null;
  /** When it resets, ISO, or null when `claude` did not say. */
  resetsAt: string | null;
  /** Whether it was the account's *overage* allowance that ran out rather than the plan window. */
  overage: boolean;
}

/**
 * Read an exhaustion off a `rate_limit_event`, or null while there is room
 * left. `rejected` is the only spelling of "spent" — `allowed_warning` must
 * **not** park an agent that can still work. The overage arm is separate: an
 * account on overage credit reports `status: "allowed"` with the exhaustion in
 * `overageStatus`.
 */
function rateLimitPark(info: RateLimitInfo | undefined): RateLimitPark | null {
  if (!info) return null;
  const overage = info.isUsingOverage === true && info.overageStatus === 'rejected';
  if (info.status !== 'rejected' && !overage) return null;
  return {
    limitType: info.rateLimitType ?? null,
    // Whole seconds since the epoch, per the CLI's schema.
    resetsAt: typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : null,
    overage,
  };
}

/**
 * Read the account's usage windows off a `rate_limit_event`, or null when it names
 * none. **Must stay separate from {@link rateLimitPark}**: this fires on every
 * ordinary turn, and folded together it would be one edit from parking the fleet on
 * a reading that says there is room.
 * → `docs/spec/10-agent-runtimes.md#the-account-usage-windows`
 */
function rateLimitReading(info: RateLimitInfo | undefined, capturedAt: string): AccountRateLimits | null {
  const windows = info?.unifiedWindows;
  if (!windows || typeof windows !== 'object') return null;
  const fiveHour = readWindow(windows.five_hour);
  const sevenDay = readWindow(windows.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, capturedAt };
}

/** One window, or null when the CLI carried no usable utilisation for it. */
function readWindow(w: { utilization?: unknown; resetsAt?: unknown } | undefined): RateLimitWindow | null {
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  return {
    // A fraction on the wire, a percentage everywhere above it.
    usedPercentage: w.utilization * 100,
    // Whole seconds since the epoch, as everywhere else in this payload.
    resetsAt:
      typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : null,
  };
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { content?: ContentBlock[] | string };
  /** Present on `rate_limit_event` only. */
  rate_limit_info?: RateLimitInfo;
  // `result`-event usage metadata, all cumulative across the session.
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Pull the cumulative usage off a `result` event, or null when it carries none. */
function resultUsage(ev: StreamEvent): AgentUsage | null {
  const u = ev.usage;
  if (ev.total_cost_usd === undefined && ev.num_turns === undefined && u === undefined) return null;
  return {
    costUsd: ev.total_cost_usd ?? null,
    // Cache tokens count as input: bare `input_tokens` under-reports badly with
    // caching on. The two cached components stay apart below because they are priced
    // differently, so the gross figure alone cannot say whether caching works.
    inputTokens: u
      ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      : null,
    outputTokens: u?.output_tokens ?? null,
    cacheReadTokens: u ? (u.cache_read_input_tokens ?? 0) : null,
    cacheCreationTokens: u ? (u.cache_creation_input_tokens ?? 0) : null,
    numTurns: ev.num_turns ?? null,
  };
}

/** Normalise a message's `content` into a block array (a bare string becomes one text block). */
function contentBlocks(ev: StreamEvent): ContentBlock[] {
  const content = ev.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}
