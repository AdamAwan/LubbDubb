import { sameIdentity } from '../../pr/prOwnership.js';
import type { WatchedBots } from '../watchedBots.js';
import type { AzPull } from './azureDevOpsApi.js';
import { viewerAssignment } from './reviewers.js';

// → docs/spec/15-integrations.md#what-a-snapshot-is-scoped-to

export function scopeToViewer(
  active: AzPull[],
  prAuthor: string | undefined,
  bots: WatchedBots,
): { pulls: AzPull[]; botOnly: Set<number> } {
  const botOnly = new Set<number>();
  if (!prAuthor) return { pulls: active, botOnly };
  const pulls = active.filter((p) => {
    if (sameIdentity(p.authorUniqueName, prAuthor) || viewerAssignment(p.reviewers, prAuthor) !== undefined)
      return true;
    if (!isAzBot(p, bots)) return false;
    botOnly.add(p.pullRequestId);
    return true;
  });
  return { pulls, botOnly };
}

export function isAzBot(p: AzPull, bots: WatchedBots): boolean {
  return bots.isBot(p.authorUniqueName, p.authorDisplayName ?? '');
}
