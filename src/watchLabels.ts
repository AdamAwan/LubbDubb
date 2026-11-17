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

/** What a repo lesson's pull request or ticket carries. → docs/spec/41-repo-lessons.md#the-outcome */
export function lessonLabelFor(prefix: string): string {
  return prefix ? `${prefix}-lesson` : 'lesson';
}

/** The labels pickup reads: only the viewer's own under `requireOwnLabel`, else all of them. */
export function pickupLabels(
  issue: { labels: string[]; labelsAddedByViewer?: string[] },
  requireOwnLabel: boolean | undefined,
): string[] {
  return requireOwnLabel ? (issue.labelsAddedByViewer ?? []) : issue.labels;
}
