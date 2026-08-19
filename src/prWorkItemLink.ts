import { issueForPr } from './prIssue.js';
import { isOurPr } from './prOwnership.js';
import { prState } from './prHealth.js';
import type { Issue, PullRequest } from './types.js';

/** One pull request to link, and the work item the harness already knows it is for. */
export interface WorkItemLinkSeed {
  prNumber: number;
  /** The tracker item number — an Azure work item id, a GitHub issue number. */
  workItemNumber: number;
}

interface PrWorkItemLinkContext {
  /** `filters.prAuthor` is configured on the active provider — see {@link isOurPr}. */
  prAuthorConfigured: boolean;
  issues: Issue[];
  /** Pull requests already linked, from `pr_work_item_links`. The read lives in the desk so this stays pure. */
  linked: ReadonlySet<number>;
}

/**
 * Which open pull requests are missing the tracker link the harness can already
 * supply — the mechanical half of "every pull request has a work item".
 *
 * Azure DevOps has a **Check for linked work items** branch policy, and nothing
 * about a pull request satisfies it except a work-item artifact link. A prose
 * `Relates to #12` in the description does not: GitHub reads one and Azure does
 * not, so on Azure the fleet was opening pull requests that were blocked from the
 * moment they existed. The only thing that then moved them was an agent dispatched
 * to work out which work item the pull request was for and link it — a model call,
 * a worktree and a full context window spent rediscovering a number the harness
 * had in a row the whole time. This is that answer, taken off the row.
 *
 * The work item is {@link issueForPr}'s question, asked exactly where the rename
 * asks it, so the number in a pull request's title and the number on its tracker
 * link cannot disagree.
 *
 * **Once per pull request, and the `pr_work_item_links` row is what makes it
 * once.** Two things make the world's own answer insufficient. An operator may
 * delete a link they judged wrong, and a desk that re-derived from the world would
 * put it straight back on the next pulse — `pr_watch_seeds`' argument exactly. And
 * `linkedPrNumber` reports only the *last* pull request to cross-reference an
 * issue, so on a plan whose parts each open one, the earlier parts read as unlinked
 * forever however many links are really there.
 *
 * The one world reading kept beside the row is `linkedPrNumber === pr.number`,
 * which is the provider stating that this exact link exists. It is what stops a
 * deployment upgrading onto this desk from re-sending a link for every pull request
 * already carrying one — Azure rejects a duplicate relation, so those would be a
 * pulse of errors saying nothing was wrong.
 *
 * Pure, and a lens's opposite in {@link reapableBranches}' sense: nothing in
 * `src/dispatcher/` reads it, but it drives writes through `PrWorkItemDesk`.
 */
export function prsToLinkWorkItem(prs: PullRequest[], ctx: PrWorkItemLinkContext): WorkItemLinkSeed[] {
  const out: WorkItemLinkSeed[] = [];
  for (const pr of prs) {
    if (prState(pr) !== 'open') continue;
    if (!isOurPr(pr, ctx.prAuthorConfigured)) continue;
    if (ctx.linked.has(pr.number)) continue;

    const issue = issueForPr(pr, ctx.issues);
    // No work item resolved means the harness does not know one either, and a link
    // is not something to guess at. Left for a human, exactly as the rename leaves
    // such a pull request unnamed.
    if (!issue) continue;
    if (issue.linkedPrNumber === pr.number) continue;

    out.push({ prNumber: pr.number, workItemNumber: issue.number });
  }
  return out;
}
