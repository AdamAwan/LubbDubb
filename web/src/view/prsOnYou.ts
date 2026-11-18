import type { OpenPullRequest } from '../types.js';

// → docs/spec/44-needs-you.md#pull-requests-waiting-on-you

export type PrReason = 'review' | 'call' | 'comments' | 'reviewer' | 'description';

export const PR_REASON_LABEL: Record<PrReason, string> = {
  review: 'Your review',
  call: 'Your call',
  comments: 'Comments',
  reviewer: 'Needs a reviewer',
  description: 'No description',
};

const ORDER: readonly PrReason[] = ['review', 'call', 'comments', 'reviewer', 'description'];

export interface PrOnYou {
  pr: OpenPullRequest;
  reasons: PrReason[];
}

function holds(pr: OpenPullRequest, reason: PrReason): boolean {
  switch (reason) {
    case 'review':
      return pr.attention.assignedToYou !== undefined;
    case 'call':
      return pr.attention.status === 'you' && pr.attention.assignedToYou === undefined;
    case 'comments':
      return pr.unresolvedComments.length > 0;
    case 'reviewer':
      return pr.assignAsk !== undefined && pr.assignAsk.length > 0;
    case 'description':
      return pr.body !== undefined && pr.body.trim() === '';
  }
}

export function prsOnYou(prs: readonly OpenPullRequest[]): PrOnYou[] {
  return prs
    .map((pr) => ({ pr, reasons: ORDER.filter((reason) => holds(pr, reason)) }))
    .filter((row) => row.reasons.length > 0)
    .sort((a, b) => ORDER.indexOf(a.reasons[0]!) - ORDER.indexOf(b.reasons[0]!) || b.pr.number - a.pr.number);
}
