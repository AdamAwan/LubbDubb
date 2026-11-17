import type { ErrorRecorder } from '../errorLog.js';
import type { LessonDraft, LessonPullRequest } from '../types.js';
import { LESSON_WINDOW_MS } from './groups.js';
import { lessonBranch } from './lessonOrigin.js';

// → docs/spec/41-repo-lessons.md#across-fleets

export interface LessonPrSource {
  listLessonPullRequests(since: string): Promise<LessonPullRequest[]>;
}

/** How long one read of every lesson pull request stands before the desk reads again. */
const LESSON_PR_READ_MS = 30 * 60 * 1000;

/** Every lesson pull request on the repository, open or closed inside the lesson window, whoever opened it. */
export class LessonPrReading {
  private held: { at: number; prs: LessonPullRequest[] } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: { source: LessonPrSource; errors?: ErrorRecorder; now?: () => number }) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The held read while it is fresh, else a new one; null when the read failed. */
  async read(fresh = false): Promise<LessonPullRequest[] | null> {
    const at = this.now();
    if (!fresh && this.held !== null && at - this.held.at < LESSON_PR_READ_MS) return this.held.prs;
    try {
      const since = new Date(at - LESSON_WINDOW_MS).toISOString();
      const prs = await this.deps.source.listLessonPullRequests(since);
      this.held = { at, prs };
      return prs;
    } catch (err) {
      this.deps.errors?.record({
        source: 'provider',
        message: `reading lesson pull requests failed: ${(err as Error).message}`,
      });
      return null;
    }
  }
}

/** The lesson pull requests that are not this fleet's own drafts'. */
export function othersLessonPrs(
  prs: readonly LessonPullRequest[],
  drafts: readonly LessonDraft[],
): LessonPullRequest[] {
  const own = new Set(drafts.map((d) => lessonBranch(d.id, d.groupKey)));
  return prs.filter((pr) => !own.has(pr.branch));
}
