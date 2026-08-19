import type { Issue, PullRequest } from './types.js';

/**
 * The issue a pull request belongs to: the one that links it, else the one its
 * `issue/<n>` branch names. Both are readings the harness already relies on
 * elsewhere — `linkedPrNumber` for pickup, the branch shape for every dispatch rule.
 *
 * **One definition, because the answer now drives two writes.** The naming desk
 * renders a title from it ([`src/prRename.ts`]) and the work-item desk hangs a
 * tracker link off it ([`src/prWorkItemLink.ts`]); a second copy would be free to
 * disagree about which issue a pull request is for, and the two writes would then
 * name different work items on the same pull request — a PR titled `#12` linked to
 * `#13`, with nothing red.
 */
export function issueForPr(pr: PullRequest, issues: Issue[]): Issue | null {
  const linked = issues.find((i) => i.linkedPrNumber === pr.number);
  if (linked) return linked;
  const branch = /^issue\/(\d+)(?:\/|$)/.exec(pr.branch);
  if (branch?.[1] === undefined) return null;
  return issues.find((i) => i.number === Number(branch[1])) ?? null;
}
