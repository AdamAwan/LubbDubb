import { isLessonBranch } from '../../lessons/lessonOrigin.js';
import type { LessonPullRequest } from '../../types.js';
import type { GitHubApi } from './githubApi.js';

// → docs/spec/41-repo-lessons.md#across-fleets

export async function listGitHubLessonPulls(api: GitHubApi, since: string): Promise<LessonPullRequest[]> {
  const [open, closed] = await Promise.all([api.listOpenPulls(), api.listRecentlyClosedPulls(since)]);
  return [
    ...open
      .filter((p) => isLessonBranch(p.branch))
      .map((p): LessonPullRequest => ({
        number: p.number,
        branch: p.branch,
        url: p.url,
        state: 'open',
        closedAt: null,
      })),
    ...closed
      .filter((p) => isLessonBranch(p.branch))
      .map((p): LessonPullRequest => ({
        number: p.number,
        branch: p.branch,
        url: p.url,
        state: p.merged ? 'merged' : 'closed',
        closedAt: p.closedAt,
      })),
  ];
}
