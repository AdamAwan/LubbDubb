import type { OpenPullRequest } from '../wire.js';

// → docs/spec/44-needs-you.md#pull-requests-waiting-on-you

export type PrOnYouReason = 'review' | 'call' | 'comments' | 'assign' | 'describe';

/** Every reason the pull request is on the operator, in the table's order; empty when it is not. */
export function prOnYouReasons(pr: OpenPullRequest): PrOnYouReason[] {
  const reasons: PrOnYouReason[] = [];
  const assigned = pr.attention.assignedToYou !== undefined;
  if (assigned) reasons.push('review');
  if (pr.attention.status === 'you' && !assigned) reasons.push('call');
  if (pr.unresolvedComments.length > 0) reasons.push('comments');
  if (pr.assignAsk !== undefined && pr.assignAsk.length > 0) reasons.push('assign');
  if (pr.body !== undefined && pr.body.trim() === '') reasons.push('describe');
  return reasons;
}
