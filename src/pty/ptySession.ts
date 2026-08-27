import { EventEmitter } from 'node:events';
import type { PtyBackend, PtyProcess } from './backend.js';
import { FLAG_PREFIX, FLAG_SUFFIX, parseFlag } from '../agents/sentinels.js';
import { stripAnsi } from '../agents/streamTranscript.js';
import { excise, holdFrom, scanSentinels, type SentinelSpec } from './sentinelScanner.js';
import type { AgentSession, AgentSessionStatus } from '../agents/session.js';
import type { ProcessReaper } from '../agents/processTree.js';

type PtySessionStatus = AgentSessionStatus;

interface PtySessionOptions {
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
   * Gap (ms) between writing a message's text and the submitting carriage return.
   * See {@link PtySession.send} for why the two are split. 0 writes both at once.
   */
  submitDelayMs?: number;
  /** Non-fatal diagnostics (a broken session-file tail, detection drift) for the error log. */
  onWarning?: (message: string) => void;
  /**
   * How a kill reaches the agent's *descendants* (see {@link ProcessReaper}).
   *
   * Defaults to doing nothing rather than to `killProcessTree`, and that pairing
   * is deliberate: the default reap must match the default *backend*, and a
   * session driven by {@link FakePtyBackend} has a scripted process whose pid
   * names some unrelated process on the host. The composition root wires the real
   * reaper alongside the real backend; nothing else constructs this.
   */
  reap?: ProcessReaper;
}

const DEFAULTS = {
  doneSentinel: '@@LUBBDUBB_DONE@@',
  waitingSentinelPrefix: '@@LUBBDUBB_WAITING:',
  waitingSentinelSuffix: '@@',
  // Single source of truth for the flag protocol lives in agents/sentinels.ts.
  flagSentinelPrefix: FLAG_PREFIX,
  flagSentinelSuffix: FLAG_SUFFIX,
  waitingPatterns: [] as string[],
  submitDelayMs: 60,
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
 * Bracketed-paste markers (DECSET 2004). Framing a payload between these tells a
 * line editor "this is a paste, and it ends *here*", so the submitting CR that
 * follows is always an Enter keypress and can never be swallowed into the paste as
 * a literal newline. See {@link PtySession.send}.
 */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * One agent's terminal, with all the "is it waiting / is it done" heuristics
 * living here and nowhere else.
 *
 * Since the interactive `claude` runtime was removed this serves `agentMode: 'raw'`
 * alone — the operator's argv (in practice the mock agent) run verbatim, line
 * oriented, announcing itself through the sentinels it prints. That is why nothing
 * here reads a session file, waits out a REPL's boot race or shuts a finished
 * process down: a raw program writes plain lines and exits by itself. A model runs
 * on the stream transport ({@link StreamJsonSession}), which reads its status off
 * structure rather than off a screen.
 *
 * Events:
 *   'output' (delta: string)  — terminal bytes, sentinels excised
 *   'flag'   (flag: ParsedFlag)— an artifact/link the agent surfaced mid-run
 *   'waiting' (reason: string)— session is parked awaiting input
 *   'done'   ()               — clean completion (sentinel or exit code 0)
 *   'exit'   (code: number)   — process ended (any code)
 *   'status' (status)         — status transitions
 */
export class PtySession extends EventEmitter implements AgentSession {
  private proc: PtyProcess | null = null;
  private _status: PtySessionStatus = 'starting';
  private tail = '';
  /**
   * True once an explicit *waiting sentinel* parked the session. It latches the
   * wait: output printed after the sentinel eventually scrolls it out of the
   * {@link TAIL_WINDOW} tail, so
   * without this latch the "any output while parked → running" reset below would
   * silently un-park an agent that is genuinely waiting on a human. Only a human
   * answer ({@link send}), a done sentinel, or exit clears it. The generic
   * `waitingPatterns` wait is *not* latched — it may legitimately auto-recover.
   */
  private sentinelWaiting = false;
  /** Trailing bytes withheld from 'output' because they might be the leading half of a sentinel. */
  private outPending = '';
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
      doneSentinel: DEFAULTS.doneSentinel,
      waitingSentinelPrefix: DEFAULTS.waitingSentinelPrefix,
      waitingSentinelSuffix: DEFAULTS.waitingSentinelSuffix,
      flagSentinelPrefix: DEFAULTS.flagSentinelPrefix,
      flagSentinelSuffix: DEFAULTS.flagSentinelSuffix,
      submitDelayMs: DEFAULTS.submitDelayMs,
      onWarning: () => {},
      reap: () => {},
      ...options,
    };
    this.spec = {
      done: this.opts.doneSentinel,
      waitPrefix: this.opts.waitingSentinelPrefix,
      waitSuffix: this.opts.waitingSentinelSuffix,
      flagPrefix: this.opts.flagSentinelPrefix,
      flagSuffix: this.opts.flagSentinelSuffix,
    };
  }

  /**
   * The terminal echoes what was typed into it, so the manager must not write the
   * sent message a second time or each one would appear twice.
   */
  readonly recordsSentMessages = true;

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
   * written *separately*, a `submitDelayMs` gap later. A line editor folds a single
   * input burst into a paste and treats a trailing CR as a literal newline, which
   * leaves the message sitting unsubmitted; the paste-end marker closes the paste
   * deterministically, so the CR that follows is always an Enter keypress whatever
   * the payload's size. Trailing newlines in `text` are dropped so our lone CR does
   * the submitting; internal ones stay in the paste.
   */
  send(text: string): void {
    if (!this.proc) throw new Error('PtySession not started');
    this.proc.write(`${PASTE_START}${text.replace(/[\r\n]+$/, '')}${PASTE_END}`);
    this.submit();
    // Sending input un-parks the session — and releases the sentinel latch, since
    // the human has now answered the thing the agent stopped for.
    this.sentinelWaiting = false;
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

  /**
   * Stop the terminal — **and everything the agent started in it**. A Bash-tool
   * shell left running holds the worktree cwd open long after `claude` is gone,
   * which on Windows wedges the branch for good; see {@link ProcessReaper}.
   */
  kill(signal = 'SIGTERM'): void {
    if (this.proc && (this._status === 'running' || this._status === 'waiting' || this._status === 'starting')) {
      // Mark killed *before* signalling: the resulting exit must not be
      // reclassified as a failure. handleExit early-returns on 'killed', so the
      // ordering matters when the exit arrives synchronously.
      this.setStatus('killed');
      // Between the two, and for the same ordering reason applied to the tree: the
      // reap resolves descendants *through* the root pid, so a dead root leaves
      // nothing to find. It cannot throw, so `proc.kill` always follows.
      this.opts.reap(this.proc.pid);
      this.proc.kill(signal);
    }
  }

  // -- internals -----------------------------------------------------------

  private handleData(data: string): void {
    this.emitFiltered(data);

    const hay = this.tail + data;
    const hits = scanSentinels(hay, this.spec);

    // Flags surface an artifact/link to the cockpit and carry no status meaning,
    // so emit each complete one whichever status follows.
    for (const hit of hits) {
      if (hit.kind === 'flag') this.applySentinel('flag', hit.payload);
    }

    // Every sentinel found here is consumed: excising the hits from the retained
    // tail is what stops the sliding window re-firing them on each later chunk.
    this.tail = keepTail(excise(hay, hits));

    // Completion sentinel wins over everything. The scanner boundary-guards it, so
    // an agent echoing the literal string mid-line can't fake a finish.
    if (hits.some((h) => h.kind === 'done')) {
      this.tail = '';
      this.applySentinel('done', '');
      return;
    }

    // Structured waiting sentinel with an embedded reason.
    const waiting = hits.find((h) => h.kind === 'waiting');
    if (waiting) {
      this.applySentinel('waiting', waiting.payload.trim());
      return;
    }

    // Generic literal patterns that mean "awaiting input". Sharp edge: these are
    // matched anywhere in the tail with no boundary guard, so keep each pattern
    // specific — a short or common substring risks false positives on echoes.
    // Matched on the escape-free view so styling can't split a pattern.
    const plain = this.opts.waitingPatterns.length ? stripAnsi(this.tail) : '';
    for (const pat of this.opts.waitingPatterns) {
      if (pat && plain.includes(pat)) {
        this.setWaiting(pat);
        break;
      }
    }

    // Any output while parked means the agent kept going on its own — but only for
    // a non-sentinel (pattern) wait. A sentinel wait is latched, because it is the
    // agent's own statement that it stopped and only an answer ends it.
    if (this._status === 'waiting' && !this.sentinelWaiting) this.setStatus('running');
  }

  /**
   * Emit `data` with complete sentinels removed, buffering a trailing fragment a
   * following chunk might complete into one.
   */
  private emitFiltered(data: string): void {
    const buf = this.outPending + data;
    const cleaned = excise(buf, scanSentinels(buf, this.spec));
    const hold = holdFrom(cleaned, this.spec, MAX_SENTINEL_HOLD);
    this.outPending = cleaned.slice(hold);
    const out = cleaned.slice(0, hold);
    if (out) this.emit('output', out);
  }

  /**
   * Apply a sentinel the terminal scan found. Every transition below is
   * idempotent, so a sentinel reported twice is harmless.
   */
  private applySentinel(kind: 'done' | 'waiting' | 'flag', payload: string): void {
    if (kind === 'flag') {
      const flag = parseFlag(payload);
      if (flag) this.emit('flag', flag);
      return;
    }
    if (kind === 'done') {
      if (this._status === 'done') return;
      this.finish('done');
      return;
    }
    // Latch the wait: it must survive whatever the process prints afterwards,
    // otherwise the "output while parked → running" reset un-parks a real human wait.
    this.sentinelWaiting = true;
    this.setWaiting(payload);
  }

  private setWaiting(reason: string): void {
    if (this._status === 'waiting') return;
    this.setStatus('waiting');
    this.emit('waiting', reason);
  }

  private handleExit(code: number): void {
    this.reportExit(code);
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
