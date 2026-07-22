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
export interface RefUrlInputs {
  /** Open PRs in the world — keyed by `#<number>` and their branch. */
  pullRequests: { number: number; branch: string; url?: string }[];
  /** Open issues — keyed by `#<number>`, plus their linked PR. */
  issues: { number: number; url?: string; linkedPrNumber: number | null }[];
  /** Branches the tracked tasks operate on (nulls ignored). */
  taskBranches: (string | null)[];
  /** The provider's canonical ref → URL resolver (returns null when it can't). */
  resolve: (ref: string) => string | null;
}

export function buildRefUrls(inputs: RefUrlInputs): Record<string, string> {
  const { pullRequests, issues, taskBranches, resolve } = inputs;
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
  return map;
}
