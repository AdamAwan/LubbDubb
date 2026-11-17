import type { ErrorRecorder } from '../errorLog.js';
import type { LessonPrReadable } from '../integrations/integration.js';
import type { LessonDraft, LessonPullRequest } from '../types.js';
import { LESSON_WINDOW_MS } from './groups.js';
import { isLessonBranch, lessonBranch } from './lessonOrigin.js';

// → docs/spec/41-repo-lessons.md#across-fleets

interface ListedPull {
  number: number;
  branch: string;
  url: string;
}

/** A provider's open and recently closed listings, reduced to the lesson branches among them. */
export function lessonPullsOf(
  open: readonly ListedPull[],
  closed: readonly (ListedPull & { merged: boolean; closedAt: string })[],
): LessonPullRequest[] {
  return [
    ...open.map((p): LessonPullRequest => ({ ...pick(p), state: 'open', closedAt: null })),
    ...closed.map((p): LessonPullRequest => ({
      ...pick(p),
      state: p.merged ? 'merged' : 'closed',
      closedAt: p.closedAt,
    })),
  ].filter((p) => isLessonBranch(p.branch));

  function pick({ number, branch, url }: ListedPull): ListedPull {
    return { number, branch, url };
  }
}

/** How long one read of every lesson pull request stands before the desk reads again. */
const LESSON_PR_READ_MS = 30 * 60 * 1000;

/** Every lesson pull request on the repository, open or closed inside the lesson window, whoever opened it. */
export class LessonPrReading {
  private last: { at: number; prs: LessonPullRequest[] | null } | null = null;
  private inFlight: Promise<LessonPullRequest[] | null> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: { source: LessonPrReadable; errors?: ErrorRecorder; now?: () => number }) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The last good read, never waited on: a stale or missing one starts a read in the background. */
  held(): LessonPullRequest[] | null {
    if (this.last === null || this.now() - this.last.at >= LESSON_PR_READ_MS) void this.read();
    return this.last?.prs ?? null;
  }

  /** A fresh read, shared with one already running; null when it failed, which keeps the last good one. */
  read(): Promise<LessonPullRequest[] | null> {
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<LessonPullRequest[] | null> {
    const at = this.now();
    try {
      const prs = await this.deps.source.listLessonPullRequests(new Date(at - LESSON_WINDOW_MS).toISOString());
      this.last = { at, prs };
      return prs;
    } catch (err) {
      this.last = { at, prs: this.last?.prs ?? null };
      this.deps.errors?.record({
        source: 'provider',
        message: `reading lesson pull requests failed: ${(err as Error).message}`,
      });
      return null;
    }
  }
}

/** The lesson pull requests that are not these drafts'. */
export function othersLessonPrs(
  prs: readonly LessonPullRequest[],
  drafts: readonly LessonDraft[],
): LessonPullRequest[] {
  const own = new Set(drafts.map((d) => lessonBranch(d.id, d.groupKey)));
  return prs.filter((pr) => !own.has(pr.branch));
}
