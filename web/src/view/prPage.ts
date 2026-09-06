import type { AppState, Issue, PrReviewThread, PrThreadState, PullRequest, TaskSummary } from '../types.js';
import { closedPrs, goalOfPr } from './goalPage.js';

// → docs/spec/17-cockpit.md

export interface PrPageView {
  pr: PullRequest;
  open: boolean;
  goal: Issue | null;
  goalRef: string | null;
  threads: readonly PrReviewThread[] | null;
  counts: Record<PrThreadState, number>;
  waiting: number;
  work: TaskSummary[];
}

const STATE_ORDER: Record<PrThreadState, number> = { reopened: 0, open: 1, answered: 2, resolved: 3 };

export function hasPrPage(state: AppState, prNumber: number): boolean {
  return findPr(state, prNumber) !== null;
}

function findPr(state: AppState, prNumber: number): PullRequest | null {
  return (
    state.world.pullRequests.find((p) => p.number === prNumber) ??
    closedPrs(state).find((p) => p.number === prNumber) ??
    null
  );
}

export function buildPrPage(state: AppState, prNumber: number): PrPageView | null {
  const open = state.world.pullRequests.find((p) => p.number === prNumber) ?? null;
  const pr = open ?? findPr(state, prNumber);
  if (pr === null) return null;

  const goalRef = goalOfPr(state, prNumber);
  const goalNumber = goalRef === null ? null : Number(/^issue:(\d+)$/.exec(goalRef)?.[1] ?? NaN);
  const goal = goalNumber === null ? null : (state.world.issues.find((i) => i.number === goalNumber) ?? null);

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
    work: [...state.tasks]
      .filter((t) => t.branch !== null && t.branch === pr.branch)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
}
