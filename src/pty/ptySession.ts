import { EventEmitter } from 'node:events';
import type { PtyBackend, PtyProcess } from './backend.js';
import { TerminalTranscript } from './terminalTranscript.js';
import { FLAG_PREFIX, FLAG_SUFFIX, parseFlag } from '../agents/sentinels.js';
import { stripAnsi } from '../agents/streamTranscript.js';
import { excise, holdFrom, scanSentinels, type SentinelSpec } from './sentinelScanner.js';

export type PtySessionStatus = 'starting' | 'running' | 'waiting' | 'done' | 'killed' | 'failed';

export interface PtySessionOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /**
   * Sentinel an agent prints to signal completion. Kept as an explicit protocol
   * rather than guessing from output, because "the process is idle" and "the
   * process is finished" are genuinely ambiguous over a PTY.
   */
  doneSentinel?: string;
  /** Sentinel of the form `PREFIX<reason>SUFFIX` an agent prints when it needs input. */
  waitingSentinelPrefix?: string;
  waitingSentinelSuffix?: string;
  /** Sentinel of the form `PREFIX<payload>SUFFIX` an agent prints to surface an artifact/link to the cockpit. */
  flagSentinelPrefix?: string;
  flagSentinelSuffix?: string;
  /** Additional literal substrings that mean "waiting for input" (e.g. tool-permission prompts). */
  waitingPatterns?: string[];
  /**
   * Last-resort wait detection: park the session after this long with no output
   * at all. The sentinels are the protocol, but an agent that ends its turn
   * asking a question in prose emits none — and then nothing anywhere in the
   * harness knows a human is needed. The claude TUI repaints at least once a
   * second while it is working (spinner, elapsed counter), so total silence
   * means it is sitting at the prompt. 0 disables. See {@link idleWaitReason}.
   */
  idleWaitMs?: number;
  /** Reason attached to an {@link idleWaitMs} park — it is inferred, so it says so. */
  idleWaitReason?: string;
  /**
   * Gap (ms) between writing a message's text and the submitting carriage return.
   * See {@link PtySession.send} for why the two are split. 0 writes both at once.
   */
  submitDelayMs?: number;
  /**
   * Initial-message delivery only ({@link PtySession.deliverInitial}): how long to
   * wait before re-sending the submitting Enter, and how many times. A freshly-
   * booted claude REPL drops the first Enter for ~1-2s while it initialises, so the
   * Enter is re-sent (never a re-paste) until the turn starts.
   */
  initialSubmitIntervalMs?: number;
  initialSubmitAttempts?: number;
  /**
   * Render output through a headless terminal emulator into settled, legible
   * text instead of raw TUI bytes (see {@link TerminalTranscript}). On for the
   * real `claude` TUI (`agentMode: 'pty'`); off for `raw`/mock sessions, whose
   * plain line output is already legible as-is.
   */
  legibleTranscript?: boolean;
  /** Quiet period before a legible-transcript update is emitted. */
  transcriptDebounceMs?: number;
  /**
   * Actively terminate the process after the done sentinel. The interactive
   * claude REPL has no natural end — after a turn it just sits at the prompt —
   * so without this the process (and the worktree its cwd pins) leaks forever
   * (issue #66). On for `agentMode: 'pty'`; off for raw/mock sessions, whose
   * processes exit by themselves.
   */
  exitOnDone?: boolean;
  /** How long a graceful `/exit` gets before the SIGTERM backstop. */
  exitGraceMs?: number;
}

const DEFAULTS = {
  doneSentinel: '@@LUBBDUBB_DONE@@',
  waitingSentinelPrefix: '@@LUBBDUBB_WAITING:',
  waitingSentinelSuffix: '@@',
  // Single source of truth for the flag protocol lives in agents/sentinels.ts.
  flagSentinelPrefix: FLAG_PREFIX,
  flagSentinelSuffix: FLAG_SUFFIX,
  waitingPatterns: [] as string[],
  idleWaitMs: 0, // off unless the operator wires it (pty mode does)
  idleWaitReason: 'Agent went quiet without signalling — it may be waiting on you.',
  submitDelayMs: 60,
  initialSubmitIntervalMs: 700,
  initialSubmitAttempts: 8,
  legibleTranscript: false,
  transcriptDebounceMs: 200,
  exitOnDone: false,
  exitGraceMs: 5_000,
};

/** How many trailing characters we keep to match sentinels that straddle two data chunks. */
const TAIL_WINDOW = 4096;

/**
 * Cap on output withheld while waiting for a sentinel's closing suffix — sized as
 * the longest span a real sentinel could occupy, since that is the only text a
 * hold legitimately protects. See {@link holdFrom}: an unterminated prefix must
 * not be able to swallow the rest of the run, and bounding the hold at one
 * sentinel's worth means a prefix the agent never closes costs at most this many
 * characters of delay before the stream self-heals. Comfortably clears a one-line
 * waiting reason or an artifact path, escapes included.
 */
const MAX_SENTINEL_HOLD = 512;

/**
 * Bracketed-paste markers (DECSET 2004). Framing a payload between these tells the
 * claude TUI "this is a paste, and it ends *here*", so the submitting CR that
 * follows is always an Enter keypress and can never be swallowed into the paste as
 * a literal newline. See {@link PtySession.send}.
 */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * One agent's terminal, with all the "is it waiting / is it done" heuristics
 * living here and nowhere else. This is the abstraction the design calls out as
 * the top technical risk; isolating it means the heuristics can be tuned and
 * unit-tested without touching the rest of the harness.
 *
 * Events:
 *   'output' (delta: string)  — terminal output as it arrives (raw bytes, or —
 *                               with `legibleTranscript` — settled-text appends)
 *   'transcript' (text: string) — legible mode only: the settled text was
 *                               rewritten in place; replaces all prior output
 *   'flag'   (flag: ParsedFlag)— an artifact/link the agent surfaced mid-run
 *   'waiting' (reason: string)— session is parked awaiting input
 *   'done'   ()               — clean completion (sentinel or exit code 0)
 *   'exit'   (code: number)   — process ended (any code)
 *   'status' (status)         — status transitions
 */
export class PtySession extends EventEmitter {
  private proc: PtyProcess | null = null;
  private _status: PtySessionStatus = 'starting';
  private tail = '';
  /**
   * True once an explicit *waiting sentinel* parked the session. It latches the
   * wait: the interactive TUI keeps repainting after a turn, and that post-sentinel
   * output eventually scrolls the sentinel out of the {@link TAIL_WINDOW} tail, so
   * without this latch the "any output while parked → running" reset below would
   * silently un-park an agent that is genuinely waiting on a human. Only a human
   * answer ({@link send}), a done sentinel, or exit clears it. The generic
   * `waitingPatterns` wait is *not* latched — it may legitimately auto-recover.
   */
  private sentinelWaiting = false;
  /** Trailing bytes withheld from 'output' because they might be the leading half of a sentinel. */
  private outPending = '';
  /** Legible mode: the emulator standing between raw bytes and the 'output' event. */
  private readonly mirror: TerminalTranscript | null;
  /** Pending exit-on-done timers (the delayed Enter + the SIGTERM backstop), cleared once the process exits. */
  private teardownTimers: ReturnType<typeof setTimeout>[] = [];
  /** Pending initial-message re-submit timer (see {@link deliverInitial}), cleared on exit. */
  private initialSubmitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending idle-park timer (see {@link PtySessionOptions.idleWaitMs}), re-armed by every chunk. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: Required<PtySessionOptions>;
  /** The protocol tokens, in the shape the shared scanner takes. */
  private readonly spec: SentinelSpec;

  constructor(
    private readonly backend: PtyBackend,
    options: PtySessionOptions,
  ) {
    super();
    this.opts = {
      env: {},
      waitingPatterns: DEFAULTS.waitingPatterns,
      idleWaitMs: DEFAULTS.idleWaitMs,
      idleWaitReason: DEFAULTS.idleWaitReason,
      doneSentinel: DEFAULTS.doneSentinel,
      waitingSentinelPrefix: DEFAULTS.waitingSentinelPrefix,
      waitingSentinelSuffix: DEFAULTS.waitingSentinelSuffix,
      flagSentinelPrefix: DEFAULTS.flagSentinelPrefix,
      flagSentinelSuffix: DEFAULTS.flagSentinelSuffix,
      submitDelayMs: DEFAULTS.submitDelayMs,
      initialSubmitIntervalMs: DEFAULTS.initialSubmitIntervalMs,
      initialSubmitAttempts: DEFAULTS.initialSubmitAttempts,
      legibleTranscript: DEFAULTS.legibleTranscript,
      transcriptDebounceMs: DEFAULTS.transcriptDebounceMs,
      exitOnDone: DEFAULTS.exitOnDone,
      exitGraceMs: DEFAULTS.exitGraceMs,
      ...options,
    };
    this.spec = {
      done: this.opts.doneSentinel,
      waitPrefix: this.opts.waitingSentinelPrefix,
      waitSuffix: this.opts.waitingSentinelSuffix,
      flagPrefix: this.opts.flagSentinelPrefix,
      flagSuffix: this.opts.flagSentinelSuffix,
    };
    this.mirror = this.opts.legibleTranscript
      ? new TerminalTranscript({
          debounceMs: this.opts.transcriptDebounceMs,
          onUpdate: (u) => (u.kind === 'append' ? this.emit('output', u.delta) : this.emit('transcript', u.text)),
        })
      : null;
  }

  get status(): PtySessionStatus {
    return this._status;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  start(): void {
    if (this.proc) throw new Error('PtySession already started');
    this.proc = this.backend.spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
    });
    this.setStatus('running');
    this.proc.onData((data) => this.handleData(data));
    this.proc.onExit(({ exitCode }) => this.handleExit(exitCode));
  }

  /**
   * Type text into the session and submit it. The payload is framed as an explicit
   * bracketed paste (`PASTE_START…PASTE_END`) and the submitting carriage return is
   * written *separately*, a `submitDelayMs` gap later. The claude TUI folds a single
   * input burst into a paste and treats a trailing CR as a literal newline; a long,
   * multi-line initial prompt takes longer to settle than the old timing heuristic
   * allowed, so the CR was being swallowed into the paste and the message sat in the
   * input unsubmitted. The paste-end marker closes the paste deterministically, so
   * the CR that follows is always an Enter keypress regardless of payload size —
   * removing the race the fixed gap alone could not win. Trailing newlines in `text`
   * are dropped so our lone CR does the submitting; internal ones stay in the paste.
   */
  send(text: string): void {
    if (!this.proc) throw new Error('PtySession not started');
    this.proc.write(`${PASTE_START}${text.replace(/[\r\n]+$/, '')}${PASTE_END}`);
    this.submit();
    // Sending input un-parks the session — and releases the sentinel latch, since
    // the human has now answered the thing the agent stopped for.
    this.sentinelWaiting = false;
    if (this._status === 'waiting') this.setStatus('running');
    // Arm the idle countdown from the send, not just from output: if the submitting
    // Enter is dropped the answer sits unsent in the input box and the terminal
    // stays silent forever, which is precisely the case worth re-surfacing.
    this.armIdleTimer();
  }

  /**
   * Deliver the *first* message to a freshly-spawned REPL, robust to the boot race.
   * The claude TUI paints its input box (and enables bracketed-paste mode) a second
   * or two before its input loop actually honours a submitting Enter; an Enter sent
   * in that window is silently dropped, so a fixed-delay single {@link send} leaves
   * the prompt sitting unsent in the input box — the "pauses after the first
   * message" bug.
   *
   * The message is pasted *once* (so it can never be duplicated in the box) and the
   * submitting Enter is then re-sent on an interval until the message actually lands.
   * "Landed" is *observed*, not guessed: in legible mode the headless emulator mirrors
   * the real screen, so we read its input box and stop the moment it clears (the REPL
   * accepted the paste) — closing the loop the earlier timing-only heuristics couldn't.
   * Without a mirror (raw/mock sessions) there is nothing to read, so it degrades to the
   * blind open-loop retry: nudge until the status leaves `running` or the attempts run
   * out. A stray Enter that lands after the turn already began is a harmless empty submit.
   * Follow-up messages ({@link send}) don't need this — by then the REPL is live.
   */
  deliverInitial(text: string): void {
    if (!this.proc) throw new Error('PtySession not started');
    this.send(text); // bracketed paste + first submitting CR
    this.scheduleResubmit(1);
  }

  /** Re-send the bare submitting Enter for {@link deliverInitial}, until the message lands or attempts run out. */
  private scheduleResubmit(attempt: number): void {
    if (attempt > this.opts.initialSubmitAttempts) return;
    const t = setTimeout(() => {
      this.initialSubmitTimer = null;
      void this.tryResubmit(attempt);
    }, this.opts.initialSubmitIntervalMs);
    t.unref?.();
    this.initialSubmitTimer = t;
  }

  private async tryResubmit(attempt: number): Promise<void> {
    // A status other than `running` means the agent took the message and moved on
    // (parked / finished / gone) — nothing left to submit.
    if (!this.proc || this._status !== 'running') return;
    // Closed loop: if the emulator shows the input box has emptied, the REPL accepted
    // the paste — stop. A box still holding text (or not yet painted → null) may just be
    // a booting REPL, so keep nudging. Reading the box awaits xterm's async parse, so
    // re-check liveness/status afterwards.
    if (this.mirror) {
      const box = await this.mirror.inputBoxText();
      if (!this.proc || this._status !== 'running') return;
      if (box === '') return; // box rendered and empty → the message submitted
    }
    try {
      this.proc.write('\r'); // re-send only the CR — never a re-paste (it would accumulate)
    } catch {
      return; /* session already gone */
    }
    this.scheduleResubmit(attempt + 1);
  }

  /** Write the submitting carriage return, after {@link PtySessionOptions.submitDelayMs}. */
  private submit(): void {
    const write = (): void => {
      // The session may have finished/been killed during the gap.
      if (!this.proc || this._status === 'done' || this._status === 'killed' || this._status === 'failed') return;
      try {
        this.proc.write('\r');
      } catch {
        /* session already gone */
      }
    };
    if (this.opts.submitDelayMs <= 0) write();
    else setTimeout(write, this.opts.submitDelayMs).unref?.();
  }

  /** Write raw bytes to the pty as-is — no appended carriage return, unlike {@link send} — for control chars like \x03. Does not change status. */
  sendRaw(data: string): void {
    if (!this.proc) throw new Error('PtySession not started');
    this.proc.write(data);
  }

  kill(signal = 'SIGTERM'): void {
    if (this.proc && (this._status === 'running' || this._status === 'waiting' || this._status === 'starting')) {
      // Mark killed *before* signalling: the resulting exit must not be
      // reclassified as a failure. handleExit early-returns on 'killed', so the
      // ordering matters when the exit arrives synchronously.
      this.setStatus('killed');
      this.proc.kill(signal);
    }
  }

  // -- internals -----------------------------------------------------------

  private handleData(data: string): void {
    // Display and detection read the same stream through the same escape-tolerant
    // matcher (see sentinelScanner.ts) — only the buffers differ: display holds a
    // trailing fragment that might still become a sentinel, detection keeps a
    // sliding window so one split across chunks still resolves.
    this.emitFiltered(data);

    const hay = this.tail + data;
    const hits = scanSentinels(hay, this.spec);

    // Flags surface an artifact/link to the cockpit and carry no status meaning,
    // so emit each complete one whichever status follows.
    for (const hit of hits) {
      if (hit.kind !== 'flag') continue;
      const flag = parseFlag(hit.payload);
      if (flag) this.emit('flag', flag);
    }

    // Every sentinel found here is consumed: excising the hits from the retained
    // tail is what stops the sliding window re-firing them on each later chunk.
    this.tail = keepTail(excise(hay, hits));

    // Completion sentinel wins over everything. The scanner boundary-guards it, so
    // an agent echoing the literal string mid-line can't fake a finish.
    if (hits.some((h) => h.kind === 'done')) {
      this.tail = '';
      if (this._status !== 'done') {
        this.finish('done');
        // The sentinel means the *work* is finished, but an interactive REPL
        // keeps running — actively shut it down or it leaks (issue #66).
        if (this.opts.exitOnDone) this.beginTeardown();
      }
      return;
    }

    // Structured waiting sentinel with an embedded reason.
    const waiting = hits.find((h) => h.kind === 'waiting');
    if (waiting) {
      // Latch the wait: it must survive the TUI repainting afterwards (otherwise
      // the reset below un-parks a real human wait).
      this.sentinelWaiting = true;
      this.setWaiting(waiting.payload.trim());
      return;
    }

    // Generic literal patterns that mean "awaiting input". Sharp edge: these are
    // matched anywhere in the tail with no boundary guard, so keep each pattern
    // specific — a short or common substring risks false positives on echoes.
    // Matched on the escape-free view so TUI styling can't split a pattern.
    const plain = this.opts.waitingPatterns.length ? stripAnsi(this.tail) : '';
    for (const pat of this.opts.waitingPatterns) {
      if (pat && plain.includes(pat)) {
        this.setWaiting(pat);
        break;
      }
    }

    // Any output while parked means the agent kept going on its own — but only for
    // a non-sentinel (pattern) wait. A sentinel wait is latched: the TUI's idle
    // repainting is not the agent "continuing", so it must not un-park a real wait.
    if (this._status === 'waiting' && !this.sentinelWaiting) this.setStatus('running');
    this.armIdleTimer();
  }

  /**
   * (Re)start the idle countdown — every chunk pushes it back, so it only fires
   * once the terminal has gone completely quiet. The park it produces is
   * deliberately *not* latched (unlike a sentinel wait): it's an inference, so if
   * the agent was merely thinking and output resumes, the reset above un-parks it.
   */
  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.opts.idleWaitMs <= 0) return;
    const t = setTimeout(() => {
      this.idleTimer = null;
      // Only a *running* session can go idle-quiet: parked/finished ones either
      // already reached the inbox or have nothing left to say.
      if (this._status !== 'running') return;
      this.setWaiting(this.opts.idleWaitReason);
    }, this.opts.idleWaitMs);
    t.unref?.();
    this.idleTimer = t;
  }

  /** Emit `data` with complete sentinels removed, buffering a trailing fragment a following chunk might complete into one. */
  private emitFiltered(data: string): void {
    const buf = this.outPending + data;
    const cleaned = excise(buf, scanSentinels(buf, this.spec));
    const hold = holdFrom(cleaned, this.spec, MAX_SENTINEL_HOLD);
    this.outPending = cleaned.slice(hold);
    const out = cleaned.slice(0, hold);
    if (!out) return;
    // Legible mode routes the (sentinel-stripped) bytes through the emulator,
    // which emits settled 'output'/'transcript' updates on its own debounce.
    if (this.mirror) this.mirror.write(out);
    else this.emit('output', out);
  }

  private setWaiting(reason: string): void {
    if (this._status === 'waiting') return;
    this.setStatus('waiting');
    this.emit('waiting', reason);
  }

  /**
   * Ask the finished REPL to exit — `/exit`, then its submitting Enter after the
   * same paste-vs-keypress gap {@link send} uses — with a SIGTERM backstop if it
   * hasn't exited within `exitGraceMs`. Runs *after* the 'done' transition, so it
   * bypasses `send`/`kill` (both guard against terminal states by design) and
   * writes/kills the process directly. `handleExit` clears the timers, and
   * `reportExit` already ignores exits on a 'done' session, so neither the
   * graceful nor the forced exit is reclassified as a failure.
   */
  private beginTeardown(): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.write('/exit');
    } catch {
      /* process already gone */
    }
    const settimer = (ms: number, fn: () => void): void => {
      const t = setTimeout(() => {
        try {
          fn();
        } catch {
          /* process already gone */
        }
      }, ms);
      t.unref?.();
      this.teardownTimers.push(t);
    };
    settimer(this.opts.submitDelayMs, () => proc.write('\r'));
    settimer(this.opts.exitGraceMs, () => proc.kill('SIGTERM'));
  }

  private handleExit(code: number): void {
    for (const t of this.teardownTimers) clearTimeout(t);
    this.teardownTimers = [];
    if (this.initialSubmitTimer) {
      clearTimeout(this.initialSubmitTimer);
      this.initialSubmitTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Legible mode: flush the emulator's final settled text *before* the exit is
    // reported, so a terminal transition never races the tail of the transcript.
    const mirror = this.mirror;
    if (mirror) {
      void mirror.settle().then(() => {
        mirror.dispose();
        this.reportExit(code);
      });
    } else {
      this.reportExit(code);
    }
  }

  private reportExit(code: number): void {
    this.emit('exit', code);
    if (this._status === 'killed') return;
    if (this._status === 'done') return;
    // Exit 0 with no sentinel still counts as a clean finish.
    this.finish(code === 0 ? 'done' : 'failed');
  }

  private finish(status: 'done' | 'failed'): void {
    this.setStatus(status);
    this.emit(status === 'done' ? 'done' : 'failed');
  }

  private setStatus(status: PtySessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }
}

function keepTail(s: string): string {
  return s.length > TAIL_WINDOW ? s.slice(-TAIL_WINDOW) : s;
}
