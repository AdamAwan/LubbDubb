// → docs/spec/15-integrations.md

interface RefUrlInputs {
  pullRequests: { number: number; branch: string; url?: string }[];
  issues: { number: number; url?: string; linkedPrNumber: number | null }[];
  taskBranches: (string | null)[];
  refs?: (string | null)[];
  resolve: (ref: string) => string | null;
}

export function issueCommentRef(originRef: string | null, commentId: string | null): string | null {
  if (!commentId) return null;
  const match = /^issue:(\d+)$/.exec(originRef ?? '');
  return match ? `issue:${match[1]}:comment:${commentId}` : null;
}

export function decisionSubjectRef(action: { type: string; [key: string]: unknown }): string | null {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (action.type) {
    case 'dispatch_code_agent':
    case 'dispatch_desk_agent':
    case 'propose_plan':
    case 'propose_shortfall':
      return str(action.originRef);
    case 'reply_on_pr':
    case 'merge_pr':
    case 'update_pr_branch':
    case 'requeue_ci_check': {
      const n = num(action.prNumber);
      return n === null ? null : `pr:${n}`;
    }
    case 'set_work_item_state': {
      const n = num(action.number);
      return n === null ? null : `issue:${n}`;
    }
    case 'respond_to_agent': {
      const refs = Array.isArray(action.originRefs) ? action.originRefs : [];
      return str(refs[0]);
    }
    default:
      return null;
  }
}

export function buildRefUrls(inputs: RefUrlInputs): Record<string, string> {
  const { pullRequests, issues, taskBranches, refs, resolve } = inputs;
  const map: Record<string, string> = {};
  const put = (key: string, url: string | null | undefined): void => {
    if (key && url && !(key in map)) map[key] = url;
  };

  for (const pr of pullRequests) {
    put(`#${pr.number}`, pr.url ?? resolve(`pr:${pr.number}`));
    put(pr.branch, resolve(pr.branch));
  }
  for (const issue of issues) {
    put(`#${issue.number}`, issue.url ?? resolve(`issue:${issue.number}`));
    if (issue.linkedPrNumber !== null) put(`#${issue.linkedPrNumber}`, resolve(`pr:${issue.linkedPrNumber}`));
  }
  for (const branch of taskBranches) {
    if (branch) put(branch, resolve(branch));
  }
  for (const ref of refs ?? []) {
    if (ref) put(ref, resolve(ref));
  }
  return map;
}
