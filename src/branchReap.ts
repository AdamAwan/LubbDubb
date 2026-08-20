import { isOurPr } from './prOwnership.js';
import { prState } from './prHealth.js';
import type { PullRequest, TaskSummary } from './types.js';

/** One branch to reap, and the pull request whose merge earned it. */
interface BranchReapInput {
  prNumber: number;
  branch: string;
}

export interface BranchReapContext {
  /** Never reaped, whatever the world says about it. */
  defaultBranch: string;
  /** `github.filters.prAuthor` / `azureDevOps.filters.prAuthor` is configured — see {@link isOurPr}. */
  prAuthorConfigured: boolean;
  /** Every task the store holds; an active one on the branch holds the reap off. */
  tasks: TaskSummary[];
  /** Pull requests already reaped, from `branch_reaps`. The read lives in the desk so this stays pure. */
  reaped: ReadonlySet<number>;
}

/**
 * Which merged pull requests' branches may be deleted, locally and on the remote.
 *
 * The harness merges a pull request and then leaves its branch standing forever, on
 * both sides: the worktree goes when the *agent* is reaped, which is a fact about the
 * agent rather than about the merge, and nothing has ever deleted the ref. This is
 * the missing step.
 *
 * Pure, and a lens's opposite: nothing in `src/dispatcher/` reads it, but unlike a
 * lens it drives writes — through {@link BranchReapDesk}, on the pulse, as mechanical
 * bookkeeping beside the rename and the retarget.
 */
export function reapableBranches(
  openPrs: PullRequest[],
  closedPrs: PullRequest[],
  ctx: BranchReapContext,
): BranchReapInput[] {
  // Every branch anything still targets. A merged parent whose rung above it has
  // not been retargeted yet is *not* reapable: deleting the base of an open pull
  // request orphans it, and GitHub closes it outright. `retargetsFor` moves that
  // rung, but the write lands on a later pulse — and on Azure it is the only thing
  // that moves it at all. Holding costs one pulse; reaping first destroys a stack
  // silently, which is the failure this check exists for.
  const bases = new Set<string>([ctx.defaultBranch]);
  for (const pr of [...openPrs, ...closedPrs]) {
    if (prState(pr) === 'open' && pr.baseBranch !== undefined) bases.add(pr.baseBranch);
  }

  const out: BranchReapInput[] = [];
  for (const pr of closedPrs) {
    // Merged only. An **abandoned** pull request's branch holds work that never
    // landed, so deleting it destroys the only copy — and `prState` never invents
    // `closed` from absence. The same line `retargetsFor` draws.
    if (prState(pr) !== 'merged') continue;
    if (!isOurPr(pr, ctx.prAuthorConfigured)) continue;
    if (ctx.reaped.has(pr.number)) continue;
    if (bases.has(pr.branch)) continue;
    // An agent can still be finishing on a branch whose pull request has merged —
    // the same guard the worktree reap in `system.ts` applies, for the same reason:
    // yanking a live checkout is worse than leaving a branch a pulse longer.
    if (ctx.tasks.some((t) => t.branch === pr.branch && isActive(t.status))) continue;
    // Two merged pull requests can name one branch (a reopen, a re-merge). The
    // branch is what gets deleted, so it is what de-dups.
    if (out.some((r) => r.branch === pr.branch)) continue;
    out.push({ prNumber: pr.number, branch: pr.branch });
  }
  return out;
}

function isActive(status: TaskSummary['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}
