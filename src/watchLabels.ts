/**
 * The one label model behind the cockpit's watch/ignore toggle, shared by PRs,
 * issues and stories. An operator configures a single `labelPrefix` (e.g.
 * `"lubbdubb"`); from it we derive the pair of labels the toggle writes and the
 * gates read:
 *
 * - `${prefix}-watch` — "work this"
 * - `${prefix}-ignore` — "leave this alone"
 *
 * Both labels are meaningful on every item type; only the *no-tag default*
 * differs: PRs are opt-out (watched unless ignored), issues/stories are opt-in
 * (ignored unless watched). Keeping the precedence in one pure function means the
 * dispatcher, `prHealth`, the server and the cockpit can't drift apart.
 */

export interface WatchLabels {
  /** `${prefix}-watch` — an explicit "work this" tag. */
  watchLabel: string;
  /** `${prefix}-ignore` — an explicit "leave this alone" tag (always wins). */
  ignoreLabel: string;
}

/**
 * Derive the watch/ignore label pair from the operator's prefix. An empty prefix
 * yields empty labels, which the gates read as "feature off" (PRs never excluded,
 * issues/stories never watch-gated) — the escape hatch tests use to exercise
 * dispatch mechanics without the opt-in gate.
 */
export function watchLabelsFor(prefix: string): WatchLabels {
  if (!prefix) return { watchLabel: '', ignoreLabel: '' };
  return { watchLabel: `${prefix}-watch`, ignoreLabel: `${prefix}-ignore` };
}

export type WatchState = 'watched' | 'ignored';

export interface ResolveWatchOpts extends WatchLabels {
  /**
   * What an item with neither tag defaults to: `true` for PRs (opt-out), `false`
   * for issues/stories (opt-in).
   */
  defaultWatched: boolean;
}

/**
 * The single precedence rule for watch vs ignore: an explicit ignore always
 * wins, then an explicit watch, else the type default. Total — never throws;
 * missing/empty labels (feature effectively off) fall through to the default.
 */
export function resolveWatchState(labels: string[] | undefined, opts: ResolveWatchOpts): WatchState {
  const present = labels ?? [];
  if (opts.ignoreLabel && present.includes(opts.ignoreLabel)) return 'ignored';
  if (opts.watchLabel && present.includes(opts.watchLabel)) return 'watched';
  return opts.defaultWatched ? 'watched' : 'ignored';
}
