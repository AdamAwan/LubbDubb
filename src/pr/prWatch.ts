import { isHarnessBranch, isSomeoneElsesPr } from './prOwnership.js';
import { prState } from './prHealth.js';
import { isWatched } from '../watchLabels.js';
import type { PullRequest } from '../types.js';

// → docs/spec/07-pull-requests.md

export interface PrWatchSeed {
  prNumber: number;
  branch: string;
}

interface PrWatchContext {
  watchLabel: string;
  legacyIgnoreLabel: string;
  seeded: ReadonlySet<number>;
}

export function prsToSeedWatch(openPrs: PullRequest[], ctx: PrWatchContext): PrWatchSeed[] {
  if (!ctx.watchLabel) return [];
  const out: PrWatchSeed[] = [];
  for (const pr of openPrs) {
    if (prState(pr) !== 'open') continue;
    if (!isHarnessBranch(pr.branch)) continue;
    if (isSomeoneElsesPr(pr)) continue;
    if (ctx.seeded.has(pr.number)) continue;
    if (isWatched(pr.labels, ctx.watchLabel)) continue;
    if (ctx.legacyIgnoreLabel && (pr.labels ?? []).includes(ctx.legacyIgnoreLabel)) continue;
    out.push({ prNumber: pr.number, branch: pr.branch });
  }
  return out;
}
