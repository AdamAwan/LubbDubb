import type { Issue, TicketRow } from './types.js';
import { watchBucket } from './worldBuckets.js';
import type { TagTone } from './components/tag.js';

/**
 * The tickets tab's second axis, beside the watch buckets: **what a thing is**,
 * rather than whether the harness is allowed to touch it.
 *
 * A flat list treats a Feature as one more row to scan past, which it is not —
 * nothing is ever dispatched at one, so a list mixing them with workable items
 * asks an operator to remember which is which on every read. Grouping says it
 * structurally: a feature is a *heading*, and the things under it are the work.
 *
 * The arrangement is pure over the already-filtered rows, so the filters decide
 * what is visible and this only decides how what remains is laid out. It groups
 * the **mirror's** rows off their own parent columns rather than the world's
 * relations, which is what lets a *frozen* row keep its heading: its feature is
 * the one it was last seen under, and an arrangement that could only read the live
 * world would drop every closed item into one nameless pile.
 */

/** One feature and the rows under it, or one of the two headless runs. */
export interface TicketFeatureBlock {
  /** Stable across renders, and distinct between the two headless kinds. */
  key: string;
  /** The feature these rows hang under, or null on both headless kinds. */
  feature: { number: number; title: string; slot: number | null } | null;
  /** True for the trailing group the tracker says has no parent at all. */
  orphans: boolean;
  rows: TicketRow[];
}

/**
 * Arrange rows under their features.
 *
 * Three kinds, and the third is the one that matters: a row whose parent was never
 * resolved is **not** an orphan. It draws flush with no heading at all, because
 * filing it under "no feature" would accuse a GitHub issue of missing something its
 * tracker never had — the same distinction the mirror's `parent_known` column
 * exists to keep.
 *
 * Headless rows first, then the tree, then the exception: the parentless group is
 * an exception rather than a peer, and burying it between two features is how it
 * stops being read. Rows keep the order the list gave them, which is the ordering
 * the operator chose.
 */
export function featureBlocks(rows: readonly TicketRow[]): TicketFeatureBlock[] {
  const byFeature = new Map<number, TicketFeatureBlock>();
  const orphans: TicketRow[] = [];
  const untracked: TicketRow[] = [];

  for (const row of rows) {
    if (row.parent) {
      const existing = byFeature.get(row.parent.number);
      if (existing) existing.rows.push(row);
      else {
        byFeature.set(row.parent.number, {
          key: `f${row.parent.number}`,
          feature: { number: row.parent.number, title: row.parent.title, slot: row.featureSlot },
          orphans: false,
          rows: [row],
        });
      }
    } else if (row.parent === null) orphans.push(row);
    else untracked.push(row);
  }

  return [
    ...(untracked.length > 0 ? [{ key: 'untracked', feature: null, orphans: false, rows: untracked }] : []),
    ...byFeature.values(),
    ...(orphans.length > 0 ? [{ key: 'orphans', feature: null, orphans: true, rows: orphans }] : []),
  ];
}

/**
 * Is this item a container under the operator's own policy — the cockpit's half
 * of `isContainerIssue`, reading the `containerTypes` the state snapshot ships.
 *
 * It asks the **type**, deliberately, and not `pickup.status === 'container'`: an
 * ignored container reports `ignored` and a gate-off deployment reports something
 * else again, so a verdict-based reading would move a Feature in and out of the
 * heading position as its tags changed. Case-insensitive, because a process
 * template's type names are display strings.
 */
export function isContainerType(issue: Issue, containerTypes: readonly string[]): boolean {
  if (issue.issueType === undefined) return false;
  const needle = issue.issueType.trim().toLowerCase();
  return containerTypes.some((t) => t.trim().toLowerCase() === needle);
}

/**
 * What a watch click on this item will *also* reach, as the phrase its title ends
 * with — ` and its 8 child items`, or empty for an item that holds no work.
 *
 * Pure and separate from the control that renders it, because the invariant is
 * about the words rather than the markup: **a click that writes eight tags must
 * say eight**. Watching a container cascades to every item beneath it, and a button
 * that promised less than it did would be the operator discovering the difference
 * afterwards, in the dispatch log.
 *
 * The count is the container's own children — the server walks the whole tree, and
 * this is the number the operator can see and check.
 */
export function cascadeNote(issue: Issue, containerTypes: readonly string[]): string {
  if (!isContainerType(issue, containerTypes)) return '';
  const kids = issue.children?.length ?? 0;
  return kids === 0 ? '' : ` and its ${kids} child item${kids === 1 ? '' : 's'}`;
}

/**
 * Which of the two readings of the watch tag the toggle draws, for one row.
 *
 * There are two, and picking the wrong one is a control that never visibly moves.
 * The **world** is the live reading: the watch route folds a write the provider
 * confirmed straight onto the baseline and the click refetches `/api/state`, so it
 * is right the instant the click returns. `TicketRow.watch` is the **mirror's**,
 * and the mirror is a record — the tab does not refetch its page on a click, and
 * the sweep that would refresh it runs last in a cycle that coalesces away while
 * another is in flight. Reading it first left an operator clicking Unwatch on a
 * row that went on reporting `watched` however many times they clicked, with the
 * tag long gone from the tracker (issue #417).
 *
 * So the world wins wherever it holds the item. The mirror answers only for the
 * rows it no longer does — which are exactly the rows whose buttons are disabled
 * anyway, so the fallback decides how a dead row *reads* and never what a click
 * does. A feature heading passes no row and is always in the world, or it would
 * not have been drawn.
 *
 * Pure and separate from the control, for `cascadeNote`'s reason: the invariant is
 * about which of two inputs is believed, which no render can show.
 */
export function watchReading(
  issue: { labels?: string[] } | null,
  row: Pick<TicketRow, 'watch'> | null,
  watchLabel: string,
): 'watched' | 'unwatched' {
  if (issue === null) return row?.watch ?? 'unwatched';
  return watchBucket(issue.labels, watchLabel);
}

/**
 * Which colour family a work-item type is drawn in — `bug`, `story`, `debt`,
 * `container`, `task`, or `''` for a type the cockpit has no opinion about.
 *
 * A **family**, not the type itself, because the vocabulary is the tracker's: a
 * process template can name its types anything, and a class per literal string
 * would leave a customised board's rows uncoloured while looking like it worked.
 * Everything unrecognised falls through to the empty tone and draws exactly as it
 * did before there were tones at all — the one behaviour that must not depend on
 * whose board it is.
 *
 * Membership is the stock Azure vocabulary `src/issueRelations.ts` states its own
 * defaults in, so the families a reader learns from the list are the ones the
 * dispatcher already gates on. It is the *default* vocabulary and not the
 * operator's `issueContainerTypes`, which is why the container arm is a tone and
 * never a verdict: a customised process template's own container name draws
 * untinted here, where reading it as workable would have been the lie.
 */
export function issueTypeTone(issueType: string | null | undefined): TagTone | undefined {
  if (issueType === null || issueType === undefined) return undefined;
  switch (issueType.trim().toLowerCase()) {
    case 'bug':
    case 'defect':
      return 'red';
    case 'feature':
    case 'epic':
      return 'violet';
    case 'user story':
    case 'story':
    case 'product backlog item':
    case 'requirement':
      return 'green';
    case 'tech debt':
    case 'technical debt':
    case 'debt':
      return 'amber';
    case 'task':
      return 'blue';
    default:
      return undefined;
  }
}
