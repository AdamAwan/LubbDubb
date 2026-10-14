// → docs/spec/06-issue-pickup.md

export function watchLabelFor(prefix: string): string {
  return prefix ? `${prefix}-watch` : '';
}

export function isWatched(labels: string[] | undefined, watchLabel: string): boolean {
  if (!watchLabel) return true;
  return (labels ?? []).includes(watchLabel);
}

export function investigateLabelFor(prefix: string): string {
  return prefix ? `${prefix}-investigate` : 'investigate';
}

export function carriesInvestigateLabel(
  issue: { labels: string[]; labelsAddedByViewer?: string[] },
  label: string,
  requireOwnLabel: boolean | undefined,
): boolean {
  const labels = requireOwnLabel ? (issue.labelsAddedByViewer ?? []) : issue.labels;
  return labels.includes(label);
}
