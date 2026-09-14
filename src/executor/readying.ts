import { EventEmitter } from 'node:events';
import type { ReadyingAction, ReadyingStep, ReadyingStepTiming } from '../types.js';

// → docs/spec/09-execution.md

interface ReadyingEvents {
  changed: [];
}

/**
 * The one thing that has to be true of every entry: it leaves.
 *
 * A handle rather than an id the caller passes back, so the release is impossible
 * to address at the wrong row — and so `finally { hold.release(); }` is the whole
 * of what a call site has to remember.
 *
 * @public — the seam {@link ActionExecutor} holds an entry through.
 */
export interface ReadyingHold {
  at(step: ReadyingStep): void;
  timings(): ReadyingStepTiming[];
  release(): void;
}

export class ReadyingBoard extends EventEmitter {
  private readonly rows = new Map<string, ReadyingAction>();
  private seq = 0;

  override emit<K extends keyof ReadyingEvents>(event: K, ...args: ReadyingEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ReadyingEvents>(event: K, listener: (...args: ReadyingEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  pickUp(entry: Omit<ReadyingAction, 'id' | 'step' | 'startedAt' | 'stepStartedAt' | 'elapsed'>): ReadyingHold {
    const id = `${entry.cycleId}#${(this.seq += 1)}`;
    const startedAt = new Date().toISOString();
    const done: ReadyingStepTiming[] = [];
    let mark = Date.now();
    this.rows.set(id, { ...entry, id, step: 'picked-up', startedAt, stepStartedAt: startedAt, elapsed: [] });
    this.emit('changed');
    return {
      at: (step) => {
        const row = this.rows.get(id);
        if (row === undefined) return;
        const now = Date.now();
        done.push({ step: row.step, ms: now - mark });
        mark = now;
        this.rows.set(id, { ...row, step, stepStartedAt: new Date(now).toISOString(), elapsed: [...done] });
        this.emit('changed');
      },
      timings: () => {
        const row = this.rows.get(id);
        return row === undefined ? [...done] : [...done, { step: row.step, ms: Date.now() - mark }];
      },
      release: () => {
        if (!this.rows.delete(id)) return;
        this.emit('changed');
      },
    };
  }

  list(): ReadyingAction[] {
    return [...this.rows.values()];
  }
}

/**
 * The readying board is in memory and a row is gone the moment the action leaves it, so the only
 * place a finished wait can be read back is the decision the executor audits. This renders one.
 *
 * @public — read by {@link ActionExecutor} for the decision detail.
 */
export function readyingBreakdown(timings: ReadyingStepTiming[]): string {
  const waits = timings.filter((t) => t.ms >= REPORTABLE_MS);
  if (waits.length === 0) return '';
  const total = timings.reduce((sum, t) => sum + t.ms, 0);
  return ` Readied in ${duration(total)} (${waits.map((t) => `${t.step} ${duration(t.ms)}`).join(', ')}).`;
}

const REPORTABLE_MS = 100;

function duration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`;
}
