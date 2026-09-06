// → docs/spec/04-harness-cycle.md

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
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire('timer').finally(() => this.arm());
    }, this.intervalMs());
  }

  private async fire(source: 'timer' | 'manual'): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.onTick(source);
    } finally {
      this.running = false;
    }
  }
}
