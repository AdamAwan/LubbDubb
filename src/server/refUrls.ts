/**
 * Builds the `ref → web URL` map the cockpit uses to turn external references
 * (issues, PRs, branches) into clickable links. URL construction stays in the
 * provider (via `resolve`); this only assembles the refs the current snapshot
 * mentions, so the web bundle looks URLs up rather than building them.
 *
 * A ref the provider can't resolve is simply omitted — the cockpit then renders
 * it as plain text, which is the right behaviour for the `fake` provider (no real
 * pages) or a merged/closed PR outside the open-PR window.
 */
interface RefUrlInputs {
  /** Open PRs in the world — keyed by `#<number>` and their branch. */
  pullRequests: { number: number; branch: string; url?: string }[];
  /** Open issues — keyed by `#<number>`, plus their linked PR. */
  issues: { number: number; url?: string; linkedPrNumber: number | null }[];
  /** Branches the tracked tasks operate on (nulls ignored). */
  taskBranches: (string | null)[];
  /**
   * Canonical refs to resolve and key by themselves (`issue:41`), for items that
   * aren't in the snapshot's lists — a finding names one that may well be closed,
   * and the `#n` keys above only cover what the world currently holds.
   */
  refs?: (string | null)[];
  /** The provider's canonical ref → URL resolver (returns null when it can't). */
  resolve: (ref: string) => string | null;
}

/**
 * The canonical ref for the one living comment the harness maintains on an issue
 * — the plan's status comment, and the goal assay's refusal (issue #171).
 *
 * It exists because the two records store a **provider comment id** (`GhCommentRef`
 * carries a number; Azure addresses an edit by work item + comment), which is the
 * right thing for `upsertIssueComment` to round-trip and the wrong thing to put on
 * the wire: a bare id is not resolvable on its own — worse, `githubRefUrl` reads a
 * bare number as an *issue number*, so shipping one would key a confident link to
 * an unrelated ticket. Pairing it with the issue it lives on makes it a ref in the
 * vocabulary everything else already writes (`issue:12:plan`, `issue:12:part:x`),
 * which `resolveRefUrl` can answer and the cockpit can look up.
 *
 * Null in, null out — a comment that was never written has no ref, and the caller
 * ships that null rather than branching. The store keeps the provider id
 * unchanged; this is a read-only translation for the wire.
 */
export function issueCommentRef(originRef: string | null, commentId: string | null): string | null {
  if (!commentId) return null;
  const match = /^issue:(\d+)$/.exec(originRef ?? '');
  return match ? `issue:${match[1]}:comment:${commentId}` : null;
}

/**
 * The one external thing a decision is *about*, as a canonical ref — what the
 * shift log's Ref column links.
 *
 * Derived **here**, on the server, and shipped on the row (`CockpitDecision`)
 * rather than re-derived in the browser, for the reason {@link issueCommentRef}
 * is: the same answer has to key `refUrls` and be looked up in it, and two
 * readings of the action bag are two chances to key one shape and look up
 * another — which fails silently, as a ref that renders plain on exactly the
 * actions whose payload the two disagree about.
 *
 * A switch on `type` rather than a scan for likely-looking fields: `number` is a
 * work item on `set_work_item_state` and would be read as one on any action that
 * grows a field by that name. Actions with no external subject — an escalation,
 * a note to an agent that names no origin, a no-op — return null and draw a dash.
 */
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
    case 'merge_pr': {
      const n = num(action.prNumber);
      return n === null ? null : `pr:${n}`;
    }
    case 'set_work_item_state': {
      const n = num(action.number);
      return n === null ? null : `issue:${n}`;
    }
    case 'respond_to_agent': {
      // The note covers a set of PR concerns; the first is the one the row is
      // about. One of several is a better answer than none, and naming them all
      // would be a column that wraps.
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
    // First writer wins so an authoritative item url is never overwritten by a
    // resolver fallback, and empty keys/urls are skipped.
    if (key && url && !(key in map)) map[key] = url;
  };

  for (const pr of pullRequests) {
    // Prefer the provider's own html_url; fall back to resolving the number.
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
