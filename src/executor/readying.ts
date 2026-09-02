import { EventEmitter } from 'node:events';
import type { ReadyingAction, ReadyingStep } from '../types.js';

interface ReadyingEvents {
  /** The list moved: an action was picked up, changed step, or was let go. */
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
  /** Say what the executor has moved on to. A no-op once released. */
  at(step: ReadyingStep): void;
  /** Take the row off the board. Idempotent, because it is called from a `finally`. */
  release(): void;
}

/**
 * What the executor is working on that is not an agent yet.
 *
 * **Why it exists.** `ActionExecutor.execute` walks a plan strictly serially, and
 * each dispatch awaits its worktree before it spawns. Where the slot it gets is
 * checked out on another branch that await is a `git clean -ffdx` and a cold
 * checkout — [09](../../docs/spec/09-execution.md#handing-a-slot-over) — which on
 * a large target repository is minutes. A cycle that planned three dispatches with
 * full headroom therefore started them minutes apart, and in between the cockpit
 * said one agent was out and the queue said all three had been dispatched. The
 * work was happening; there was nowhere for it to be seen. This is that place.
 *
 * **In memory, deliberately.** The record's whole lifetime is one stack frame:
 * every entry here has a live `await` behind it in this process, and the moment
 * the process is gone so is the truth the row asserted. A table would outlive it —
 * a crash mid-dispatch would leave a row nothing ever clears, drawn as work in
 * flight forever, and the recovery desk would have a second kind of orphan to
 * learn about. The trade is that a restart loses the readings, which costs
 * nothing: the actions they described died with the process too, and the pulse
 * that follows re-plans them.
 *
 * **Nothing here counts as a slot.** The board is not consulted by the cap, by
 * `countLiveAgents`, or by any dispatch gate — it is a reading and only a reading.
 * The gate that keeps two agents out of one directory stays the worktree lease
 * ([09](../../docs/spec/09-execution.md#the-lease)).
 */
export class ReadyingBoard extends EventEmitter {
  /** Insertion-ordered, which is the order the executor picked the actions up. */
  private readonly rows = new Map<string, ReadyingAction>();
  private seq = 0;

  override emit<K extends keyof ReadyingEvents>(event: K, ...args: ReadyingEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ReadyingEvents>(event: K, listener: (...args: ReadyingEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Put an action on the board, on `picked-up`, and hand back the way off it.
   *
   * The id is minted here rather than taken from the caller so that two actions
   * of one cycle that describe the same work — a plan may carry both — cannot
   * collide and silently draw as one row.
   */
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

  /** Every action in hand, oldest first. */
  list(): ReadyingAction[] {
    return [...this.rows.values()];
  }
}
