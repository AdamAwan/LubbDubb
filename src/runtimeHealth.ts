import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { ErrorRecorder } from './errorLog.js';
import type { ReadObserver } from './store/context.js';
import type { EventLoopWindow, RuntimeHealthReading, SlowRead } from './types.js';

// → docs/spec/18-observability.md#the-runtime-watch

/** The part of `perf_hooks`' `IntervalHistogram` the watch reads. Values are nanoseconds. */
export interface LoopDelaySampler {
  enable(): unknown;
  disable(): unknown;
  reset(): void;
  percentile(p: number): number;
  readonly mean: number;
  readonly max: number;
}

export const RUNTIME_THRESHOLDS = {
  windowMs: 30_000,
  lagP99Ms: 1_000,
  stallMs: 5_000,
  slowReadMs: 250,
  quietMs: 15 * 60_000,
  keptSlowReads: 20,
} as const;

const NS_PER_MS = 1e6;

/** Tallies store reads over the threshold; built before the store, drained by the watch. */
export class SlowReadTally implements ReadObserver {
  private pending = new Map<string, { count: number; maxMs: number }>();

  constructor(readonly now: () => number = performance.now.bind(performance)) {}

  read(sql: string, ms: number): void {
    if (ms < RUNTIME_THRESHOLDS.slowReadMs) return;
    const key = statementKey(sql);
    const held = this.pending.get(key);
    if (held === undefined) this.pending.set(key, { count: 1, maxMs: ms });
    else {
      held.count += 1;
      held.maxMs = Math.max(held.maxMs, ms);
    }
  }

  drain(): Map<string, { count: number; maxMs: number }> {
    const out = this.pending;
    this.pending = new Map();
    return out;
  }
}

interface Group {
  lastRecordedAt: number;
  suppressed: number;
}

export class RuntimeHealthWatch {
  private readonly thresholds = RUNTIME_THRESHOLDS;
  private readonly sampler: LoopDelaySampler;
  private readonly clock: () => number;
  private readonly groups = new Map<string, Group>();
  private readonly slowReads = new Map<string, SlowRead>();
  private latest: EventLoopWindow | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      errors: ErrorRecorder;
      reads: SlowReadTally;
      sampler?: LoopDelaySampler;
      clock?: () => number;
    },
  ) {
    this.sampler = deps.sampler ?? monitorEventLoopDelay({ resolution: 20 });
    this.clock = deps.clock ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.sampler.enable();
    this.timer = setInterval(() => this.tick(), this.thresholds.windowMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.sampler.disable();
  }

  tick(): void {
    const now = this.clock();
    const window = this.closeWindow(now);
    if (window !== null) {
      this.latest = window;
      this.judgeLag(window, now);
    }
    for (const [sql, { count, maxMs }] of this.deps.reads.drain()) this.judgeRead(sql, count, maxMs, now);
  }

  reading(): RuntimeHealthReading {
    return {
      eventLoop: this.latest,
      slowReads: [...this.slowReads.values()].reverse(),
    };
  }

  private closeWindow(now: number): EventLoopWindow | null {
    const s = this.sampler;
    const max = s.max;
    if (!Number.isFinite(max) || max <= 0) {
      s.reset();
      return null;
    }
    const window: EventLoopWindow = {
      at: new Date(now).toISOString(),
      windowMs: this.thresholds.windowMs,
      meanMs: ms(s.mean),
      p50Ms: ms(s.percentile(50)),
      p99Ms: ms(s.percentile(99)),
      maxMs: ms(max),
    };
    s.reset();
    return window;
  }

  private judgeLag(w: EventLoopWindow, now: number): void {
    const t = this.thresholds;
    if (w.p99Ms < t.lagP99Ms && w.maxMs < t.stallMs) return;
    this.recordGrouped('event-loop', now, (suppressed) => ({
      message: `the event loop was blocked: longest stall ${fmt(w.maxMs)} ms, p99 ${fmt(w.p99Ms)} ms over ${fmt(w.windowMs / 1000)} s`,
      detail: [
        `mean ${fmt(w.meanMs)} ms, p50 ${fmt(w.p50Ms)} ms, p99 ${fmt(w.p99Ms)} ms, max ${fmt(w.maxMs)} ms`,
        `thresholds: p99 ≥ ${fmt(t.lagP99Ms)} ms or any stall ≥ ${fmt(t.stallMs)} ms`,
        ...suppressedLine(suppressed, 'blocked window'),
      ].join('\n'),
    }));
  }

  private judgeRead(sql: string, count: number, maxMs: number, now: number): void {
    const held = this.slowReads.get(sql);
    this.slowReads.delete(sql);
    this.slowReads.set(sql, {
      sql,
      count: (held?.count ?? 0) + count,
      maxMs: Math.max(held?.maxMs ?? 0, round(maxMs)),
      lastAt: new Date(now).toISOString(),
    });
    if (this.slowReads.size > this.thresholds.keptSlowReads) {
      const oldest = this.slowReads.keys().next().value;
      if (oldest !== undefined) this.slowReads.delete(oldest);
    }
    this.recordGrouped(`read:${sql}`, now, (suppressed) => ({
      message: `a store read took ${fmt(maxMs)} ms: ${sql}`,
      detail: [
        `${count} read${count === 1 ? '' : 's'} of this statement over ${fmt(this.thresholds.slowReadMs)} ms in the last window`,
        ...suppressedLine(suppressed, 'slow read'),
      ].join('\n'),
    }));
  }

  private recordGrouped(
    key: string,
    now: number,
    entry: (suppressed: number) => { message: string; detail: string },
  ): void {
    const group = this.groups.get(key);
    if (group !== undefined && now - group.lastRecordedAt < this.thresholds.quietMs) {
      group.suppressed += 1;
      return;
    }
    this.deps.errors.record({ source: 'runtime', ...entry(group?.suppressed ?? 0) });
    this.groups.set(key, { lastRecordedAt: now, suppressed: 0 });
  }
}

function suppressedLine(suppressed: number, what: string): string[] {
  return suppressed === 0 ? [] : [`${suppressed} more ${what}${suppressed === 1 ? '' : 's'} since the last entry`];
}

const KEY_LENGTH = 200;

function statementKey(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > KEY_LENGTH ? `${flat.slice(0, KEY_LENGTH)}…` : flat;
}

function ms(ns: number): number {
  return round(ns / NS_PER_MS);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function fmt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
