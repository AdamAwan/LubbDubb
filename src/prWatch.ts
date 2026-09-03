import { isHarnessBranch, isSomeoneElsesPr } from './prOwnership.js';
import { prState } from './prHealth.js';
import { isWatched } from './watchLabels.js';
import type { PullRequest } from './types.js';

/** One pull request to tag, and the branch that says it is the harness's own. */
export interface PrWatchSeed {
  prNumber: number;
  branch: string;
}

interface PrWatchContext {
  /** `${labelPrefix}-watch`. Empty = the gate is off, and nothing is ever tagged. */
  watchLabel: string;
  /**
   * The retired `${labelPrefix}-ignore` tag, honoured here and nowhere else.
   *
   * The harness stopped reading it when watching went two-valued, and an item
   * carrying it lands on the right behaviour by itself: no watch tag, so nothing is
   * worked. That holds everywhere except *here* — this is the one path that would
   * put the tag back on and wake the fleet on a pull request somebody explicitly
   * parked. So the seeding skips it, which is what makes "leave the old labels
   * alone" true rather than merely mostly true.
   */
  legacyIgnoreLabel: string;
  /** Pull requests already seeded, from `pr_watch_seeds`. The read lives in the desk so this stays pure. */
  seeded: ReadonlySet<number>;
}

/**
 * Which open pull requests the harness should tag as its own work.
 *
 * Pull requests are opt-in like issues are ([`src/watchLabels.ts`]), which alone
 * would mean the harness stops acting on the very pull requests it opened. This is
 * the other half: a pull request on a branch only a dispatch cuts is the harness's
 * work by construction, so the harness tags it — programmatically, on the pulse,
 * with nothing asked of an operator and nothing asked of an agent.
 *
 * **Once per pull request, and the `pr_watch_seeds` row is what makes it once.**
 * Removing the tag is how an operator takes a runaway agent's pull request off the
 * fleet, and a seeder that re-derived its answer from the world alone would put the
 * tag straight back on the next pulse — a control that silently undoes itself. The
 * row is therefore not an optimisation; it is the whole of why un-watching sticks.
 *
 * Pure, and a lens's opposite in {@link reapableBranches}' sense: nothing in
 * `src/dispatcher/` reads it, but it drives writes through {@link PrWatchDesk}.
 */
export function prsToSeedWatch(openPrs: PullRequest[], ctx: PrWatchContext): PrWatchSeed[] {
  if (!ctx.watchLabel) return [];
  const out: PrWatchSeed[] = [];
  for (const pr of openPrs) {
    if (prState(pr) !== 'open') continue;
    if (!isHarnessBranch(pr.branch)) continue;
    // A branch shape is evidence, not proof: on a shared repository a colleague's
    // pull request can sit on `issue/12` too, and tagging that one would opt the
    // fleet into their work — the exact thing the watch tag exists to stop. Where
    // the provider names an author, it outranks the shape.
    if (isSomeoneElsesPr(pr)) continue;
    if (ctx.seeded.has(pr.number)) continue;
    if (isWatched(pr.labels, ctx.watchLabel)) continue;
    if (ctx.legacyIgnoreLabel && (pr.labels ?? []).includes(ctx.legacyIgnoreLabel)) continue;
    out.push({ prNumber: pr.number, branch: pr.branch });
  }
  return out;
}
