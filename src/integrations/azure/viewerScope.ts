import type { ErrorRecorder } from '../../errorLog.js';
import { sameIdentity } from '../../pr/prOwnership.js';
import type { WatchedBots } from '../watchedBots.js';
import type { AzPull, AzureDevOpsApi } from './azureDevOpsApi.js';
import { viewerAssignment } from './reviewers.js';

// → docs/spec/15-integrations.md#what-a-snapshot-is-scoped-to

export interface ViewerScope {
  pulls: AzPull[];
  labelsRead: Map<number, string[]>;
}

export async function scopeToViewer(
  api: AzureDevOpsApi,
  active: AzPull[],
  prAuthor: string | undefined,
  bots: WatchedBots,
  errors?: ErrorRecorder,
): Promise<ViewerScope> {
  const labelsRead = new Map<number, string[]>();
  if (!prAuthor) return { pulls: active, labelsRead };
  const own = (p: AzPull): boolean =>
    sameIdentity(p.authorUniqueName, prAuthor) || viewerAssignment(p.reviewers, prAuthor) !== undefined;
  await Promise.all(
    active
      .filter((p) => !own(p) && isAzBot(p, bots))
      .map(async (p) => {
        try {
          labelsRead.set(p.pullRequestId, await api.listPullLabels(p.pullRequestId));
        } catch (err) {
          errors?.record({
            source: 'provider',
            message: `could not read the labels of bot PR !${p.pullRequestId}: ${(err as Error).message}`,
          });
        }
      }),
  );
  const pulls = active.filter(
    (p) => own(p) || (labelsRead.has(p.pullRequestId) && bots.watched(labelsRead.get(p.pullRequestId))),
  );
  return { pulls, labelsRead };
}

export function isAzBot(p: AzPull, bots: WatchedBots): boolean {
  return bots.isBot(p.authorUniqueName, p.authorDisplayName);
}
