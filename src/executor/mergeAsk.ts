import type { ValidatedAction } from '../dispatcher/actions.js';

// → docs/spec/07-pull-requests.md#what-a-merge-ask-shows

export function mergeEscalation(action: ValidatedAction & { type: 'merge_pr' }, preamble: string) {
  const named = action.title ? `PR #${action.prNumber} "${action.title}"` : `PR #${action.prNumber}`;
  const by = action.approvals?.length ? `approved by ${action.approvals.map((a) => a.by).join(', ')}` : 'approved';
  return {
    type: 'approve_change' as const,
    prompt: `${preamble}${named} is green, ${by} and mergeable. Approve merging it (method: ${action.method})?`,
    context: { prNumber: action.prNumber, method: action.method, prTitle: action.title, approvals: action.approvals },
  };
}
