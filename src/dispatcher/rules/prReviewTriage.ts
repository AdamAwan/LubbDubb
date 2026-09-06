import { dispatchVerdict } from '../dispatchCooldown.js';
import {
  charterNote,
  needsFleetReview,
  reviewTriageOrigin,
  routesBetweenModes,
  reviewModeNames,
  reviewReading,
  skipNote,
  triageRuns,
} from '../../review/prReview.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `pr-review-triage`)

export function prReviewTriage(s: StageContext): void {
  const { ctx } = s;
  if (!triageRuns(s.review)) return;
  for (const pr of ctx.world.pullRequests) {
    if (pr.merged) continue;
    if (!needsFleetReview(pr, reviewReading(s, pr.number), s.review)) continue;
    if (s.prReviewRoutes.has(pr.number)) continue;

    const origin = reviewTriageOrigin(pr.number);
    if (s.activeOrigins.has(origin)) continue;
    const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const title = `Choose how to review PR #${pr.number}`;
    const reason = routesBetweenModes(s.review)
      ? `PR #${pr.number} has no review mode yet, and this project declares ${reviewModeNames(s.review).length}.`
      : `PR #${pr.number} has no routing yet, and this project lets the triage skip a review.`;
    s.candidates.push({
      origin,
      rule: 'pr-review-triage',
      title,
      kind: 'desk',
      branch: null,
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_desk_agent',
        title,
        prompt:
          s.templates.render('pr-review-triage', {
            number: pr.number,
            title: pr.title,
            branch: pr.branch,
            base: pr.baseBranch ?? s.defaultBranch,
            modes: reviewModeNames(s.review).join(', '),
          }) +
          skipNote(s.review) +
          charterNote(s.reviewCharters.routing, 'How this project chooses'),
        originRef: origin,
        originTitle: pr.title,
        rule: 'pr-review-triage',
        reason,
      } satisfies RawAction,
    });
  }
}
