import type { ErrorRecorder } from './errorLog.js';
import { cycleRan, type CycleReport } from './harness.js';

// → docs/spec/04-harness-cycle.md

const DEBOUNCE_MS = 250;

const RETRY_MS = 1_000;
const MAX_RETRIES = 10;

interface CycleTriggerOptions {
  debounceMs?: number;
  minGapMs?: number;
}

interface CycleTriggerDeps extends CycleTriggerOptions {
  run: () => Promise<CycleReport>;
  ready: () => boolean;
  errors: ErrorRecorder;
  now?: () => number;
}

export class CycleTrigger {
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;
  private lastFiredAt: number | null = null;

  constructor(private readonly deps: CycleTriggerDeps) {}

  request(): void {
    this.attempts = 0;
    this.arm(this.deps.debounceMs ?? DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    if (this.stopped || this.timer) return;
    const now = (this.deps.now ?? Date.now)();
    const floor = this.lastFiredAt === null ? 0 : this.lastFiredAt + (this.deps.minGapMs ?? 0) - now;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.fire();
      },
      Math.max(delayMs, floor),
    );
    this.timer.unref();
  }

  private async fire(): Promise<void> {
    if (this.stopped || !this.deps.ready()) return;
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
      this.deps.errors.record({
        source: 'cycle',
        message: `A cycle could not be started: ${(err as Error).message}`,
        detail: (err as Error).stack ?? null,
      });
    }
  }
}
