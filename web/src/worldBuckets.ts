/**
 * Which World-panel tab an item belongs in, from its labels alone.
 *
 * A mirror of `isWatched` (`src/watchLabels.ts`), which the web bundle cannot
 * import: one tag, and an item without it is unwatched. There is no third reading
 * and no type default — pull requests and issues are both opt-in, and the harness
 * tags the pull requests it opened itself, so "untagged" means the same thing on
 * every row a person is looking at: nobody has opted this in.
 */
type WatchBucket = 'watched' | 'unwatched';

/**
 * Total — never throws. An empty label means the operator turned the gate off
 * (`labelPrefix: ''`), so every item reads `watched` and the `unwatched` bucket
 * stays empty; the panel hides the tab bar in that case rather than offer a tab
 * that can only ever be empty.
 */
export function watchBucket(labels: string[] | undefined, watchLabel: string): WatchBucket {
  if (!watchLabel) return 'watched';
  return (labels ?? []).includes(watchLabel) ? 'watched' : 'unwatched';
}

/**
 * How many open items nobody has triaged — the nav's one number, and the only
 * reading that says whether the tickets tab is worth opening.
 *
 * It lived on the backlog's own grouping until that tab was folded in, and it
 * keeps that surface's invariant: **the count is what the Unwatched filter
 * shows**, so the number on the button and the rows behind it cannot differ. That
 * is why it asks the bucket and nothing else — a count that also subtracted, say,
 * the items held at intake would be a promise the list does not keep.
 *
 * Closed items are left out for the reason they always were: a closed ticket is
 * not waiting on anybody.
 */
export function untriagedCount(issues: readonly { state: string; labels: string[] }[], watchLabel: string): number {
  let n = 0;
  for (const issue of issues) {
    if (issue.state !== 'open') continue;
    if (watchBucket(issue.labels, watchLabel) === 'unwatched') n += 1;
  }
  return n;
}
