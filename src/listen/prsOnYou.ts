import type { OpenPullRequest } from '../wire.js';

// → docs/spec/44-needs-you.md#pull-requests-waiting-on-you

export type PrOnYouReason = 'Your review' | 'Your call' | 'Comments' | 'Needs a reviewer' | 'No description';

/** Every reason the pull request is on the operator, in the table's order; empty when it is not. */
export function prOnYouReasons(pr: OpenPullRequest): PrOnYouReason[] {
  const reasons: PrOnYouReason[] = [];
  const assigned = pr.attention.assignedToYou !== undefined;
  if (assigned) reasons.push('Your review');
  if (pr.attention.status === 'you' && !assigned) reasons.push('Your call');
  if (pr.unresolvedComments.length > 0) reasons.push('Comments');
  if (pr.assignAsk !== undefined && pr.assignAsk.length > 0) reasons.push('Needs a reviewer');
  if (pr.body !== undefined && pr.body.trim() === '') reasons.push('No description');
  return reasons;
}
