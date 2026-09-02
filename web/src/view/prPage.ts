import type { AppState, Issue, PrReviewThread, PrThreadState, PullRequest, TaskSummary } from '../types.js';
import { goalOfPr } from './goalPage.js';

/**
 * What the pull-request page draws, derived from the snapshot the cockpit already
 * holds and from nothing else.
 *
 * The page has no route of its own on purpose: every reading on it is one the
 * harness has already made and already ships — the threads and their state, the
 * checks, the two verdicts, the tasks that ran on the branch. Fetching any of it
 * again would be a second answer to a question `/api/state` has answered.
 * → `docs/spec/17-cockpit.md#the-pull-request-page`
 */
export interface PrPageView {
  pr: PullRequest;
  /** Still in the open list. A closed one is drawn spent and asks for nothing. */
  open: boolean;
  /** The goal this pull request belongs to, for the crumb, or null when no ticket owns it. */
  goal: Issue | null;
  /** The goal ref even where the world no longer carries the issue — a crumb that still leads back. */
  goalRef: string | null;
  /**
   * The review threads, or **null when the provider does not report them** — a
   * pull request from before this existed, or one whose provider cannot say. The
   * page draws that as its own sentence: a bare "no threads" would read as a
   * change nobody reviewed, which is the opposite claim.
   */
  threads: readonly PrReviewThread[] | null;
  /** How many threads stand in each state. Zero-filled, so a heading can name every one. */
  counts: Record<PrThreadState, number>;
  /** The threads the fleet still owes an answer — `open` and `reopened` together. */
  waiting: number;
  /** The tasks dispatched onto this branch, newest first. */
  work: TaskSummary[];
}

/** The order threads are drawn in: what is owed first, what is finished last. */
const STATE_ORDER: Record<PrThreadState, number> = { reopened: 0, open: 1, answered: 2, resolved: 3 };

/**
 * Build the page, or null when the world carries no such pull request.
 *
 * Null rather than an empty page, for `buildGoalPage`'s reason: a page of empty
 * sections cannot be told apart from a pull request that exists with nothing on
 * it, and the console has a screen for the gone case that says which this is.
 *
 * Closed pull requests are looked up too. A merged one is where a review that was
 * never answered ends up, and a page that could not open it would make exactly
 * those threads unreachable.
 */
export function buildPrPage(state: AppState, prNumber: number): PrPageView | null {
  const open = state.world.pullRequests.find((p) => p.number === prNumber) ?? null;
  const pr = open ?? (state.world.closedPullRequests ?? []).find((p) => p.number === prNumber) ?? null;
  if (pr === null) return null;

  const goalRef = goalOfPr(state, prNumber);
  const goalNumber = goalRef === null ? null : Number(/^issue:(\d+)$/.exec(goalRef)?.[1] ?? NaN);
  const goal = goalNumber === null ? null : (state.world.issues.find((i) => i.number === goalNumber) ?? null);

  // Sorted by what is owed rather than by the provider's order: the page exists to
  // answer "what is still on us", and a reopened thread buried under nine resolved
  // ones is an answer nobody reads. Within a state the provider's order stands —
  // it is the order the review was written in.
  const threads =
    pr.reviewThreads === undefined
      ? null
      : [...pr.reviewThreads].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

  const counts: Record<PrThreadState, number> = { open: 0, answered: 0, resolved: 0, reopened: 0 };
  for (const t of threads ?? []) counts[t.state] += 1;

  return {
    pr,
    open: open !== null,
    goal,
    goalRef,
    threads,
    counts,
    waiting: counts.open + counts.reopened,
    // By branch, which is the only join that is true of a pull request: a goal's
    // other pull requests are worked on their own branches, and matching by goal
    // would put another one's runs on this page.
    work: [...state.tasks]
      .filter((t) => t.branch !== null && t.branch === pr.branch)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}
