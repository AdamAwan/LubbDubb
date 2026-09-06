import { EventEmitter } from 'node:events';
import type { PtyBackend, PtyProcess } from './backend.js';
import { FLAG_PREFIX, FLAG_SUFFIX, parseFlag } from '../agents/sentinels.js';
import { stripAnsi } from '../agents/streamTranscript.js';
import { excise, holdFrom, scanSentinels, type SentinelSpec } from './sentinelScanner.js';
import type { AgentSession, AgentSessionStatus } from '../agents/session.js';
import type { ProcessReaper } from '../agents/processTree.js';

// → docs/spec/10-agent-runtimes.md

type PtySessionStatus = AgentSessionStatus;

interface PtySessionOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  doneSentinel?: string;
  waitingSentinelPrefix?: string;
  waitingSentinelSuffix?: string;
  flagSentinelPrefix?: string;
  flagSentinelSuffix?: string;
  waitingPatterns?: string[];
  submitDelayMs?: number;
  onWarning?: (message: string) => void;
  reap?: ProcessReaper;
}

const DEFAULTS = {
  doneSentinel: '@@LUBBDUBB_DONE@@',
  waitingSentinelPrefix: '@@LUBBDUBB_WAITING:',
  waitingSentinelSuffix: '@@',
  flagSentinelPrefix: FLAG_PREFIX,
  flagSentinelSuffix: FLAG_SUFFIX,
  waitingPatterns: [] as string[],
  submitDelayMs: 60,
};

const TAIL_WINDOW = 4096;

const MAX_SENTINEL_HOLD = 512;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class PtySession extends EventEmitter implements AgentSession {
  private proc: PtyProcess | null = null;
  private _status: PtySessionStatus = 'starting';
  private tail = '';
  private sentinelWaiting = false;
  private outPending = '';
  private readonly opts: Required<PtySessionOptions>;
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

  // TECHDEBT: a line editor folds a single input burst into a paste and treats a trailing
  // CR as a literal newline, leaving the message unsubmitted. So the payload is framed as an
  // explicit bracketed paste and the submitting CR is written separately, a `submitDelayMs`
  // gap later, where it always reads as an Enter keypress.
  send(text: string): void {
    if (!this.proc) throw new Error('PtySession not started');
    this.proc.write(`${PASTE_START}${text.replace(/[\r\n]+$/, '')}${PASTE_END}`);
    this.submit();
    this.sentinelWaiting = false;
    if (this._status === 'waiting') this.setStatus('running');
  }

  private submit(): void {
    const write = (): void => {
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

  sendRaw(data: string): void {
    if (!this.proc) throw new Error('PtySession not started');
    this.proc.write(data);
  }

  // TECHDEBT: ordering is load-bearing twice over. Status goes to `killed` *before* the
  // signal, or a synchronously delivered exit is reclassified as a failure; and the reap
  // resolves descendants *through* the root pid, so it must run before `proc.kill`.
  kill(signal = 'SIGTERM'): void {
    if (this.proc && (this._status === 'running' || this._status === 'waiting' || this._status === 'starting')) {
      this.setStatus('killed');
      this.opts.reap(this.proc.pid);
      this.proc.kill(signal);
    }
  }

  private handleData(data: string): void {
    this.emitFiltered(data);

    const hay = this.tail + data;
    const hits = scanSentinels(hay, this.spec);

    for (const hit of hits) {
      if (hit.kind === 'flag') this.applySentinel('flag', hit.payload);
    }

    this.tail = keepTail(excise(hay, hits));

    if (hits.some((h) => h.kind === 'done')) {
      this.tail = '';
      this.applySentinel('done', '');
      return;
    }

    const waiting = hits.find((h) => h.kind === 'waiting');
    if (waiting) {
      this.applySentinel('waiting', waiting.payload.trim());
      return;
    }

    const plain = this.opts.waitingPatterns.length ? stripAnsi(this.tail) : '';
    for (const pat of this.opts.waitingPatterns) {
      if (pat && plain.includes(pat)) {
        this.setWaiting(pat);
        break;
      }
    }

    if (this._status === 'waiting' && !this.sentinelWaiting) this.setStatus('running');
  }

  private emitFiltered(data: string): void {
    const buf = this.outPending + data;
    const cleaned = excise(buf, scanSentinels(buf, this.spec));
    const hold = holdFrom(cleaned, this.spec, MAX_SENTINEL_HOLD);
    this.outPending = cleaned.slice(hold);
    const out = cleaned.slice(0, hold);
    if (out) this.emit('output', out);
  }

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
