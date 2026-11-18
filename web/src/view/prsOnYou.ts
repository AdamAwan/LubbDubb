import type { OpenPullRequest, PrOnYouReason } from '../types.js';
import { PR_ON_YOU_REASONS, prOnYouReasons } from './needsYouPage.js';

// → docs/spec/44-needs-you.md#pull-requests-waiting-on-you

export const PR_REASON_LABEL: Record<PrOnYouReason, string> = {
  review: 'Your review',
  call: 'Your call',
  comments: 'Comments',
  assign: 'Needs a reviewer',
  describe: 'No description',
};

export interface PrOnYou {
  pr: OpenPullRequest;
  reasons: PrOnYouReason[];
}

export function prsOnYou(prs: readonly OpenPullRequest[]): PrOnYou[] {
  return prs
    .map((pr) => ({ pr, reasons: prOnYouReasons(pr) }))
    .filter((row) => row.reasons.length > 0)
    .sort(
      (a, b) =>
        PR_ON_YOU_REASONS.indexOf(a.reasons[0]!) - PR_ON_YOU_REASONS.indexOf(b.reasons[0]!) ||
        b.pr.number - a.pr.number,
    );
}
