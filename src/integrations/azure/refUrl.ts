/**
 * Canonical Azure DevOps web-URL construction for a harness reference — the Azure
 * half of what `githubRefUrl` does for GitHub, so the cockpit never string-builds
 * a `dev.azure.com/...` link.
 *
 * Handles the ref shapes the harness actually produces: PR/work-item origin refs
 * (`pr:42:ci`, `issue:13`), the comment ref, explicit commit refs, and branch
 * names. Anything unrecognised returns `null` — it has no Azure page.
 *
 * Azure splits what GitHub joins: work items live under the **project**
 * (`_workitems`), pull requests and branches under a **repository** inside it
 * (`_git/<repo>`). One function still covers both because one resolver has to
 * answer every shape — `CompositeConnector.resolveRefUrl` routes to the *first*
 * integration that can resolve, not to the one whose capability matches the ref.
 */
export function azureRefUrl(organization: string, project: string, repository: string, ref: string): string | null {
  const projectUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
  const repoUrl = `${projectUrl}/_git/${encodeURIComponent(repository)}`;
  const r = ref.trim();
  if (!r) return null;

  // PR origin refs: `pr:42`, `pr:42:ci`, `pr:42:comment:c_x` → the PR page.
  let m = /^pr:(\d+)(?::|$)/.exec(r);
  if (m) return `${repoUrl}/pullrequest/${m[1]}`;

  // A comment the harness maintains on a work item: `issue:13:comment:456` → the
  // work item with that discussion comment selected. Azure's deep link is
  // `?discussionId=<numeric comment id>`, so a non-numeric id (another provider's,
  // or the `fake` connector's `comment_1`) falls through to the plain item page
  // rather than building an anchor that selects nothing — the same call
  // `githubRefUrl` makes, for the same reason: the comment *is* on that item.
  m = /^issue:(\d+):comment:(\d+)$/.exec(r);
  if (m) return `${projectUrl}/_workitems/edit/${m[1]}?discussionId=${m[2]}`;

  // Work-item refs: `issue:13`, and the suffixed shapes the funnel writes —
  // `issue:13:plan` and `issue:13:part:<slug>` — all name the same work item,
  // exactly as the PR shapes above all name one PR.
  m = /^issue:(\d+)(?::|$)/.exec(r);
  if (m) return `${projectUrl}/_workitems/edit/${m[1]}`;

  // Explicit commit ref: `commit:<sha>` → the commit page.
  m = /^commit:([0-9a-f]{4,40})$/i.exec(r);
  if (m) return `${repoUrl}/commit/${m[1]}`;

  // A bare or `#`-prefixed number has no answer here, and that is deliberate:
  // Azure work items and pull requests are **disjoint id spaces**, so unlike
  // GitHub (where /issues/42 redirects to the PR if 42 is one) there is nothing to
  // guess that is right more often than it is wrong. Plain text beats a confident
  // link to an unrelated item — and it costs nothing in practice, because
  // `buildRefUrls` keys `#42` from the world's own PR and work-item urls before
  // the resolver is ever asked.
  if (/^#?\d+$/.test(r)) return null;

  // Otherwise treat it as a branch name (`issue/13`, `feat/widget`). Azure names a
  // branch through the repo's version selector, `GB` being its ref-kind prefix for
  // a branch.
  if (/^[\w.\-/]+$/.test(r)) return `${repoUrl}?version=GB${encodeURIComponent(r)}`;

  return null;
}
