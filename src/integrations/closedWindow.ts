// → docs/spec/15-integrations.md

export interface ClosedPrSweep {
  readClosedSweep(): string | null;
  recordClosedSweep(sweptTo: string): void;
}

export function closedReadSince(nowMs: number, windowMs: number, sweptTo: string | null, catchUpMs: number): string {
  const window = nowMs - windowMs;
  const floor = nowMs - Math.max(catchUpMs, windowMs);
  const mark = sweptTo === null ? NaN : Date.parse(sweptTo);
  const since = Number.isNaN(mark) ? window : Math.min(window, mark);
  return new Date(Math.max(since, floor)).toISOString();
}

export function withinClosedWindow(closedAt: string | null | undefined, since: string): closedAt is string {
  return closedAt !== null && closedAt !== undefined && closedAt >= since;
}
