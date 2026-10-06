import type { ErrorRecorder } from '../../errorLog.js';
import { sameIdentity } from '../../pr/prOwnership.js';
import type { WatchedBots } from '../watchedBots.js';
import type { AzPull, AzureDevOpsApi } from './azureDevOpsApi.js';
import { viewerAssignment } from './reviewers.js';

// → docs/spec/15-integrations.md#what-a-snapshot-is-scoped-to

export interface ViewerScopeDeps {
  api: AzureDevOpsApi;
  prAuthor?: string;
  bots: WatchedBots;
  /** Last labels read per bot PR, kept across snapshots so a failed read falls back rather than drops. */
  knownLabels: Map<number, string[]>;
  errors?: ErrorRecorder;
}

export async function scopeToViewer(
  active: AzPull[],
  deps: ViewerScopeDeps,
): Promise<{ pulls: AzPull[]; labelsRead: Map<number, string[]> }> {
  const { api, prAuthor, bots, knownLabels, errors } = deps;
  const labelsRead = new Map<number, string[]>();
  if (!prAuthor) return { pulls: active, labelsRead };
  const own = (p: AzPull): boolean =>
    sameIdentity(p.authorUniqueName, prAuthor) || viewerAssignment(p.reviewers, prAuthor) !== undefined;
  const candidates = active.filter((p) => !own(p) && isAzBot(p, bots));
  await Promise.all(
    candidates.map(async ({ pullRequestId: id }) => {
      try {
        knownLabels.set(id, await api.listPullLabels(id));
      } catch (err) {
        errors?.record({
          source: 'provider',
          message: `could not read the labels of bot PR !${id}: ${(err as Error).message}`,
        });
      }
      const labels = knownLabels.get(id);
      if (labels !== undefined) labelsRead.set(id, labels);
    }),
  );
  const candidateIds = new Set(candidates.map((p) => p.pullRequestId));
  for (const id of knownLabels.keys()) if (!candidateIds.has(id)) knownLabels.delete(id);
  const pulls = active.filter((p) => {
    if (own(p)) return true;
    const labels = labelsRead.get(p.pullRequestId);
    return labels !== undefined && bots.watched(labels);
  });
  return { pulls, labelsRead };
}

export function isAzBot(p: AzPull, bots: WatchedBots): boolean {
  return bots.isBot(p.authorUniqueName, p.authorDisplayName);
}
