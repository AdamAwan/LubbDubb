/**
 * The pulse. A bare timer that fires a callback every `intervalMs`. Kept
 * deliberately dumb — it knows nothing about dispatch — so the cycle logic stays
 * testable without waiting on wall-clock time. Cycles can also be triggered
 * immediately (e.g. when an event is injected) via {@link Heartbeat.trigger}.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly onTick: (source: 'timer' | 'manual') => Promise<void> | void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.fire('timer'), this.intervalMs);
    // Node timers keep the process alive; that's what we want for an always-on server.
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Fire a cycle right now (e.g. an event was injected). Coalesces re-entrancy. */
  async trigger(): Promise<void> {
    await this.fire('manual');
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
