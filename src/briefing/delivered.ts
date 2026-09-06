import { prState } from '../prHealth.js';
import type { PullRequest } from '../types.js';

// → docs/spec/09-execution.md

const MAX_PRS = 25;

function whereToLook(pr: PullRequest): string {
  const when = pr.closedAt ? ` ${pr.closedAt}` : '';
  switch (prState(pr)) {
    case 'merged':
      return pr.mergeCommitSha
        ? `merged${when} as ${pr.mergeCommitSha} (branch ${pr.branch})`
        : `merged${when}, no merge commit recorded — branch ${pr.branch}`;
    case 'closed':
      return `closed without merging${when} — branch ${pr.branch}`;
    default:
      return `branch ${pr.branch}; the harness never recorded how it ended`;
  }
}

export function deliveredWorkBriefing(prs: readonly PullRequest[]): string {
  const kept = prs.slice(0, MAX_PRS);
  if (kept.length === 0) return '';
  const dropped = prs.length - kept.length;

  const lines = [
    'Where this goal’s pull requests are in the checkout you are in, most recently closed first. This ' +
      'is the harness’s record of each one as it last read it, and it is only the part `world_read` ' +
      'does not carry — ask that for what each pull request was for and how confident the harness is ' +
      'that it merged. A squash merge leaves no ancestry link, so the commit below is the route from ' +
      'the number to the diff:',
  ];
  for (const pr of kept) lines.push(`- #${pr.number} — ${whereToLook(pr)}`);
  if (dropped > 0)
    lines.push(
      `[${dropped} older pull request${dropped === 1 ? '' : 's'} of this goal ${dropped === 1 ? 'was' : 'were'} ` +
        'trimmed to fit — `world_read` has the whole subtree.]',
    );
  return lines.join('\n');
}
