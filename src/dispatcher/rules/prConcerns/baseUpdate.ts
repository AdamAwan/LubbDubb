import type { PullRequest } from '../../../types.js';
import { needsBaseUpdate } from '../../../pr/prHealth.js';
import type { RawAction, StageContext } from '../context.js';
import { directActUnperformed, type PrConcern } from './concern.js';

// → docs/spec/05-dispatcher.md (the PR concern pass)

export function baseUpdateConcern(pr: PullRequest, s: StageContext): PrConcern | null {
  if (!needsBaseUpdate(pr)) return null;
  const base = pr.baseBranch ?? s.defaultBranch;
  const behind = pr.mergeableState === 'behind';
  const mergeableOrigin = `pr:${pr.number}:mergeable`;
  const direct = behind && !directActUnperformed('update_pr_branch', mergeableOrigin, s.ctx.recentDecisions);
  return {
    rule: behind ? 'pr-base-update' : 'pr-base-update-conflict',
    origin: mergeableOrigin,
    act: direct
      ? ({
          type: 'update_pr_branch',
          prNumber: pr.number,
          base,
          branch: pr.branch,
          originRef: mergeableOrigin,
          rule: 'pr-base-update',
          reason: `PR #${pr.number} is behind ${base} with no conflicts; merging ${base} in through the provider rather than spending an agent on it.`,
        } satisfies RawAction)
      : undefined,
    title: behind ? `Update PR #${pr.number} with ${base}` : `Resolve merge conflicts on PR #${pr.number}`,
    prompt: s.templates.render(behind ? 'pr-base-update-behind' : 'pr-base-update-conflict', {
      number: pr.number,
      title: pr.title,
      branch: pr.branch,
      base,
    }),
    dispatchReason: behind
      ? `PR #${pr.number} is behind ${base}, the base could not be merged in directly, and no agent is on it.`
      : `PR #${pr.number} has merge conflicts with ${base} and no agent is on it.`,
    note: behind
      ? `PR #${pr.number} is now behind ${base} — merge ${base} in to bring it up to date, then push.`
      : `The base branch ${base} now conflicts with PR #${pr.number} — merge ${base} in, resolve the conflicts, and push.`,
    originTitle: pr.title,
    originSummary: `PR #${pr.number} on branch ${pr.branch} · ${behind ? `behind ${base}` : `conflicts with ${base}`}`,
  };
}
