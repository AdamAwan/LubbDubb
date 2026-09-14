import type { PullRequest } from '../../../types.js';
import { dispatchVerdict } from '../../dispatchCooldown.js';
import {
  charterNote,
  modeCharterHeading,
  needsFleetReview,
  publishNote,
  resolvedReviewMode,
  reviewBranch,
  reviewOrigin,
  reviewTriageOrigin,
  triageRuns,
  type PrReviewReading,
} from '../../../review/prReview.js';
import { readOnlyDispatch } from '../readOnlyDispatch.js';
import type { StageContext } from '../context.js';
import type { PrConcern } from './concern.js';

// → docs/spec/05-dispatcher.md (the PR concern pass)

export function reviewConcern(
  pr: PullRequest,
  s: StageContext,
  reading: PrReviewReading,
): { concern: PrConcern | null; reviewComing: boolean } {
  const route = reading.route;
  const mode = resolvedReviewMode(route, s.review);
  const routing = route === null && triageRuns(s.review) && !triageSpent(s, pr.number);
  const reviewComing = needsFleetReview(pr, reading, s.review) && !reviewSpent(s, pr.number);
  if (!reviewComing || routing) return { concern: null, reviewComing };
  const origin = reviewOrigin(pr.number);
  const branch = reviewBranch(pr.number);
  return {
    reviewComing,
    concern: {
      rule: 'pr-review',
      origin,
      dispatch: readOnlyDispatch(branch, pr.branch),
      profile: (mode === null ? null : (s.review.modes[mode]?.profile ?? null)) ?? undefined,
      title: mode === null ? `Review PR #${pr.number}` : `Review PR #${pr.number} (${mode})`,
      prompt:
        s.templates.render('pr-review', {
          number: pr.number,
          title: pr.title,
          branch: pr.branch,
          base: pr.baseBranch ?? s.defaultBranch,
        }) +
        publishNote(s.review.publish) +
        charterNote(mode === null ? null : (s.reviewCharters.modes[mode] ?? null), modeCharterHeading(mode)),
      dispatchReason:
        `PR #${pr.number} has not been reviewed by the fleet and no agent is on it` +
        (mode === null ? '.' : ` (${mode}${route === null ? ', by default' : ''}).`),
      note: `PR #${pr.number} has not been reviewed yet — read the diff and report what you find.`,
      originTitle: pr.title,
      originSummary: `PR #${pr.number} on branch ${pr.branch} · awaiting the fleet's review`,
    },
  };
}

function triageSpent(s: StageContext, prNumber: number): boolean {
  const verdict = dispatchVerdict(reviewTriageOrigin(prNumber), s.now, s.ctx.recentDecisions, s.cooldown);
  return verdict.kind === 'escalate' || verdict.kind === 'hold';
}

function reviewSpent(s: StageContext, prNumber: number): boolean {
  return dispatchVerdict(reviewOrigin(prNumber), s.now, s.ctx.recentDecisions, s.cooldown).kind === 'hold';
}
