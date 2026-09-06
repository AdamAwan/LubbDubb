import type { Issue, PullRequest } from './types.js';

// → docs/spec/07-pull-requests.md

export function issueForPr(pr: PullRequest, issues: Issue[]): Issue | null {
  const linked = issues.find((i) => i.linkedPrNumber === pr.number);
  if (linked) return linked;
  const branch = /^issue\/(\d+)(?:\/|$)/.exec(pr.branch);
  if (branch?.[1] === undefined) return null;
  return issues.find((i) => i.number === Number(branch[1])) ?? null;
}
