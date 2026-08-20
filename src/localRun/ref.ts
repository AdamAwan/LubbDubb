import type { PlanPart } from '../types.js';

/**
 * Which ref a goal's local run should check out.
 *
 * **The first unmerged part that has a branch, in plan order; otherwise null**,
 * which the caller reads as the integration branch.
 *
 * The rule is that shape because of what the two ends mean. A goal whose parts have
 * all merged *is* the integration branch — its code is in there, and checking out a
 * merged part's branch would show an older state than the one the goal delivered. A
 * goal still in flight has its work on a branch nothing has merged yet, and that is
 * the only place to see it. Plan order rather than "the newest": the parts are a
 * sequence somebody chose, and a stack's later part is built on its earlier one, so
 * the first unmerged one is the furthest back anybody would want to look — anything
 * ahead of it is not there yet.
 *
 * Pure, and separate from the runner, because it is the one decision in the feature
 * with more than one defensible answer: it is worth a test of its own rather than
 * being three lines inside a method that also spawns a process.
 */
export function localRunRef(parts: readonly PlanPart[]): string | null {
  const ordered = [...parts].sort((a, b) => a.seq - b.seq);
  for (const part of ordered) {
    // `merged` is in the integration branch already. `retired` was dropped by an
    // amendment and `concluded` produced a report rather than code — neither has a
    // branch worth looking at, and both can still carry one from before they got
    // there, which is exactly the stale checkout this skips.
    if (part.status === 'merged' || part.status === 'retired' || part.status === 'concluded') continue;
    if (part.branch !== null && part.branch !== '') return part.branch;
  }
  return null;
}
