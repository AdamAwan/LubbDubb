import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason, openPrForIssue } from '../issuePickup.js';
import { assessBranch, assessOrigin, hasPriorWork } from '../../delivery/assessment.js';
import { issueOrigin } from '../../plans/planning.js';
import { planInFlight } from '../../plans/parts.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-assess`)

export function issueAssess(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issue.state !== 'open' && !s.retained.has(issue.number)) continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (openPrForIssue(issue, s.openPrs) !== null) continue;
    if (s.deliveryParked(issue)) continue;
    if (!hasPriorWork(issue.number, ctx.tasks)) continue;
    const plan = s.plansByOrigin.get(issueOrigin(issue.number));
    if (plan && planInFlight(plan)) continue;
    const root = issueOrigin(issue.number);
    if ([...s.activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

    const origin = assessOrigin(issue.number);
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    s.assessing.add(issue.number);
    const branch = assessBranch(issue.number);
    const title = `Assess issue #${issue.number}`;
    const reason = `Issue #${issue.number} has had work and has nothing in flight; assess whether it is finished.`;
    s.candidates.push({
      origin,
      rule: 'issue-assess',
      title,
      kind: 'code',
      branch,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, s.defaultBranch),
        title,
        prompt: s.templates.render('issue-assess', {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          branch,
        }),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-assess',
        reason,
      } satisfies RawAction,
    });
  }
}
