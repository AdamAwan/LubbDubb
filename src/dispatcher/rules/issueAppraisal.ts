import { dispatchVerdict } from '../dispatchCooldown.js';
import { appraisalBranch, appraisalOrigin, hasWorkStarted, isAppraised } from '../../intake/appraisal.js';
import { issueOrigin } from '../../plans/planning.js';
import { relatedWorkNote } from '../../issueRelations.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-appraisal`)

export function issueAppraisal(s: StageContext): void {
  const { ctx } = s;
  for (const { issue } of s.eligibleIssues) {
    if (isAppraised(s.appraisals.get(issueOrigin(issue.number)) ?? null, issue)) continue;
    if (hasWorkStarted(issue.number, ctx.tasks)) continue;
    if (s.plansByOrigin.has(issueOrigin(issue.number))) continue;
    const root = issueOrigin(issue.number);
    if ([...s.activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

    const origin = appraisalOrigin(issue.number);
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    s.appraising.add(issue.number);
    const branch = appraisalBranch(issue.number);
    const title = `Appraise issue #${issue.number}`;
    const reason = `Nothing has been started for issue #${issue.number}; check the goal can be worked from before dispatching against it.`;
    s.candidates.push({
      origin,
      rule: 'issue-appraisal',
      title,
      kind: 'code',
      branch,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, s.defaultBranch),
        title,
        prompt:
          s.templates.render('issue-appraisal', {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            branch,
          }) + relatedWorkNote(issue, s.pickup.containerTypes, s.parentCandidates, s.pickup.parentedTypes),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-appraisal',
        reason,
      } satisfies RawAction,
    });
  }
}
