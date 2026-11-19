import type { OpenPullRequest } from '../wire.js';

// → docs/spec/44-needs-you.md#pull-requests-waiting-on-you

const PR_ON_YOU_REASONS = ['review', 'call', 'comments', 'assign', 'describe'] as const;

export type PrOnYouReason = (typeof PR_ON_YOU_REASONS)[number];

const HOLDS: Record<PrOnYouReason, (pr: OpenPullRequest) => boolean> = {
  review: (pr) => pr.attention.assignedToYou !== undefined,
  call: (pr) => pr.attention.status === 'you' && pr.attention.assignedToYou === undefined,
  comments: (pr) => pr.unresolvedComments.length > 0,
  assign: (pr) => pr.assignAsk !== undefined && pr.assignAsk.length > 0,
  describe: (pr) => pr.body !== undefined && pr.body.trim() === '',
};

/** Every reason the pull request is on the operator, in the table's order; empty when it is not. */
export function prOnYouReasons(pr: OpenPullRequest): PrOnYouReason[] {
  return PR_ON_YOU_REASONS.filter((reason) => HOLDS[reason](pr));
}
