import { EventEmitter } from 'node:events';
import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import { localRunIsLive } from '../store/localRuns.js';
import type { LocalRun, LocalRunFreshness, LocalRunPorts, LocalRunReadings } from '../types.js';
import { probePort, type PortLister } from './ports.js';

interface LocalRunWatchDeps {
  /** The runner, for which run is live and for the nudge when that changes. */
  runner: { current(): LocalRun | null; on(event: 'changed', cb: () => void): unknown };
  /** Read-only and fetch-free, as the seam says; `divergence` is all this asks of it. */
  git: GitObserver;
  /**
   * Refreshes the remote-tracking refs, or undefined where nothing should — a
   * scripted observer has no remote. Floored by `fetchIntervalMs`, and the only
   * thing keeping `origin/*` fresh on a deployment with no active plan, since the
   * reconciler's fetch runs only while it has plans to reconcile.
   */
  fetch?: () => Promise<void>;
  ports: PortLister;
  /** The TCP connect, injectable so a test does not open a socket. Default {@link probePort}. */
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /**
   * The branch `ref` was cut from, or null for the integration branch. A question
   * about the plan, so it is asked where the plan is (`partBase`) rather than
   * answered here.
   */
  baseFor: (originRef: string, ref: string) => string | null;
  now?: () => number;
  /** How often the ports are read while a run is live. */
  portIntervalMs?: number;
  /** How often the clone is asked how far behind the checkout is. */
  gitIntervalMs?: number;
  /** The floor under `fetch`. */
  fetchIntervalMs?: number;
  errors: ErrorRecorder;
}

const PORT_INTERVAL_MS = 10_000;
const GIT_INTERVAL_MS = 60_000;
const FETCH_INTERVAL_MS = 60_000;
/** A port that has not answered in a second is not answering. */
const PROBE_TIMEOUT_MS = 1_000;

/**
 * The readings on the local run: what is listening, and how far behind the
 * checkout has fallen. The first thing about the run that is *observed* rather than
 * presumed — everything else the panel draws is what the session said or what the
 * row records.
 *
 * **Its own timer, not the pulse.** The fleet's cycle is thirty seconds busy and
 * five minutes idle, and an operator watching a bring-up wants to see the port come
 * up in seconds; the local run is also, by design, nothing the dispatcher knows
 * about. Started from `main.ts` beside `resumeInterrupted` and never from
 * `buildSystem`, because every test builds a `System` and an armed interval would
 * hold `node --test` open — and the real lister would run PowerShell on a developer's
 * machine the moment a test had a live run.
 *
 * **Its own class, not the runner's.** The runner holds the process and must never
 * block on git or a socket; this blocks on both, on purpose, off to one side.
 *
 * **`changed` only when a reading changes**, `checkedAt` excepted. Every `dirty`
 * costs every connected cockpit a snapshot, and a steady environment read every ten
 * seconds would otherwise pay that for nothing.
 * → `docs/spec/23-local-runs.md#watching-the-environment`
 */
export class LocalRunWatch extends EventEmitter {
  private ports: LocalRunPorts | null = null;
  private freshness: LocalRunFreshness | null = null;
  /** The run and status the last tick saw, so a change of either resets what it took. */
  private seen: { id: string; status: string } | null = null;
  private lastGitAt = 0;
  private lastFetchAt = 0;
  private lastFetchError: string | null = null;
  private lastGitError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The reading scheduled off a runner change, so `stop` can cancel it with the interval. */
  private nudge: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: LocalRunWatchDeps) {
    super();
    this.now = deps.now ?? (() => Date.now());
    // A different run or a different status means the readings describe something
    // that is gone, and the next ones should not wait out an interval: a bring-up
    // that has just ended is exactly when somebody is looking for the port.
    //
    // Only while armed. An unarmed watch does nothing in the background — every test
    // builds a `System`, and a reading scheduled off a start would land after the
    // test had closed its store.
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

  /** Arm the timer. Idempotent, and `unref`'d so it never holds the process open by itself. */
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

  /** One reading, now. Re-entrant callers share the one in flight. */
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
    // Asked with the checkout as well as the pid, and answerable from either — so a
    // run whose session this harness no longer holds still reports its ports, which
    // is the state a restart leaves and the one an operator most wants read.
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

  /** The clone's answer, or null when it threw — recorded once per distinct failure. */
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
      // Once per distinct failure, `PlanReconciler.maybeFetch`'s rule: a clone with
      // no `origin` would otherwise say so every minute.
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

/** The readings as a string, with the timestamps left out: a reading that only got older has not changed. */
function comparable(readings: LocalRunReadings): string {
  return JSON.stringify(readings, (key, value: unknown) => (key === 'checkedAt' ? undefined : value));
}

/**
 * The host and port `localRun.url` names, or null when there is no URL or it has
 * no port to probe. An IPv6 literal loses its brackets, which is what `net.connect`
 * wants. A URL that will not parse is not an error worth recording every ten
 * seconds; the reading says nothing was declared, and the link beside it is what an
 * operator sees is wrong.
 */
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
