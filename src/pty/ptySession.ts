import { EventEmitter } from 'node:events';
import type { PtyBackend, PtyProcess } from './backend.js';

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
}

const DEFAULTS = {
  doneSentinel: '@@LUBBDUBB_DONE@@',
  waitingSentinelPrefix: '@@LUBBDUBB_WAITING:',
  waitingSentinelSuffix: '@@',
  waitingPatterns: [] as string[],
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
 *   'output' (delta: string)  — raw terminal output as it arrives
 *   'waiting' (reason: string)— session is parked awaiting input
 *   'done'   ()               — clean completion (sentinel or exit code 0)
 *   'exit'   (code: number)   — process ended (any code)
 *   'status' (status)         — status transitions
 */
export class PtySession extends EventEmitter {
  private proc: PtyProcess | null = null;
  private _status: PtySessionStatus = 'starting';
  private tail = '';
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
      ...options,
    };
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

  /** Type text into the session. Appends a carriage return so it's submitted. */
  send(text: string): void {
    if (!this.proc) throw new Error('PtySession not started');
    this.proc.write(text.endsWith('\r') || text.endsWith('\n') ? text : text + '\r');
    // Sending input un-parks the session.
    if (this._status === 'waiting') this.setStatus('running');
  }

  kill(signal = 'SIGTERM'): void {
    if (this.proc && (this._status === 'running' || this._status === 'waiting' || this._status === 'starting')) {
      this.proc.kill(signal);
      this.setStatus('killed');
    }
  }

  // -- internals -----------------------------------------------------------

  private handleData(data: string): void {
    this.emit('output', data);
    const hay = (this.tail + data);

    // Completion sentinel wins over everything.
    if (hay.includes(this.opts.doneSentinel)) {
      this.tail = '';
      if (this._status !== 'done') this.finish('done');
      return;
    }

    // Structured waiting sentinel with an embedded reason.
    const reason = this.extractWaitingReason(hay);
    if (reason !== null) {
      this.tail = '';
      this.setWaiting(reason);
      this.tail = keepTail(hay);
      return;
    }

    // Generic literal patterns that mean "awaiting input".
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

  private extractWaitingReason(hay: string): string | null {
    const { waitingSentinelPrefix: pre, waitingSentinelSuffix: suf } = this.opts;
    const start = hay.indexOf(pre);
    if (start === -1) return null;
    const from = start + pre.length;
    const end = hay.indexOf(suf, from);
    if (end === -1) return null; // suffix not yet arrived; wait for more data
    return hay.slice(from, end).trim();
  }

  private setWaiting(reason: string): void {
    if (this._status === 'waiting') return;
    this.setStatus('waiting');
    this.emit('waiting', reason);
  }

  private handleExit(code: number): void {
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
