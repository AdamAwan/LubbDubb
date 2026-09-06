import { EventEmitter } from 'node:events';
import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import { localRunIsLive } from '../store/localRuns.js';
import type { LocalRun, LocalRunFreshness, LocalRunPorts, LocalRunReadings } from '../types.js';
import { probePort, type PortLister } from './ports.js';

// → docs/spec/23-local-runs.md

interface LocalRunWatchDeps {
  runner: { current(): LocalRun | null; on(event: 'changed', cb: () => void): unknown };
  git: GitObserver;
  fetch?: () => Promise<void>;
  ports: PortLister;
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  baseFor: (originRef: string, ref: string) => string | null;
  now?: () => number;
  portIntervalMs?: number;
  gitIntervalMs?: number;
  fetchIntervalMs?: number;
  errors: ErrorRecorder;
}

const PORT_INTERVAL_MS = 10_000;
const GIT_INTERVAL_MS = 60_000;
const FETCH_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_000;

export class LocalRunWatch extends EventEmitter {
  private ports: LocalRunPorts | null = null;
  private freshness: LocalRunFreshness | null = null;
  private seen: { id: string; status: string } | null = null;
  private lastGitAt = 0;
  private lastFetchAt = 0;
  private lastFetchError: string | null = null;
  private lastGitError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nudge: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: LocalRunWatchDeps) {
    super();
    this.now = deps.now ?? (() => Date.now());
    deps.runner.on('changed', () => {
      if (this.timer === null || this.nudge !== null) return;
      const run = deps.runner.current();
      if (run === null ? this.seen === null : this.seen?.id === run.id && this.seen.status === run.status) return;
      this.nudge = setTimeout(() => {
        this.nudge = null;
        void this.tick();
      }, 0);
      this.nudge.unref();
    });
  }

  override emit(event: 'changed'): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
  override on(event: 'changed', cb: () => void): this;
  override on(event: string, cb: (...args: unknown[]) => void): this {
    return super.on(event, cb);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.deps.portIntervalMs ?? PORT_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.nudge !== null) clearTimeout(this.nudge);
    this.timer = null;
    this.nudge = null;
  }

  reading(): LocalRunReadings {
    return { ports: this.ports, freshness: this.freshness };
  }

  tick(): Promise<void> {
    if (this.ticking !== null) return this.ticking;
    this.ticking = this.take().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async take(): Promise<void> {
    const before = comparable(this.reading());
    const run = this.deps.runner.current();
    const live = run !== null && localRunIsLive(run) ? run : null;
    if (live === null) {
      this.ports = null;
      this.freshness = null;
      this.seen = null;
      this.lastGitAt = 0;
      this.announce(before);
      return;
    }
    if (this.seen?.id !== live.id) {
      this.ports = null;
      this.freshness = null;
      this.lastGitAt = 0;
    }
    this.seen = { id: live.id, status: live.status };

    const at = new Date(this.now()).toISOString();
    this.ports = await this.readPorts(live, at);
    const now = this.now();
    if (now - this.lastGitAt >= (this.deps.gitIntervalMs ?? GIT_INTERVAL_MS)) {
      this.lastGitAt = now;
      await this.maybeFetch(now);
      this.freshness = await this.readFreshness(live, at);
    }
    this.announce(before);
  }

  private async readPorts(run: LocalRun, at: string): Promise<LocalRunPorts> {
    const declared = declaredPort(run.url);
    const probe = this.deps.probe ?? probePort;
    const answering = declared === null ? null : await probe(declared.host, declared.port, PROBE_TIMEOUT_MS);
    const listening = await this.deps.ports.listening({ pid: run.pid, dir: run.dir });
    return {
      checkedAt: at,
      declared: declared === null || answering === null ? null : { ...declared, answering },
      listening,
    };
  }

  private async readFreshness(run: LocalRun, at: string): Promise<LocalRunFreshness> {
    const behindTip = run.commit === null ? null : ((await this.divergence(run.ref, run.commit))?.ahead ?? null);
    const baseRef = this.deps.baseFor(run.originRef, run.ref);
    const base =
      baseRef === null ? null : { ref: baseRef, behind: (await this.divergence(run.ref, baseRef))?.behind ?? null };
    return { checkedAt: at, behindTip, base };
  }

  private async divergence(branch: string, base: string): Promise<{ ahead: number; behind: number } | null> {
    try {
      const answer = await this.deps.git.divergence(branch, base);
      this.lastGitError = null;
      return answer;
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.lastGitError) {
        this.lastGitError = message;
        this.deps.errors.record({ source: 'agent', message: `The local run watch could not ask git: ${message}` });
      }
      return null;
    }
  }

  private async maybeFetch(now: number): Promise<void> {
    const fetch = this.deps.fetch;
    if (!fetch) return;
    if (now - this.lastFetchAt < (this.deps.fetchIntervalMs ?? FETCH_INTERVAL_MS)) return;
    this.lastFetchAt = now;
    try {
      await fetch();
      this.lastFetchError = null;
    } catch (err) {
      const message = (err as Error).message;
      if (message === this.lastFetchError) return;
      this.lastFetchError = message;
      this.deps.errors.record({ source: 'agent', message: `The local run watch could not fetch: ${message}` });
    }
  }

  private announce(before: string): void {
    if (comparable(this.reading()) !== before) this.emit('changed');
  }
}

function comparable(readings: LocalRunReadings): string {
  return JSON.stringify(readings, (key, value: unknown) => (key === 'checkedAt' ? undefined : value));
}

function declaredPort(url: string | null): { url: string; host: string; port: number } | null {
  if (url === null || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  const port =
    parsed.port !== ''
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : parsed.protocol === 'http:'
          ? 80
          : Number.NaN;
  if (!Number.isInteger(port)) return null;
  return { url, host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'), port };
}
