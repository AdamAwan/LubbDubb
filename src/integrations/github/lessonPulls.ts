import { lessonPullsOf } from '../../lessons/lessonPrs.js';
import type { LessonPullRequest } from '../../types.js';
import type { GitHubApi } from './githubApi.js';

// → docs/spec/41-repo-lessons.md#across-fleets

export async function listGitHubLessonPulls(api: GitHubApi, since: string): Promise<LessonPullRequest[]> {
  const [open, closed] = await Promise.all([api.listOpenPulls(), api.listRecentlyClosedPulls(since)]);
  return lessonPullsOf(open, closed);
}
