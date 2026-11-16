import { DAY_MS } from '../primitives.js';

// → docs/spec/14-persistence.md#history-retention

/** A retention window in days, swept at most once a day. `0` or less keeps everything. */
export class DailySweep {
  private lastSweptAt: number | null = null;

  constructor(
    readonly days: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled(): boolean {
    return Number.isFinite(this.days) && this.days > 0;
  }

  /** Whether a sweep is owed now, and if so marks it taken. */
  due(): boolean {
    if (!this.enabled) return false;
    const now = this.now();
    if (this.lastSweptAt !== null && now - this.lastSweptAt < DAY_MS) return false;
    this.lastSweptAt = now;
    return true;
  }

  /** The instant before which history is past the window. */
  cutoff(): string {
    return new Date(this.now() - this.days * DAY_MS).toISOString();
  }
}
