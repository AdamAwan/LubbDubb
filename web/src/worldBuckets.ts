// → docs/spec/17-cockpit.md

type WatchBucket = 'watched' | 'unwatched';

export function watchBucket(labels: string[] | undefined, watchLabel: string): WatchBucket {
  if (!watchLabel) return 'watched';
  return (labels ?? []).includes(watchLabel) ? 'watched' : 'unwatched';
}

export function untriagedCount(issues: readonly { state: string; labels: string[] }[], watchLabel: string): number {
  let n = 0;
  for (const issue of issues) {
    if (issue.state !== 'open') continue;
    if (watchBucket(issue.labels, watchLabel) === 'unwatched') n += 1;
  }
  return n;
}
