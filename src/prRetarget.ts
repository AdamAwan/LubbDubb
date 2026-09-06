import type { PrBaseInput } from './sink/actionSink.js';
import type { PullRequest } from './types.js';
import { prState } from './prHealth.js';

// → docs/spec/07-pull-requests.md

export function retargetsFor(openPrs: PullRequest[], closedPrs: PullRequest[], defaultBranch: string): PrBaseInput[] {
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
    const target = parent.baseBranch ?? defaultBranch;
    if (target !== pr.baseBranch) out.push({ prNumber: pr.number, base: target });
  }
  return out;
}
