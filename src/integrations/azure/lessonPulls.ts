import { isLessonBranch } from '../../lessons/lessonOrigin.js';
import type { LessonPullRequest } from '../../types.js';
import type { AzureDevOpsApi } from './azureDevOpsApi.js';

// → docs/spec/41-repo-lessons.md#across-fleets

export async function listAzureLessonPulls(api: AzureDevOpsApi, since: string): Promise<LessonPullRequest[]> {
  const [active, closed] = await Promise.all([api.listActivePullRequests(), api.listRecentlyClosedPullRequests(since)]);
  return [
    ...active
      .filter((p) => isLessonBranch(p.branch))
      .map((p): LessonPullRequest => ({
        number: p.pullRequestId,
        branch: p.branch,
        url: p.url,
        state: 'open',
        closedAt: null,
      })),
    ...closed
      .filter((p) => isLessonBranch(p.branch))
      .map((p): LessonPullRequest => ({
        number: p.pullRequestId,
        branch: p.branch,
        url: p.url,
        state: p.merged ? 'merged' : 'closed',
        closedAt: p.closedAt,
      })),
  ];
}
