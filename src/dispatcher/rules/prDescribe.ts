import { issueOriginRef, parseIssueOrigin } from '../../issueOrigins.js';
import { describeBranch } from '../../pr/prDescription.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/07-pull-requests.md#handing-it-back-to-the-agent

export function prDescribe(s: StageContext): void {
  const { ctx } = s;
  for (const handoff of s.descriptionHandoffs) {
    const pr = ctx.world.pullRequests.find((p) => p.number === handoff.prNumber);
    if (pr === undefined || pr.merged) continue;
    const part = parseIssueOrigin(handoff.originRef);
    if (part === null) continue;

    const origin = issueOriginRef('describe', part.issueNumber, pr.number);
    if (s.activeOrigins.has(origin)) continue;

    const branch = describeBranch(pr.number);
    const title = `Describe PR #${pr.number}`;
    const reason = `The operator handed PR #${pr.number}'s description back to an agent.`;
    s.consider({
      origin,
      rule: 'pr-describe',
      title,
      kind: 'code',
      branch,
      reason,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, pr.branch),
        title,
        prompt: s.templates.render('pr-describe', {
          number: pr.number,
          title: pr.title,
          branch: pr.branch,
          base: pr.baseBranch ?? s.defaultBranch,
        }),
        originRef: origin,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch}`,
        rule: 'pr-describe',
        reason,
      } satisfies RawAction,
    });
  }
}
