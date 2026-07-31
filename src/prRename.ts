import { prTitleFields, renderPrTitle } from './prTitle.js';
import type { PrTitleInput } from './sink/actionSink.js';
import type { Issue, PullRequest } from './types.js';

/**
 * Which pull requests the harness may rename onto the convention.
 *
 * **`filters.prAuthor` is the gate, because it is already the operator's answer to
 * "which pull requests are mine"** — and both providers apply it *at fetch time*,
 * to the open and closed lists alike. So when it is set, every PR in the harness's
 * world is the operator's own **by construction**: the provider never surfaced
 * anyone else's, and no attribution logic is needed here at all.
 *
 * When it is unset the world holds everyone's pull requests and the harness
 * genuinely cannot tell them apart, so it falls back to the ones it opened itself
 * — which it knows without asking anyone. **A colleague's pull request is renamed
 * under neither arm**, and that is the whole point of having two.
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
    if (!mayRename(pr, ctx)) continue;

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

function mayRename(pr: PullRequest, ctx: PrRenameContext): boolean {
  return ctx.prAuthorConfigured || isHarnessBranch(pr.branch);
}

/**
 * `issue/12` or `issue/12/<slug>` — the two branch shapes only a dispatch produces,
 * and therefore the unset arm's answer to "did the harness open this".
 *
 * Derived rather than stored: a PR on one of those can only have come from a
 * dispatch, so recording every opened PR number in a table of its own would be a
 * second answer to a question the branch already answers. Arm A of the
 * unrecorded-work fold's attribution, reused.
 */
function isHarnessBranch(branch: string): boolean {
  return /^issue\/\d+(\/.+)?$/.test(branch);
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
