/**
 * Canonical GitHub web-URL construction for a harness reference — the one place
 * `github.com/...` links are built, so the cockpit never string-builds them.
 *
 * Handles the ref shapes the harness actually produces: PR/issue origin refs
 * (`pr:42:ci`, `issue:13`), the universal `#42`/bare-number syntax, explicit
 * commit refs, and branch names. Non-source-control refs (`story:…`, `meeting:…`)
 * and anything unrecognised return `null` — they have no GitHub page.
 */
export function githubRefUrl(owner: string, repo: string, ref: string): string | null {
  const base = `https://github.com/${owner}/${repo}`;
  const r = ref.trim();
  if (!r) return null;

  // PR origin refs: `pr:42`, `pr:42:ci`, `pr:42:comment:c_x` → the PR page.
  let m = /^pr:(\d+)(?::|$)/.exec(r);
  if (m) return `${base}/pull/${m[1]}`;

  // Issue origin ref: `issue:13` → the issue page.
  m = /^issue:(\d+)$/.exec(r);
  if (m) return `${base}/issues/${m[1]}`;

  // Explicit commit ref: `commit:<sha>` → the commit page.
  m = /^commit:([0-9a-f]{4,40})$/i.exec(r);
  if (m) return `${base}/commit/${m[1]}`;

  // `#42` or a bare number → /issues (GitHub redirects to the PR if it is one).
  m = /^#?(\d+)$/.exec(r);
  if (m) return `${base}/issues/${m[1]}`;

  // Otherwise treat it as a branch name (`issue/13`, `feat/widget`) → its tree.
  if (/^[\w.\-/]+$/.test(r)) return `${base}/tree/${r}`;

  return null;
}
