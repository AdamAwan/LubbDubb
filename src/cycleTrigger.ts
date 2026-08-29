import type { ErrorRecorder } from './errorLog.js';
import { cycleRan, type CycleReport } from './harness.js';

/**
 * The default debounce: how long a request waits before the cycle fires.
 *
 * Sized for the trigger that came first. An agent's ending arrives as up to two
 * events — `done` when the row reaches its terminal, `reaped` when the process it
 * held has actually exited — and a fleet winding down produces several agents'
 * worth of both within the same millisecond. The delay is what turns that burst
 * into one cycle. A quarter of a second is well under anything an operator
 * perceives and comfortably wider than the gap between two events about the same
 * ending, which is the interval that has to be absorbed; the coalescing guard in
 * `Harness.runCycle` mops up whatever still overlaps.
 *
 * A constant rather than a config key on purpose: the cadence layer is stage 3's,
 * and a knob here would be one it has to take back. The ingress passes its own
 * numbers because the cycle it fires costs provider requests, which this one's
 * does not — see {@link CycleTriggerOptions.minGapMs}.
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

/** The two numbers that differ between the triggers, and nothing else does. */
interface CycleTriggerOptions {
  /** How long a burst is allowed to settle before the cycle fires. */
  debounceMs?: number;
  /**
   * The **floor** between two cycles this trigger fires — a request arriving inside
   * it is held until the floor is up rather than dropped.
   *
   * Zero for the local trigger, and deliberately: a local cycle reads no world, so
   * a burst of them costs a store pass each and there is nothing to ration. It is
   * not zero for the ingress trigger, whose cycle is a **real** one and spends
   * provider requests — without a floor, anyone who can post a verified delivery
   * decides how often this fleet talks to its provider.
   * → `docs/spec/30-ingress.md#what-a-delivery-is-allowed-to-cost`
   */
  minGapMs?: number;
}

interface CycleTriggerDeps extends CycleTriggerOptions {
  /** Runs one cycle — `harness.runCycle(source)`, wired in the composition root. */
  run: () => Promise<CycleReport>;
  /**
   * Is there still a harness to cycle? False once the store handle is closed, which
   * is a system on its way down — and the one state a timer can land in that a call
   * cannot: a cycle fired into a closed store throws from inside a `void` call,
   * where the error path itself is a store write and throws again.
   */
  ready: () => boolean;
  errors: ErrorRecorder;
  /** Injectable clock, so the floor is testable without waiting it out. */
  now?: () => number;
}

/**
 * Fires a debounced cycle when something asks for one out of band.
 *
 * Two things use it, and the difference between them is two numbers:
 *
 * - **The local trigger** fires shortly after something inside the harness frees
 *   capacity — today, an agent reaching a terminal state. The latency it removes is
 *   the whole reason it exists: nothing used to react to an agent finishing, so its
 *   slot sat unused until the next beat. A local cycle reads no world, so reacting
 *   costs a store pass and no provider traffic, which is what makes it affordable on
 *   an event rather than on a clock.
 *   → `docs/spec/04-harness-cycle.md#the-local-cycle`
 * - **The ingress trigger** fires a *real* cycle when a verified webhook says
 *   something in the world moved. That one reads the world, so it carries a floor.
 *   → `docs/spec/30-ingress.md#triggering-a-pulse`
 *
 * One class rather than two, because the interesting part is the same in both: one
 * pending fire at a time, so a burst is one cycle; a bounded retry, because a
 * refusal means the reason to cycle is still standing; and a timer that never holds
 * the process open, because a cycle out of band is only ever an optimisation.
 */
export class CycleTrigger {
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;
  private lastFiredAt: number | null = null;

  constructor(private readonly deps: CycleTriggerDeps) {}

  /** Something wants a cycle; run one once the burst has settled. */
  request(): void {
    // A fresh request is a fresh reason to cycle, so the retry budget starts over —
    // otherwise a long recovery hold early on would leave the trigger spent for the
    // rest of the process's life.
    this.attempts = 0;
    this.arm(this.deps.debounceMs ?? DEBOUNCE_MS);
  }

  /** Stop firing. Called on shutdown, above everything that can start an agent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    if (this.stopped || this.timer) return; // one pending fire at a time; the burst is the point
    // The floor is applied by *waiting longer*, never by dropping the request. A
    // dropped one is a reason to cycle that nothing will raise again — the delivery
    // that would have named it has already been answered `200` — and the fleet then
    // waits for the heartbeat with no sign anything was missed.
    const now = (this.deps.now ?? Date.now)();
    const floor = this.lastFiredAt === null ? 0 : this.lastFiredAt + (this.deps.minGapMs ?? 0) - now;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.fire();
      },
      Math.max(delayMs, floor),
    );
    // Never hold the process open for a pulse that is only ever an optimisation:
    // the heartbeat is what keeps an always-on server alive, and a test that ends
    // with a retry pending must not wait it out.
    this.timer.unref();
  }

  private async fire(): Promise<void> {
    if (this.stopped || !this.deps.ready()) return;
    // Read before the await, not after: the floor is a bound on how often a cycle
    // may *start*, and a slow cycle must not shorten the gap to the next one. Stamped
    // only for a cycle that actually ran — a refusal spent nothing, so rationing the
    // next attempt against it would ration a fleet that is not talking to anybody.
    const startedAt = (this.deps.now ?? Date.now)();
    try {
      const report = await this.deps.run();
      if (cycleRan(report)) {
        this.lastFiredAt = startedAt;
        return;
      }
      if (++this.attempts >= MAX_RETRIES) return;
      this.arm(RETRY_MS);
    } catch (err) {
      // `runCycle` records its own failures and returns rather than throwing, so
      // reaching here means the wiring itself broke — which must still be visible
      // rather than a trigger that has quietly stopped triggering.
      this.deps.errors.record({
        source: 'cycle',
        message: `A cycle could not be started: ${(err as Error).message}`,
        detail: (err as Error).stack ?? null,
      });
    }
  }
}
