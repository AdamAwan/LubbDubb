import { lessonPullsOf } from '../../lessons/lessonPrs.js';
import type { LessonPullRequest } from '../../types.js';
import type { AzureDevOpsApi } from './azureDevOpsApi.js';

// → docs/spec/41-repo-lessons.md#across-fleets

export async function listAzureLessonPulls(api: AzureDevOpsApi, since: string): Promise<LessonPullRequest[]> {
  const [open, closed] = await Promise.all([api.listActivePullRequests(), api.listRecentlyClosedPullRequests(since)]);
  const numbered = <T extends { pullRequestId: number }>(p: T) => ({ ...p, number: p.pullRequestId });
  return lessonPullsOf(open.map(numbered), closed.map(numbered));
}
