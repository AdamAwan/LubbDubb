import type { PrBaseInput } from './sink/actionSink.js';
import type { PullRequest } from './types.js';
import { prState } from './prHealth.js';

/**
 * Retarget the rung above a merged one.
 *
 * **This exists because the assumption written into `isStackedPr` is only half
 * true.** That predicate holds a stacked PR back from merging on the grounds that
 * "stacked children wait for the provider to retarget them when their parent
 * merges" — which GitHub does and **Azure does not**. On Azure a rung whose parent
 * merged keeps targeting a branch that no longer receives anything: `isStackedPr`
 * goes on holding it back from the merge rule, so the rest of the stack simply
 * stops, with nothing anywhere saying why.
 *
 * Idempotent by construction: a PR already targeting the right branch yields no
 * input at all, so the common case costs one comparison and no writes. Doing it on
 * GitHub too is deliberate — the write is a no-op there, and a provider-conditional
 * would be a second answer to "who retargets" living nowhere near the one that
 * matters.
 */
export function retargetsFor(openPrs: PullRequest[], closedPrs: PullRequest[], defaultBranch: string): PrBaseInput[] {
  // Only merged parents retarget their children. A PR that was *abandoned* leaves
  // the rung above it stranded on purpose: the work beneath it never landed, so
  // rebasing onto the default branch would silently drop the premise it was built
  // on. That is a human's call, and `prState` never invents `closed` from absence.
  const mergedByBranch = new Map<string, PullRequest>();
  for (const pr of closedPrs) {
    if (prState(pr) === 'merged') mergedByBranch.set(pr.branch, pr);
  }
  if (mergedByBranch.size === 0) return [];

  const out: PrBaseInput[] = [];
  for (const pr of openPrs) {
    if (pr.merged || pr.baseBranch === undefined) continue;
    const parent = mergedByBranch.get(pr.baseBranch);
    if (!parent) continue;
    // The merged parent's own base is where this rung belongs — which is the
    // default branch for a two-deep stack, and the next rung down for a taller one.
    const target = parent.baseBranch ?? defaultBranch;
    if (target !== pr.baseBranch) out.push({ prNumber: pr.number, base: target });
  }
  return out;
}
