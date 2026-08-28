import type { ErrorRecorder } from './errorLog.js';
import { cycleRan, type CycleReport } from './harness.js';

/**
 * How long a request waits before the cycle fires.
 *
 * An agent's ending arrives as up to two events — `done` when the row reaches its
 * terminal, `reaped` when the process it held has actually exited — and a fleet
 * winding down produces several agents' worth of both within the same millisecond.
 * The delay is what turns that burst into one cycle. A quarter of a second is well
 * under anything an operator perceives and comfortably wider than the gap between
 * two events about the same ending, which is the interval that has to be absorbed;
 * the coalescing guard in `Harness.runCycle` mops up whatever still overlaps.
 *
 * A constant rather than a config key on purpose: the cadence layer is stage 3's,
 * and a knob here would be one it has to take back.
 */
const DEBOUNCE_MS = 250;

/**
 * How long to wait before trying again after a **refused** cycle, and how many
 * times.
 *
 * A refusal is not a failure — a real cycle is in flight, or the recovery hold is
 * up — but it means the slot the agent just freed is still empty, which is the whole
 * thing this exists to fix. Retrying gives it back within a second or two of the
 * blocker clearing instead of at the next heartbeat. Bounded, because the recovery
 * hold stands until a person answers it: after ten attempts the trigger gives up and
 * the heartbeat is the backstop again, exactly as it was before this existed.
 */
const RETRY_MS = 1_000;
const MAX_RETRIES = 10;

interface LocalCycleDeps {
  /** Runs one local cycle — `harness.runCycle('local')`, wired in the composition root. */
  run: () => Promise<CycleReport>;
  /**
   * Is there still a harness to cycle? False once the store handle is closed, which
   * is a system on its way down — and the one state a timer can land in that a call
   * cannot: a cycle fired into a closed store throws from inside a `void` call,
   * where the error path itself is a store write and throws again.
   */
  ready: () => boolean;
  errors: ErrorRecorder;
}

/**
 * Fires a **local** cycle shortly after something inside the harness frees capacity
 * — today, an agent reaching a terminal state.
 *
 * The latency it removes is the whole reason it exists: nothing used to react to an
 * agent finishing, so its slot sat unused until the next beat (five minutes on the
 * default deployment). A local cycle reads no world, so reacting costs a store pass
 * and no provider traffic, which is what makes it affordable on an event rather than
 * on a clock. → `docs/spec/04-harness-cycle.md#the-local-cycle`
 */
export class LocalCycleTrigger {
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(private readonly deps: LocalCycleDeps) {}

  /** Something freed capacity; run a local cycle once the burst has settled. */
  request(): void {
    // A fresh request is a fresh reason to cycle, so the retry budget starts over —
    // otherwise a long recovery hold early on would leave the trigger spent for the
    // rest of the process's life.
    this.attempts = 0;
    this.arm(DEBOUNCE_MS);
  }

  /** Stop firing. Called on shutdown, above everything that can start an agent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    if (this.stopped || this.timer) return; // one pending fire at a time; the burst is the point
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, delayMs);
    // Never hold the process open for a pulse that is only ever an optimisation:
    // the heartbeat is what keeps an always-on server alive, and a test that ends
    // with a retry pending must not wait it out.
    this.timer.unref();
  }

  private async fire(): Promise<void> {
    if (this.stopped || !this.deps.ready()) return;
    try {
      const report = await this.deps.run();
      if (cycleRan(report)) return;
      if (++this.attempts >= MAX_RETRIES) return;
      this.arm(RETRY_MS);
    } catch (err) {
      // `runCycle` records its own failures and returns rather than throwing, so
      // reaching here means the wiring itself broke — which must still be visible
      // rather than a trigger that has quietly stopped triggering.
      this.deps.errors.record({
        source: 'cycle',
        message: `A local cycle could not be started: ${(err as Error).message}`,
        detail: (err as Error).stack ?? null,
      });
    }
  }
}
