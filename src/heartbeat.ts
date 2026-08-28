/**
 * The pulse. A bare timer that fires a callback, then asks how long to wait
 * before the next one. Kept deliberately dumb — it knows nothing about dispatch,
 * and nothing about what makes a fleet busy — so the cycle logic stays testable
 * without waiting on wall-clock time. Cycles can also be triggered immediately
 * (e.g. when an event is injected) via {@link Heartbeat.trigger}.
 *
 * `intervalMs` is a **thunk**, and that is the whole of the adaptive cadence here:
 * a `setInterval` fixes its period at `start()`, so a harness that decided to slow
 * down would have had to stop and restart the timer, and every path that forgot to
 * would silently keep the old one. Re-arming with a fresh reading after each fire
 * has no such path. → `docs/spec/04-harness-cycle.md#the-adaptive-cadence`
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly intervalMs: () => number,
    private readonly onTick: (source: 'timer' | 'manual') => Promise<void> | void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.arm();
    // Node timers keep the process alive; that's what we want for an always-on server.
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Fire a cycle right now (e.g. an event was injected). Coalesces re-entrancy. */
  async trigger(): Promise<void> {
    await this.fire('manual');
  }

  private arm(): void {
    if (this.stopped) return;
    // Read at arming time, so the interval a cycle's own outcome chose is the one
    // the next wait uses.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire('timer').finally(() => this.arm());
    }, this.intervalMs());
  }

  private async fire(source: 'timer' | 'manual'): Promise<void> {
    if (this.running) return; // never overlap cycles
    this.running = true;
    try {
      await this.onTick(source);
    } finally {
      this.running = false;
    }
  }
}
