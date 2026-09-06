// → docs/spec/15-integrations.md

export function githubRefUrl(owner: string, repo: string, ref: string): string | null {
  const base = `https://github.com/${owner}/${repo}`;
  const r = ref.trim();
  if (!r) return null;

  let m = /^pr:(\d+)(?::|$)/.exec(r);
  if (m) return `${base}/pull/${m[1]}`;

  m = /^issue:(\d+):comment:(\d+)$/.exec(r);
  if (m) return `${base}/issues/${m[1]}#issuecomment-${m[2]}`;

  m = /^issue:(\d+)(?::|$)/.exec(r);
  if (m) return `${base}/issues/${m[1]}`;

  m = /^commit:([0-9a-f]{4,40})$/i.exec(r);
  if (m) return `${base}/commit/${m[1]}`;

  m = /^#?(\d+)$/.exec(r);
  if (m) return `${base}/issues/${m[1]}`;

  if (/^[\w.\-/]+$/.test(r)) return `${base}/tree/${r}`;

  return null;
}
