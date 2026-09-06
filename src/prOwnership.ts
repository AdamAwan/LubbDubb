import type { PullRequest } from './types.js';

// → docs/spec/07-pull-requests.md#whose-pull-request-is-it

export function isOurPr(pr: PullRequest, prAuthorConfigured: boolean): boolean {
  return pr.viewerAuthored ?? (prAuthorConfigured || isHarnessBranch(pr.branch));
}

export function isSomeoneElsesPr(pr: PullRequest): boolean {
  return pr.viewerAuthored === false;
}

export function isHarnessBranch(branch: string): boolean {
  return /^issue\/\d+(\/.+)?$/.test(branch) || /^job\/.+$/.test(branch);
}
