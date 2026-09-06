// → docs/spec/15-integrations.md

export function closedWindowStart(nowMs: number, windowMs: number): string {
  return new Date(nowMs - windowMs).toISOString();
}

export function withinClosedWindow(closedAt: string | null | undefined, since: string): closedAt is string {
  return closedAt !== null && closedAt !== undefined && closedAt >= since;
}
