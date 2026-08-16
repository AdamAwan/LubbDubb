/**
 * Which World-panel tab an item belongs in, from its labels alone.
 *
 * Deliberately **not** `resolveWatchState` (`src/watchLabels.ts`), which the web
 * bundle couldn't import anyway: that answers the *gate's* question and is
 * therefore binary — an untagged issue resolves to `ignored`, because the gate
 * only cares that it won't be worked. The panel has to tell those two apart, since
 * "you tagged this leave-alone" and "you haven't looked at this yet" are the
 * ignored/unwatched split `issuePickupStatus` already reports and the difference
 * between a row that is settled and a row that is waiting on a triage pass. The
 * precedence is the server's, though: ignore wins, then watch, else the type
 * default (PRs opt-out, issues opt-in).
 */
type WatchBucket = 'watched' | 'unwatched' | 'ignored';

interface WatchBucketOpts {
  watchLabel: string;
  ignoreLabel: string;
  /** What an untagged item defaults to: `true` for PRs, `false` for issues. */
  defaultWatched: boolean;
}

/**
 * Total — never throws. Empty labels mean the operator turned the gates off
 * (`labelPrefix: ''`), so every item falls through to its type default and the
 * `unwatched`/`ignored` buckets stay empty; the panel hides the tab bar in that
 * case rather than offer two tabs that can only ever be empty.
 */
export function watchBucket(labels: string[] | undefined, opts: WatchBucketOpts): WatchBucket {
  const present = labels ?? [];
  if (opts.ignoreLabel && present.includes(opts.ignoreLabel)) return 'ignored';
  if (opts.watchLabel && present.includes(opts.watchLabel)) return 'watched';
  return opts.defaultWatched ? 'watched' : 'unwatched';
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
 * neither watchable nor ignorable, so it is not waiting on anybody.
 */
export function untriagedCount(
  issues: readonly { state: string; labels: string[] }[],
  opts: { watchLabel: string; ignoreLabel: string },
): number {
  let n = 0;
  for (const issue of issues) {
    if (issue.state !== 'open') continue;
    if (watchBucket(issue.labels, { ...opts, defaultWatched: false }) === 'unwatched') n += 1;
  }
  return n;
}
