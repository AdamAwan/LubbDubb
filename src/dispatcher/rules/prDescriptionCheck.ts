import { issueOriginRef, parseIssueOrigin } from '../../issueOrigins.js';
import { describeCheckBranch } from '../../pr/prDescription.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/07-pull-requests.md#every-description-is-checked-without-asking

export function prDescriptionCheck(s: StageContext): void {
  const { ctx } = s;
  for (const waiting of s.uncheckedDescriptions) {
    const pr = ctx.world.pullRequests.find((p) => p.number === waiting.prNumber);
    if (pr === undefined || pr.merged) continue;
    const part = parseIssueOrigin(waiting.originRef);
    if (part === null) continue;

    const origin = issueOriginRef('describeCheck', part.issueNumber, pr.number);
    if (s.activeOrigins.has(origin)) continue;

    const branch = describeCheckBranch(pr.number);
    const title = `Check the description of PR #${pr.number}`;
    const reason = `The operator wrote a description for PR #${pr.number} and nothing has read it against the diff.`;
    const authored = Date.parse(waiting.authoredAt);
    s.consider(
      {
        origin,
        rule: 'pr-description-check',
        title,
        kind: 'code',
        branch,
        reason,
        action: {
          type: 'dispatch_code_agent',
          ...readOnlyDispatch(branch, pr.branch),
          title,
          prompt: s.templates.render('pr-description-check', {
            number: pr.number,
            title: pr.title,
            branch: pr.branch,
            base: pr.baseBranch ?? s.defaultBranch,
            id: waiting.versionId,
            description: waiting.text,
          }),
          originRef: origin,
          originTitle: pr.title,
          originSummary: `PR #${pr.number} on branch ${pr.branch}`,
          rule: 'pr-description-check',
          reason,
        } satisfies RawAction,
      },
      {
        decisions: ctx.recentDecisions.filter((d) => Date.parse(d.createdAt) > authored),
        escalate: (attempts) => ({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt:
            `${attempts} agents were dispatched to check the description of PR #${pr.number} and none reported. ` +
            `Nothing further will be dispatched for this version; writing a new one starts a fresh round.`,
          context: { originRef: origin, taskTitle: title },
          rule: 'pr-description-check',
          admission: 'cooldown-escalate',
          reason: `Origin ${origin} hit the ${s.cooldown.maxAttempts}-attempt cap on this version.`,
        }),
      },
    );
  }
}
