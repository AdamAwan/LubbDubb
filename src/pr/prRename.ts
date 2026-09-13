import { issueForPr } from './prIssue.js';
import { isOurPr } from './prOwnership.js';
import { prTitleFields, renderPrTitle } from './prTitle.js';
import type { PrTitleInput } from '../sink/actionSink.js';
import type { Issue, PullRequest } from '../types.js';

// → docs/spec/07-pull-requests.md

export interface PrRenameContext {
  prAuthorConfigured: boolean;
  template: string;
  issues: Issue[];
  positions?: ReadonlyMap<number, { position: number; total: number }>;
}

export function renamablePrs(prs: PullRequest[], ctx: PrRenameContext): PrTitleInput[] {
  const out: PrTitleInput[] = [];
  for (const pr of prs) {
    if (pr.merged) continue;
    if (!isOurPr(pr, ctx.prAuthorConfigured)) continue;

    const issue = issueForPr(pr, ctx.issues);
    if (!issue) continue;

    const at = ctx.positions?.get(pr.number);
    const title = renderPrTitle(
      ctx.template,
      prTitleFields({
        number: issue.number,
        title: issue.title,
        position: at?.position ?? 1,
        total: at?.total ?? 1,
        summary: summaryOf(pr.title),
      }),
    );
    if (title !== pr.title) out.push({ prNumber: pr.number, title });
  }
  return out;
}

function summaryOf(title: string): string {
  return title
    .replace(/^#\d+\s*/, '')
    .replace(/^\[\d+\/\d+\]\s*/, '')
    .trim();
}
