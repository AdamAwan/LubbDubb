// → docs/spec/15-integrations.md

export function azureRefUrl(organization: string, project: string, repository: string, ref: string): string | null {
  const projectUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
  const repoUrl = `${projectUrl}/_git/${encodeURIComponent(repository)}`;
  const r = ref.trim();
  if (!r) return null;

  let m = /^pr:(\d+)(?::|$)/.exec(r);
  if (m) return `${repoUrl}/pullrequest/${m[1]}`;

  m = /^issue:(\d+):comment:(\d+)$/.exec(r);
  if (m) return `${projectUrl}/_workitems/edit/${m[1]}?discussionId=${m[2]}`;

  m = /^issue:(\d+)(?::|$)/.exec(r);
  if (m) return `${projectUrl}/_workitems/edit/${m[1]}`;

  m = /^commit:([0-9a-f]{4,40})$/i.exec(r);
  if (m) return `${repoUrl}/commit/${m[1]}`;

  if (/^#?\d+$/.test(r)) return null;

  if (/^[\w.\-/]+$/.test(r)) return `${repoUrl}?version=GB${encodeURIComponent(r)}`;

  return null;
}
