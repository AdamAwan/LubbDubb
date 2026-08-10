import { isOurPr } from './prOwnership.js';
import { prTitleFields, renderPrTitle } from './prTitle.js';
import type { PrTitleInput } from './sink/actionSink.js';
import type { Issue, PullRequest } from './types.js';

/**
 * Which pull requests the harness may rename onto the convention.
 *
 * Whose a pull request is, is {@link isOurPr}'s question — the same one the merged-branch
 * reap asks, answered in one place.
 *
 * Renaming is mechanical bookkeeping, like `setWorkItemState` and
 * `upsertIssueComment`, so it is deliberately not auto-send gated. What keeps it
 * from being noise is that it writes only when the rendered title differs from the
 * live one — a PR already on convention is left alone, every pulse, for free.
 */

export interface PrRenameContext {
  /** `github.filters.prAuthor` / `azureDevOps.filters.prAuthor` is configured. */
  prAuthorConfigured: boolean;
  /** The `pr-title` template, already resolved through any operator override. */
  template: string;
  issues: Issue[];
  /** Stack position per PR number, when the PR is a rung. Absent reads as a lone PR. */
  positions?: ReadonlyMap<number, { position: number; total: number }>;
}

export function renamablePrs(prs: PullRequest[], ctx: PrRenameContext): PrTitleInput[] {
  const out: PrTitleInput[] = [];
  for (const pr of prs) {
    if (pr.merged) continue;
    if (!isOurPr(pr, ctx.prAuthorConfigured)) continue;

    const issue = issueFor(pr, ctx.issues);
    // The convention is keyed on an issue number, so a PR that resolves to no issue
    // has no name to be given. Left exactly as it is rather than half-renamed.
    if (!issue) continue;

    const at = ctx.positions?.get(pr.number);
    const title = renderPrTitle(
      ctx.template,
      prTitleFields({
        number: issue.number,
        title: issue.title,
        position: at?.position ?? 1,
        total: at?.total ?? 1,
        // The type and scope are the agent's to declare and are not stored, so a
        // rename cannot invent them: an existing title keeps whatever it had only
        // in as much as the summary carries it.
        summary: summaryOf(pr.title),
      }),
    );
    if (title !== pr.title) out.push({ prNumber: pr.number, title });
  }
  return out;
}

/**
 * The issue a pull request belongs to: the one that links it, else the one its
 * `issue/<n>` branch names. Both are readings the harness already relies on
 * elsewhere — `linkedPrNumber` for pickup, the branch shape for every dispatch rule.
 */
function issueFor(pr: PullRequest, issues: Issue[]): Issue | null {
  const linked = issues.find((i) => i.linkedPrNumber === pr.number);
  if (linked) return linked;
  const branch = /^issue\/(\d+)(?:\/|$)/.exec(pr.branch);
  if (branch?.[1] === undefined) return null;
  return issues.find((i) => i.number === Number(branch[1])) ?? null;
}

/**
 * The human-readable part of an existing title, with any convention prefix this
 * function itself would have written stripped off.
 *
 * Without the strip a rename is not idempotent: re-rendering `#182 sync cursor`
 * would give `#182 #182 sync cursor`, and it would keep growing every pulse.
 */
function summaryOf(title: string): string {
  return title
    .replace(/^#\d+\s*/, '')
    .replace(/^\[\d+\/\d+\]\s*/, '')
    .trim();
}
