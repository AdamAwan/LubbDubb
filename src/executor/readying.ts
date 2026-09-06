import { EventEmitter } from 'node:events';
import type { ReadyingAction, ReadyingStep } from '../types.js';

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

  pickUp(entry: Omit<ReadyingAction, 'id' | 'step' | 'startedAt'>): ReadyingHold {
    const id = `${entry.cycleId}#${(this.seq += 1)}`;
    this.rows.set(id, { ...entry, id, step: 'picked-up', startedAt: new Date().toISOString() });
    this.emit('changed');
    return {
      at: (step) => {
        const row = this.rows.get(id);
        if (row === undefined) return;
        this.rows.set(id, { ...row, step });
        this.emit('changed');
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
