import type { PrApproval } from '../../types.js';
import type { GhReview } from './githubApi.js';

// → docs/spec/15-integrations.md, docs/spec/07-pull-requests.md#what-a-merge-ask-shows

export function viewerApproved(reviews: GhReview[], viewer: string): boolean {
  return viewer !== '' && standingApprovals(reviews).some((a) => a.by === viewer);
}

function latestVerdicts(reviews: GhReview[]): GhReview[] {
  const latest = new Map<string, GhReview>();
  for (const review of reviews) {
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'DISMISSED') continue;
    const prev = latest.get(review.reviewerLogin);
    if (!prev || (review.submittedAt ?? '') >= (prev.submittedAt ?? '')) latest.set(review.reviewerLogin, review);
  }
  return [...latest.values()];
}

export function computeApproved(reviews: GhReview[]): boolean {
  const states = latestVerdicts(reviews).map((r) => r.state);
  if (states.includes('CHANGES_REQUESTED')) return false;
  return states.includes('APPROVED');
}

export function standingApprovals(reviews: GhReview[]): PrApproval[] {
  return latestVerdicts(reviews)
    .filter((r) => r.state === 'APPROVED')
    .map((r) => ({ by: r.reviewerLogin, at: r.submittedAt ?? undefined }));
}
