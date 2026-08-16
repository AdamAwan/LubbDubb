/**
 * The one label model behind the cockpit's watch/ignore toggle, shared by PRs,
 * issues. An operator configures a single `labelPrefix` (e.g.
 * `"lubbdubb"`); from it we derive the pair of labels the toggle writes and the
 * gates read:
 *
 * - `${prefix}-watch` — "work this"
 * - `${prefix}-ignore` — "leave this alone"
 *
 * Both labels are meaningful on every item type; only the *no-tag default*
 * differs: PRs are opt-out (watched unless ignored), issues are opt-in
 * (ignored unless watched). Keeping the precedence in one pure function means the
 * dispatcher, `prHealth`, the server and the cockpit can't drift apart.
 */

interface WatchLabels {
  /** `${prefix}-watch` — an explicit "work this" tag. */
  watchLabel: string;
  /** `${prefix}-ignore` — an explicit "leave this alone" tag (always wins). */
  ignoreLabel: string;
}

/**
 * Derive the watch/ignore label pair from the operator's prefix. An empty prefix
 * yields empty labels, which the gates read as "feature off" (PRs never excluded,
 * issues never watch-gated) — the escape hatch tests use to exercise
 * dispatch mechanics without the opt-in gate.
 */
export function watchLabelsFor(prefix: string): WatchLabels {
  if (!prefix) return { watchLabel: '', ignoreLabel: '' };
  return { watchLabel: `${prefix}-watch`, ignoreLabel: `${prefix}-ignore` };
}

type WatchState = 'watched' | 'ignored';

interface ResolveWatchOpts extends WatchLabels {
  /**
   * What an item with neither tag defaults to: `true` for PRs (opt-out), `false`
   * for issues (opt-in).
   */
  defaultWatched: boolean;
}

/**
 * The three readings the labels actually carry: tagged leave-alone, tagged
 * work-this, or neither.
 *
 * The gate below folds the third into `ignored`, because a gate only needs to know
 * whether to act. A *surface* has to keep them apart — "you told me to leave this"
 * and "nobody has looked at this yet" are different states of a backlog, and the
 * Tickets tab filters on the difference. Both readings are this one precedence, so
 * a tag can never mean one thing to the dispatcher and another to the list.
 */
export type WatchBucket = 'watched' | 'unwatched' | 'ignored';

/** Ignore wins, then watch, else neither. Total — never throws. */
export function watchBucketOf(labels: string[] | undefined, opts: WatchLabels): WatchBucket {
  const present = labels ?? [];
  if (opts.ignoreLabel && present.includes(opts.ignoreLabel)) return 'ignored';
  if (opts.watchLabel && present.includes(opts.watchLabel)) return 'watched';
  return 'unwatched';
}

/**
 * The single precedence rule for watch vs ignore: an explicit ignore always
 * wins, then an explicit watch, else the type default. Total — never throws;
 * missing/empty labels (feature effectively off) fall through to the default.
 */
export function resolveWatchState(labels: string[] | undefined, opts: ResolveWatchOpts): WatchState {
  const bucket = watchBucketOf(labels, opts);
  if (bucket !== 'unwatched') return bucket;
  return opts.defaultWatched ? 'watched' : 'ignored';
}
