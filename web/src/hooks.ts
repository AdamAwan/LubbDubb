import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribeThemeUnsaved, themeUnsaved } from './cockpit/theme.js';

// → docs/spec/17-cockpit.md

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useThemeUnsaved(): boolean {
  return useSyncExternalStore(subscribeThemeUnsaved, themeUnsaved, themeUnsaved);
}

interface PollState<T> {
  reading: T | null;
  failed: boolean;
}

/** One reading per loader, fetched while anything is mounted on it and dropped to idle when nothing is. */
class Poller<T> {
  state: PollState<T> = { reading: null, failed: false };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly intervalMs: number,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.reload();
      this.timer = setInterval(this.reload, this.intervalMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0 || this.timer === null) return;
      clearInterval(this.timer);
      this.timer = null;
    };
  };

  readonly reload = (): void => {
    this.load().then(
      (reading) => this.set({ reading, failed: false }),
      () => this.set({ reading: this.state.reading, failed: true }),
    );
  };

  readonly snapshot = (): PollState<T> => this.state;

  private set(state: PollState<T>): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

const pollers = new Map<() => Promise<unknown>, Poller<unknown>>();

/**
 * A reading fetched on mount and every `intervalMs` after. Every mount handed the same `load` shares
 * one poll, so a page and the badges that read the same route make one request between them.
 */
export function usePolled<T>(load: () => Promise<T>, intervalMs: number): PollState<T> & { reload: () => void } {
  let poller = pollers.get(load) as Poller<T> | undefined;
  if (poller === undefined) {
    poller = new Poller(load, intervalMs);
    pollers.set(load, poller as Poller<unknown>);
  }
  const state = useSyncExternalStore(poller.subscribe, poller.snapshot, poller.snapshot);
  return { ...state, reload: poller.reload };
}
