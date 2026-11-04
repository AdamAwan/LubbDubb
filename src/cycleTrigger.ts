import type { ErrorRecorder } from './errorLog.js';
import { cycleRan, type CycleReport } from './harness.js';

// → docs/spec/04-harness-cycle.md

const DEBOUNCE_MS = 250;

const RETRY_MS = 1_000;
const MAX_RETRIES = 10;

interface CycleTriggerDeps {
  run: () => Promise<CycleReport>;
  ready: () => boolean;
  errors: ErrorRecorder;
}

export class CycleTrigger {
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(private readonly deps: CycleTriggerDeps) {}

  request(): void {
    this.attempts = 0;
    this.arm(DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, delayMs);
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
      this.deps.errors.record({
        source: 'cycle',
        message: `A cycle could not be started: ${(err as Error).message}`,
        detail: (err as Error).stack ?? null,
      });
    }
  }
}
