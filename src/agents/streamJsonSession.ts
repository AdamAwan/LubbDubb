import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentSession, AgentSessionSpec, AgentSessionStatus } from './session.js';
import { DONE_SENTINEL, extractFlags, extractWaitingReason, stripSentinels } from './sentinels.js';
import { resolveExecutable } from './resolveCommand.js';
import type { ProcessReaper } from './processTree.js';
import { assistantText, renderBlocks, type ContentBlock } from './streamTranscript.js';
import type { AgentUsage } from '../types.js';
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
    // Head of its own process group, so {@link killProcessTree} has a group to
    // signal — the only way to reach a Bash-tool shell the agent left behind on
    // POSIX. Windows is excluded deliberately: `detached` there means "own
    // console", which buys nothing (the reap is `taskkill /T`) and would give a
    // piped child a console it never uses.
    detached: process.platform !== 'win32',
  }) as unknown as StreamChild;
};

/**
 * Drives a real `claude` agent over the streaming-JSON protocol
 * (`-p --input-format stream-json --output-format stream-json`). This is the
 * production agent runtime: it never renders the interactive TUI, works
 * unattended, and supports the harness's waiting/answer loop because the session
 * stays alive across turns as long as stdin is open.
 *
 * Turn semantics: each user message drives one assistant turn ending in a
 * `result` event. We scan assistant text for the harness sentinels:
 *   - DONE seen                 -> the agent finished the whole task
 *   - WAITING seen              -> it needs a human; escalate, then send the answer
 *   - turn ended with neither   -> `stalled`: it stopped without saying why, which is a
 *                                  nudge before it is ever a question (see {@link stall})
 *
 * Only the turn that leaves nothing queued behind it is scanned that way — see
 * {@link StreamJsonSession.pendingTurns}.
 *
 * All three of those are read off a turn *ending*, which is why there is a fourth
 * that is not: an agent wedged inside a turn ends none, and would otherwise hold
 * its slot for as long as the harness ran. `silent` is the wall clock saying so —
 * see {@link StreamJsonSession.silenceMs}.
 *
 * One turn ending is not a sentinel question at all: an account whose usage limit
 * is exhausted. That ends the turn — and usually the process — with nothing the
 * agent did wrong, so it emits `limited` rather than `waiting` or `failed`; see
 * {@link RateLimitPark}.
 */
/**
 * Parse one stdout line as a stream-JSON event, tolerating junk glued to its front.
 *
 * A plain `JSON.parse` per line assumes `claude` is the only writer on that pipe, and
 * it is not: **anything that writes to stdout without a trailing newline lands on the
 * front of the next event.** A `Stop` hook returning a `terminalSequence` is the case
 * that cost us one — the OSC title escape it emits carries no newline, so the
 * `result` closing the turn arrived as `\x1b]2;…\x07{"type":"result"…}` and threw.
 *
 * The old `catch { return }` then made that a **turn end that never happened**: no
 * done, no waiting, not even the unannounced stop, because all three are decided on
 * `result`. An agent that had printed `@@LUBBDUBB_DONE@@` and finished simply went
 * quiet — its session still live, still holding its worktree lease, still accepting
 * messages — and looked identical to one still working. Nothing was red, and the only
 * way to notice was to ask the agent, which could only report what it had printed.
 *
 * So a line is retried from each `{` in it, taking the first that parses: the junk is
 * always a prefix and the event always an object, so the event is always a suffix.
 * Recovery cannot invent an event — a line with no parseable object still returns
 * null — and the escape flavour never has to be enumerated, which is the point: the
 * next writer to do this will not be a hook.
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
  /**
   * Messages written to stdin that have not yet ended in a `result`.
   *
   * A `result` is the end of *a* turn, not of the session, and the two differ
   * whenever a message is sent while a turn is still in flight — which the
   * `escalate` tool makes routine, since it parks the agent mid-turn and returns
   * at once, so the human's answer (or a whitelist rule's) can land before the
   * turn it interrupted has ended. `claude` queues that message and runs it next,
   * so judging the interrupted turn's `result` would park an agent that is about
   * to keep working, on a question nobody asked.
   */
  private pendingTurns = 0;
  /**
   * The exhaustion the last `rate_limit_event` reported, or null while the account
   * is inside its limits. Held rather than acted on immediately because the event
   * rides *beside* the turn: `claude` emits it as the limit changes and then ends
   * the turn (or dies) of its own accord, and a park declared before the turn ended
   * would race the `result` that carries the turn's usage.
   */
  private limit: RateLimitPark | null = null;
  /** Whether the limit park has already been announced, so exit doesn't repeat it. */
  private limitParked = false;
  /**
   * The pending silence watchdog (see {@link silenceMs}), or null while it is not
   * armed — which is every moment the session is not `running`.
   */
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spec: AgentSessionSpec,
    private readonly spawn: Spawner = defaultSpawner,
    /**
     * How a kill reaches the agent's *descendants* (see {@link ProcessReaper}).
     *
     * Defaults to doing nothing rather than to {@link killProcessTree}, and that
     * pairing is deliberate: the default `spawn` and the default reap must match,
     * and a session built with an injected {@link Spawner} has a fake child whose
     * pid names some unrelated process on the host. The composition root wires the
     * real reaper alongside the real spawner; nothing else constructs this.
     */
    private readonly reap: ProcessReaper = () => {},
    /**
     * `agentSilenceParkMs` — how long the process may produce **nothing at all**
     * before the runtime says so, in milliseconds. 0 disables it.
     *
     * The turn boundary this runtime reads its endings off is not a liveness check:
     * an agent wedged *inside* a turn — a tool call that never returns, a command
     * waiting on input nobody will type — emits no `result`, so it emits no
     * `stalled` either and holds its slot and its worktree until somebody notices.
     * That silence is the only observable such an agent has, and this is how long it
     * has to last before it becomes one.
     *
     * Any byte on stdout re-arms it, so the window is the longest a *legitimate*
     * step may take without a word — a full install or test run, not a repaint —
     * which is why it is measured in tens of minutes where the PTY runtime's
     * `agentIdleWaitMs` is measured in seconds. A screen that repaints every second
     * and a protocol that says nothing during a tool call are different silences.
     */
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
    // Deliberately *not* clearing `turnText`. Every `result` clears it, so it never
    // spans two turns anyway — and the only thing clearing it here ever did was
    // erase a sentinel the agent had already printed in the turn this message is
    // landing in the middle of. A done printed before an answer, a nudge or an
    // operator's aside arrived is still a done; see the `result` handler.
    if (this._status === 'waiting') this.setStatus('running');
    // Explicitly, rather than leaving it to the transition above: a message typed
    // into an agent that never stopped being `running` is still a fresh start for
    // the clock, and `setStatus` short-circuits when the status does not change.
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
   * Stop the agent — **and everything it started**. A Bash-tool shell the agent
   * left running holds the worktree cwd open long after `claude` is gone, which on
   * Windows wedges the branch for good; see {@link ProcessReaper}.
   *
   * The reap goes **before** `child.kill`, because it resolves descendants through
   * the root pid and a dead root has none to find. It cannot throw, so nothing
   * below it is skipped.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    // First, and outside the guard below, because it is the one thing here that is
    // ours rather than the process's: a watchdog left armed by a kill that found
    // nothing to signal — or that threw on the way to the status change — outlives
    // the session and parks an agent nobody is running any more.
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
    // Liveness is bytes, not events: a line we cannot parse is still the process
    // saying something, and reading only the events we understand would make an
    // unrecognised event a reason to park.
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
      // Genuinely unreadable, as opposed to an event wearing a prefix. Logged rather
      // than counted: the population is banners and stderr bleed, and a line that is
      // not an event cannot be recovered into one.
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
      // A tool call is the agent doing something, as opposed to saying something —
      // the one signal that distinguishes "carried on with the work" from "wrote a
      // closing sentence and stopped". See `activity` in AgentSession.
      if (blocks.some((b) => b.type === 'tool_use')) this.emit('activity');
      // Stamped at the moment the event lands, which on this transport is the moment
      // it happened: the protocol carries no time of its own, and stream events are
      // read live rather than replayed. (The PTY runtime, which *does* replay, dates
      // each block from the session file instead.)
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
      // Latest reading wins, including the one that says the limit cleared: a
      // five-hour window can reset mid-run, and a stale rejection would then park
      // an agent that is allowed to work.
      this.limit = rateLimitPark(ev.rate_limit_info);
      return;
    }

    if (ev.type === 'result') {
      // Surface the usage metadata riding on the turn-end event (cumulative
      // cost/tokens/turns) before the status transition, so listeners persist
      // it ahead of the waiting/done fan-out.
      const usage = resultUsage(ev);
      if (usage) this.emit('usage', usage);
      const turnText = this.turnText;
      this.turnText = '';
      if (this.pendingTurns > 0) this.pendingTurns -= 1;
      // Done is decided *above* the queued-turn check, and it is the only sentinel
      // that is. A queued message makes a question moot — it is usually the answer —
      // but nothing anyone types makes "I finished" untrue, so a done read only when
      // the queue happened to be empty is a done lost to a race: the agent announced
      // it, the harness heard nothing, and the session it should have torn down sat
      // holding a worktree, indistinguishable from one that stopped without saying
      // why. Both `finish` and the transitions below are idempotent.
      if (turnText.includes(DONE_SENTINEL)) {
        this.finish('done');
        return;
      }
      // Only the turn that leaves nothing queued is the session coming to rest; a
      // message sent into the turn this ends is one `claude` runs next, and reading
      // this as an unannounced stop is a park on an agent still working (see
      // {@link pendingTurns}). Judged on the text of the turn that ended, so a
      // sentinel is never carried into the queued one.
      if (this.pendingTurns > 0) return;
      // End of a turn: decide waiting vs an unannounced stop from what it printed.
      if (this.limit) {
        // Ordered after the done sentinel deliberately: an agent that finished the
        // work and *then* hit the limit is finished, and parking it would resurrect
        // a settled ending.
        this.parkOnLimit();
      } else {
        const reason = extractWaitingReason(turnText);
        if (reason !== null) this.setWaiting(reason);
        else this.stall(turnText);
      }
    }
  }

  /**
   * A turn that ended with **no** sentinel in it: the agent stopped without saying
   * whether it finished, what it needs, or nothing at all.
   *
   * Announced on its own event rather than as `waiting`, because they are not the
   * same claim and only one of them is a question. `waiting` means an agent asked
   * for a human; this means an agent went quiet, which is usually a forgotten
   * sentinel or a wait on a build or a CI run that nothing was ever going to wake
   * it from. What to do about it — nudge it, or park it for a human once the
   * nudges are spent — is {@link AgentManager}'s to decide, and the runtime's job
   * is only to report which of the two happened.
   *
   * The status still moves to `waiting`, because the session really has stopped:
   * `send` — the nudge, or a human's answer — is what puts it back to `running`,
   * and its own first line is what keeps an agent already parked on a question
   * from being read as stopping over and over.
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
   * Announce that the account, not the agent, is what stopped. Emitted at most once
   * per session: the exhaustion typically ends the turn *and* kills the process, and
   * the two must not read as two events.
   */
  private parkOnLimit(): void {
    if (this.limitParked || this._status === 'done' || this._status === 'killed') return;
    this.limitParked = true;
    // Straight to `waiting` rather than through {@link setWaiting}, whose `waiting`
    // event is the harness's "ask a human a question" transition. This is a park with
    // no question in it.
    this.setStatus('waiting');
    this.emit('limited', this.limit);
  }

  private onExit(code: number | null): void {
    this.emit('exit', code ?? 0);
    if (this._status === 'killed' || this._status === 'done') return;
    // An exhausted account is why `claude` exits non-zero here, and calling that a
    // failure settles the agent row and its task over something no one did wrong.
    // The park stands instead, and the operator resumes it once the limit clears.
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
    // The one place every transition passes through, which is what keeps the
    // watchdog off every status that is *legitimately* silent: a session parked on
    // a question, on a spent limit, or ended. An agent waiting on a person may wait
    // all night, and a clock on that park is the thing this must never become.
    this.armSilence();
  }

  /**
   * Start the silence window over, or leave it stopped if the session is not
   * running. Idempotent, and called on every sign of life — a byte on stdout, a
   * message written in, a transition back to `running`.
   */
  private armSilence(): void {
    this.clearSilence();
    if (this.silenceMs <= 0 || this._status !== 'running') return;
    this.silenceTimer = setTimeout(() => {
      // Dropped before the announcement, not after: `silent` is a statement that the
      // window passed, and nothing re-arms until the agent or the harness says
      // something. Re-arming here instead would announce the same wedge on a loop.
      this.silenceTimer = null;
      this.emit('silent', this.silenceMs);
    }, this.silenceMs);
    // The status quo is that a live agent holds the process open through its child,
    // not through a timer of ours — an unref'd timer keeps a shutdown that has
    // already reaped the child from waiting out the window.
    this.silenceTimer.unref?.();
  }

  private clearSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }
}

/**
 * What `claude` says about the account's usage limits, as it ships it on the
 * `rate_limit_event` stream event.
 *
 * Declared from the CLI's own payload schema (`claude` 2.1.223, the binary this
 * deployment launches), not from a guess: `status` and `overageStatus` are the
 * enum `["allowed","allowed_warning","rejected"]`, `resetsAt` is whole unix
 * seconds, and `rateLimitType` is one of `five_hour`, `seven_day`,
 * `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`.
 * Every field but `status` is optional there, so every field is optional here —
 * a park must survive a payload that names no window and no reset.
 *
 * Kept as `string` rather than re-declared unions: this is someone else's wire
 * format and a narrower type here would turn a value the CLI adds tomorrow into
 * a parse that quietly reads as "not exhausted".
 */
interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
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
 * Read an exhaustion off a `rate_limit_event`, or null while there is room left.
 *
 * `rejected` is the only spelling of "spent" in the CLI's enum — `allowed_warning`
 * is the near-the-line warning and must **not** park an agent that can still work.
 * The overage arm is separate because an account running on overage credit reports
 * `status: "allowed"` with the exhaustion in `overageStatus`, so reading `status`
 * alone would miss the one that actually stops the turn.
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
    // Cache tokens count as input: with caching on, bare input_tokens is a tiny
    // residue and would wildly under-report what the turn actually consumed. The
    // two cached components are also kept *apart* below, because summing them is
    // lossy in the one direction that matters — a read costs a tenth of a fresh
    // token and a write costs more than one, so the gross figure alone cannot
    // say whether the fleet's caches are working.
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
