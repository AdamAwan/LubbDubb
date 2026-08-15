import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason, openPrForIssue } from '../issuePickup.js';
import { assessBranch, assessOrigin, hasPriorWork } from '../../delivery/assessment.js';
import { issueOrigin } from '../../plans/planning.js';
import { planInFlight } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Ask whether an issue that has already had work is finished.
 *
 * The gap this closes: `openPrForIssue` reads only the *open* list, so the moment
 * a delivering PR merges the issue is once again "open, watched, no open PR" —
 * `issue-pickup`'s entire precondition — and a fresh agent is put on work already
 * sitting on the default branch. Azure is half-covered by accident
 * (`work-item-in-review` parks the item in the review state), but that park is a
 * *tracker* state and GitHub has none, so there the only thing bounding the loop
 * is the attempt cap.
 *
 * Deliberately **not** driven off `eligibleIssues`, for `plan-part`'s reason: that
 * list applies the workflow-state gate, and the Azure case this must cover is
 * precisely an item parked in the review state. The watch/ignore tag is the only
 * pickup gate that applies, evaluated once on the issue.
 *
 * Ranked ahead of `issue-pickup` and suppressing it for the same issue (through
 * `s.assessing` — see {@link StageContext}). An open watched issue with no open PR
 * is a candidate for both, and `hasPriorWork` is what tells them apart: nothing
 * started means pickup, something finished means ask. Without the suppression both
 * fire and two agents land on one issue, one assessing and one redoing the work.
 */
export function issueAssess(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    // Open, **or** a retained run (issue #234). This is the rule the close used to
    // silently disqualify: the window is the gap between a merge and the ticket
    // closing, and a PR carrying `closes #N` makes that gap zero, so the assessor
    // never ran and — with no delivery row written — neither did `issue-retro`. A
    // run lives until the operator dismisses it, so the question is still askable.
    if (issue.state !== 'open' && !s.retained.has(issue.number)) continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (openPrForIssue(issue, s.openPrs) !== null) continue;
    if (s.deliveryParked(issue)) continue; // already assessed; the verdict stands
    if (!hasPriorWork(issue.number, ctx.tasks)) continue;
    // A plan that still schedules something owns the issue — a decomposition in
    // flight is not a finished one, and an unapproved one is not even decided.
    // `planInFlight`, not a status list inlined here: the one reading of "the
    // plan owns this issue", shared with the conclusion resolver so the two
    // cannot drift into disagreeing about it.
    const plan = s.plansByOrigin.get(issueOrigin(issue.number));
    if (plan && planInFlight(plan)) continue;
    // Anything live under the issue — a pickup agent, a planner, a part — means
    // the answer is not yet knowable.
    const root = issueOrigin(issue.number);
    if ([...s.activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

    const origin = assessOrigin(issue.number);
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    // Fails open, exactly as the planner does and for its reason: narrowing
    // `issue-pickup` without this turns any assessor crash into a permanently
    // parked issue. A spent cap returns the issue to ordinary pickup, with no
    // escalation — there is nothing for a human to do about an assessment that did
    // not happen that they cannot do by looking at the issue.
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
        branch,
        // Cut from the default branch: merged work is *on* it, so it is the only
        // checkout in which "was this delivered" can be answered at all.
        base: s.defaultBranch,
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
