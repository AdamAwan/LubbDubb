import type { ListenClock } from './listener.js';

/** A clock a test moves by hand: `advance` runs every timer that falls due, in order. */
export class FakeListenClock implements ListenClock {
  private at: number;
  private timers: { due: number; fn: () => void; live: boolean }[] = [];

  constructor(start = Date.parse('2026-01-01T00:00:00.000Z')) {
    this.at = start;
  }

  now(): number {
    return this.at;
  }

  after(ms: number, fn: () => void): () => void {
    const timer = { due: this.at + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  advance(ms: number): void {
    const until = this.at + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.live && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (next === undefined) break;
      next.live = false;
      this.at = next.due;
      next.fn();
    }
    this.at = until;
    this.timers = this.timers.filter((t) => t.live);
  }
}
