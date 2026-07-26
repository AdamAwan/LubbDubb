/**
 * The provider-agnostic half of closed-PR visibility: how far back to look.
 *
 * Both real providers ask their API for "PRs closed since <t>" and both compute
 * <t> the same way, so it lives here rather than twice. Pure — the clock is the
 * caller's, which is what makes the window testable without waiting for one.
 */

/** The ISO instant a closed-PR lookup should start from, `windowMs` before `nowMs`. */
export function closedWindowStart(nowMs: number, windowMs: number): string {
  return new Date(nowMs - windowMs).toISOString();
}

/**
 * Is this PR inside the retention window? Providers filter server-side where the
 * API allows it, but the coarse filters they offer (GitHub sorts by *updated*,
 * Azure's time range is inclusive of the boundary page) let older rows through,
 * so the honest cut is applied here as well. A PR with no recorded close time is
 * dropped: it cannot be placed in the window, and a wrong "closed just now" is
 * worse than a missing row.
 */
export function withinClosedWindow(closedAt: string | null | undefined, since: string): closedAt is string {
  return closedAt !== null && closedAt !== undefined && closedAt >= since;
}
