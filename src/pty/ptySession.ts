import { EventEmitter } from 'node:events';
import type { PtyBackend, PtyProcess } from './backend.js';
import { TerminalTranscript } from './terminalTranscript.js';

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
  /** Additional literal substrings that mean "waiting for input" (e.g. tool-permission prompts). */
  waitingPatterns?: string[];
  /**
   * Gap (ms) between writing a message's text and the submitting carriage return.
   * See {@link PtySession.send} for why the two are split. 0 writes both at once.
   */
  submitDelayMs?: number;
  /**
   * Render output through a headless terminal emulator into settled, legible
   * text instead of raw TUI bytes (see {@link TerminalTranscript}). On for the
   * real `claude` TUI (`agentMode: 'pty'`); off for `raw`/mock sessions, whose
   * plain line output is already legible as-is.
   */
  legibleTranscript?: boolean;
  /** Quiet period before a legible-transcript update is emitted. */
  transcriptDebounceMs?: number;
}

const DEFAULTS = {
  doneSentinel: '@@LUBBDUBB_DONE@@',
  waitingSentinelPrefix: '@@LUBBDUBB_WAITING:',
  waitingSentinelSuffix: '@@',
  waitingPatterns: [] as string[],
  submitDelayMs: 60,
  legibleTranscript: false,
  transcriptDebounceMs: 200,
};

/** How many trailing characters we keep to match sentinels that straddle two data chunks. */
const TAIL_WINDOW = 4096;

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
 *   'waiting' (reason: string)— session is parked awaiting input
 *   'done'   ()               — clean completion (sentinel or exit code 0)
 *   'exit'   (code: number)   — process ended (any code)
 *   'status' (status)         — status transitions
 */
export class PtySession extends EventEmitter {
  private proc: PtyProcess | null = null;
  private _status: PtySessionStatus = 'starting';
  private tail = '';
  /** Trailing bytes withheld from 'output' because they might be the leading half of a sentinel. */
  private outPending = '';
  /** Legible mode: the emulator standing between raw bytes and the 'output' event. */
  private readonly mirror: TerminalTranscript | null;
  private readonly opts: Required<PtySessionOptions>;

  constructor(
    private readonly backend: PtyBackend,
    options: PtySessionOptions,
  ) {
    super();
    this.opts = {
      env: {},
      waitingPatterns: DEFAULTS.waitingPatterns,
      doneSentinel: DEFAULTS.doneSentinel,
      waitingSentinelPrefix: DEFAULTS.waitingSentinelPrefix,
      waitingSentinelSuffix: DEFAULTS.waitingSentinelSuffix,
      submitDelayMs: DEFAULTS.submitDelayMs,
      legibleTranscript: DEFAULTS.legibleTranscript,
      transcriptDebounceMs: DEFAULTS.transcriptDebounceMs,
      ...options,
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
   * Type text into the session and submit it. The payload and the submitting
   * carriage return are written *separately*, with a `submitDelayMs` gap: the
   * claude TUI folds a single input burst into a paste and treats a trailing CR
   * as a literal newline, so a glued-on CR leaves the message sitting in the
   * input unsubmitted. The gap lets the CR land as a distinct Enter keypress.
   * Trailing newlines in `text` are dropped so our lone CR does the submitting.
   */
  send(text: string): void {
    if (!this.proc) throw new Error('PtySession not started');
    this.proc.write(text.replace(/[\r\n]+$/, ''));
    this.submit();
    // Sending input un-parks the session.
    if (this._status === 'waiting') this.setStatus('running');
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
    // Display and detection are separated: emit output with the control
    // sentinels stripped (so they never leak into the visible terminal), while
    // detection below still scans the full, unfiltered tail window so its
    // heuristics are unchanged.
    this.emitFiltered(data);

    const hay = this.tail + data;

    // Completion sentinel wins over everything. Require it on a token boundary
    // so an agent echoing the literal string mid-line can't fake a finish.
    if (findDelimited(hay, this.opts.doneSentinel) !== -1) {
      this.tail = '';
      if (this._status !== 'done') this.finish('done');
      return;
    }

    // Structured waiting sentinel with an embedded reason (also boundary-guarded).
    const reason = this.extractWaitingReason(hay);
    if (reason !== null) {
      this.tail = '';
      this.setWaiting(reason);
      this.tail = keepTail(hay);
      return;
    }

    // Generic literal patterns that mean "awaiting input". Sharp edge: these are
    // matched anywhere in the tail with no boundary guard, so keep each pattern
    // specific — a short or common substring risks false positives on echoes.
    for (const pat of this.opts.waitingPatterns) {
      if (pat && hay.includes(pat)) {
        this.setWaiting(pat);
        break;
      }
    }

    // Any output while parked means the agent kept going on its own.
    if (this._status === 'waiting') this.setStatus('running');
    this.tail = keepTail(hay);
  }

  /** Emit `data` with complete sentinels removed, buffering an ambiguous trailing fragment that a following chunk might complete into a sentinel. */
  private emitFiltered(data: string): void {
    const cleaned = this.stripCompleteSentinels(this.outPending + data);
    const hold = this.ambiguousTailStart(cleaned);
    this.outPending = cleaned.slice(hold);
    const out = cleaned.slice(0, hold);
    if (!out) return;
    // Legible mode routes the (sentinel-stripped) bytes through the emulator,
    // which emits settled 'output'/'transcript' updates on its own debounce.
    if (this.mirror) this.mirror.write(out);
    else this.emit('output', out);
  }

  /** Remove fully-formed done and waiting (`PREFIX…SUFFIX`) sentinels; incomplete ones are left for {@link ambiguousTailStart} to hold. */
  private stripCompleteSentinels(s: string): string {
    const { doneSentinel: done, waitingSentinelPrefix: pre, waitingSentinelSuffix: suf } = this.opts;
    if (done) s = s.split(done).join('');
    if (pre && suf) {
      let out = '';
      let i = 0;
      for (;;) {
        const start = s.indexOf(pre, i);
        if (start === -1) {
          out += s.slice(i);
          break;
        }
        const end = s.indexOf(suf, start + pre.length);
        if (end === -1) {
          out += s.slice(i); // no closing suffix yet: keep, held back below
          break;
        }
        out += s.slice(i, start);
        i = end + suf.length;
      }
      s = out;
    }
    return s;
  }

  /** Index from which the tail is an incomplete sentinel we must withhold (`s.length` = emit everything). */
  private ambiguousTailStart(s: string): number {
    const { doneSentinel: done, waitingSentinelPrefix: pre } = this.opts;
    // An un-terminated waiting prefix: its reason and closing suffix may still
    // be arriving, so hold from the prefix onward.
    if (pre) {
      const p = s.indexOf(pre);
      if (p !== -1) return p;
    }
    // Otherwise hold the longest trailing run that is a proper prefix of a
    // sentinel token, so a boundary-split sentinel is never half-emitted.
    const tokens = [done, pre].filter((t) => t);
    const maxLen = Math.max(0, ...tokens.map((t) => t.length - 1));
    for (let k = Math.min(maxLen, s.length); k >= 1; k--) {
      const suffix = s.slice(s.length - k);
      if (tokens.some((t) => t.length > k && t.startsWith(suffix))) return s.length - k;
    }
    return s.length;
  }

  private extractWaitingReason(hay: string): string | null {
    const { waitingSentinelPrefix: pre, waitingSentinelSuffix: suf } = this.opts;
    let from = 0;
    for (;;) {
      const start = hay.indexOf(pre, from);
      if (start === -1) return null;
      // Boundary-guard the prefix so an echoed sentinel mid-token doesn't park us.
      if (!isBoundary(start === 0 ? undefined : hay[start - 1])) {
        from = start + 1;
        continue;
      }
      const reasonAt = start + pre.length;
      const end = hay.indexOf(suf, reasonAt);
      if (end === -1) return null; // suffix not yet arrived; wait for more data
      const after = end + suf.length;
      if (!isBoundary(after >= hay.length ? undefined : hay[after])) {
        from = start + 1;
        continue;
      }
      return hay.slice(reasonAt, end).trim();
    }
  }

  private setWaiting(reason: string): void {
    if (this._status === 'waiting') return;
    this.setStatus('waiting');
    this.emit('waiting', reason);
  }

  private handleExit(code: number): void {
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

/** A sentinel boundary: start/end of the buffer, or a whitespace char. */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** First index of `token` in `hay` where it sits on a boundary both sides (not mid-token), else -1. */
function findDelimited(hay: string, token: string): number {
  if (!token) return -1;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(token, from);
    if (i === -1) return -1;
    const before = i === 0 ? undefined : hay[i - 1];
    const afterIdx = i + token.length;
    const after = afterIdx >= hay.length ? undefined : hay[afterIdx];
    if (isBoundary(before) && isBoundary(after)) return i;
    from = i + 1;
  }
}
