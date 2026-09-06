// → docs/spec/06-issue-pickup.md (the watch label), docs/spec/07-pull-requests.md#watching-a-pull-request

export function watchLabelFor(prefix: string): string {
  return prefix ? `${prefix}-watch` : '';
}

export function isWatched(labels: string[] | undefined, watchLabel: string): boolean {
  if (!watchLabel) return true;
  return (labels ?? []).includes(watchLabel);
}
