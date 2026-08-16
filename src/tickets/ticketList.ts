import type { MirroredTicket } from '../store/tickets.js';
import { watchBucketOf } from '../watchLabels.js';
import type {
  TicketFeatureFacet,
  TicketOrder,
  TicketRow,
  TicketStateFacet,
  TicketStateFilter,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../wire.js';

/** How many rows one page of the Tickets tab carries. */
export const TICKET_PAGE = 40;

/** The legend's bucket for an item with no parent at all. */
export const NO_FEATURE = 'none';

/** What the route asks for: the filter axes, an ordering, and where the last page stopped. */
interface TicketQuery {
  watch: TicketWatchFilter;
  /** The harness's reading: live, frozen, or both. */
  tracking: TicketTrackingFilter;
  /** The tracker's own word — `any`, or a native state exactly as the provider spells it. */
  state: TicketStateFilter;
  /** A feature number, `none` for the orphans, or null for every feature. */
  feature: number | typeof NO_FEATURE | null;
  order: TicketOrder;
  /** The previous page's last row, as `<sort key>:<number>`. Null for the first page. */
  cursor: string | null;
}

/** One page, and enough about the whole filtered set to say where in it you are. */
interface TicketPage {
  rows: TicketRow[];
  /** Rows matching the filters, all of them — what makes "40 of 906" sayable. */
  total: number;
  /** The whole mirror, unfiltered — the size of the history, which no filter changes. */
  kept: number;
  /** How many of the mirror's rows are live, unfiltered — the work surface's own population. */
  live: number;
  /** Total cost across the filtered set, not the page. */
  totalCostUsd: number;
  /** The cursor for the next page, or null at the foot of the list. */
  nextCursor: string | null;
  /**
   * The native states the *whole mirror* carries, not the filtered set — a facet
   * counted after its own filter would show `1` beside whichever state was
   * selected and nothing beside the rest, which is a control that erases the
   * alternatives the moment you use it.
   */
  states: TicketStateFacet[];
  /** The features the mirror's rows hang off, counted the same way and for the same reason. */
  features: TicketFeatureFacet[];
  orphanCount: number;
}

interface BuildInput {
  items: readonly MirroredTicket[];
  /** Dollars spent under each goal, by issue number — `buildSpendGoals`' answer, never a second rollup. */
  costs: ReadonlyMap<number, number>;
  /** The harness's own outcome word for a goal it worked, by issue number. */
  outcomes: ReadonlyMap<number, string>;
  /** Which hue each feature draws in, by feature number — the store's persisted assignment. */
  featureSlots: ReadonlyMap<number, number>;
  /**
   * The operator's `pickupStates`, so the state facets can mark which ones let an
   * item through. Read from config rather than inferred: "why is Ready worked and
   * New not" is the most-asked question about an Azure deployment, and inferring
   * the answer from what happens to have been dispatched would sometimes be wrong.
   */
  pickupStates: readonly string[];
  watchLabel: string;
  ignoreLabel: string;
  query: TicketQuery;
}

/**
 * One page of the Tickets tab, from the mirror's rows (issue #329).
 *
 * Pure, and the whole of the query: the mirror hands back its rows and everything
 * that makes a *list* of them happens here. That is not a shortcut around SQL —
 * neither axis is the table's to know. The watch bucket is a function of the
 * operator's label prefix, so a materialised column would be a stale copy of config
 * the moment the prefix changed; cost is `buildSpendGoals`' answer and moves every
 * pulse. Both would drift invisibly, which is the one failure mode this codebase
 * spends the most effort refusing.
 *
 * What that costs is reading the mirror whole per request. It is affordable for a
 * stated reason rather than by luck: a row is one line with no body, the table is
 * bounded by the tracker's assigned backlog rather than by time, and the route is
 * fetched when the tab opens instead of on the cockpit's poll. If a deployment ever
 * outgrows that, the fix is a cost column refreshed by the sweep — and it should be
 * taken only then, because it trades this module's one honest source for two.
 */
export function buildTicketPage(input: BuildInput): TicketPage {
  const { items, costs, outcomes, featureSlots, pickupStates, watchLabel, ignoreLabel, query } = input;

  const matching: TicketRow[] = [];
  let totalCostUsd = 0;
  let live = 0;
  const stateCounts = new Map<string, number>();
  const featureCounts = new Map<number, { title: string; count: number }>();
  let orphanCount = 0;

  for (const item of items) {
    if (item.tracking === 'live') live += 1;
    // Facets are counted over the whole mirror, before any filter — see `states`.
    if (item.workItemState !== null)
      stateCounts.set(item.workItemState, (stateCounts.get(item.workItemState) ?? 0) + 1);
    if (item.parent) {
      const seen = featureCounts.get(item.parent.number);
      featureCounts.set(item.parent.number, { title: item.parent.title, count: (seen?.count ?? 0) + 1 });
    } else if (item.parent === null) {
      // Only a *resolved* absence is an orphan. An unreadable link is neither a
      // feature nor "no feature", and counting it here would put items in a bucket
      // that claims to know something about them.
      orphanCount += 1;
    }

    if (query.tracking !== 'any' && item.tracking !== query.tracking) continue;
    if (query.state !== 'any' && item.workItemState !== query.state) continue;
    if (query.feature !== null) {
      if (query.feature === NO_FEATURE) {
        if (item.parent !== null) continue;
      } else if (item.parent?.number !== query.feature) continue;
    }
    const watch = watchBucketOf(item.labels, { watchLabel, ignoreLabel });
    if (query.watch !== 'any' && watch !== query.watch) continue;
    // Absent, not zero: a goal nobody ever staffed and a goal that somehow cost
    // nothing are different facts, and `$0.00` would state the wrong one.
    const costUsd = costs.get(item.number) ?? null;
    totalCostUsd += costUsd ?? 0;
    matching.push({
      number: item.number,
      title: item.title,
      state: item.state,
      watch,
      labels: item.labels,
      costUsd,
      outcome: outcomes.get(item.number) ?? null,
      addedAt: item.createdAt,
      changedAt: item.changedAt,
      tracking: item.tracking,
      workItemState: item.workItemState,
      issueType: item.issueType,
      // Spread, so an unresolved parent stays *absent* on the wire rather than
      // arriving as a null the cockpit would read as "no feature".
      ...(item.parent === undefined ? {} : { parent: item.parent }),
      featureSlot: item.parent ? (featureSlots.get(item.parent.number) ?? null) : null,
    });
  }

  // `items` arrives in tracker-id order, which is already the `added` ordering —
  // an id is auto-incremental, so it is arrival order with no date to parse. Only
  // the cost ordering re-sorts, and it breaks ties on the number so two tickets
  // that cost the same can never swap between pages and hide a row.
  if (query.order === 'cost') {
    matching.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.number - a.number);
  } else if (query.order === 'changed') {
    // Newest change first, ties broken on the number for the cost ordering's
    // reason: two items touched in the same second must not be able to swap
    // between two pages and hide a row between them.
    matching.sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : b.number - a.number));
  }

  // Keyset rather than an offset: a sweep landing between two pages shifts an
  // offset and makes a row appear twice or not at all. A key names the row the last
  // page stopped at, so the next page starts after *it* whatever moved.
  const start = query.cursor === null ? 0 : afterCursor(matching, query.cursor, query.order);
  const rows = matching.slice(start, start + TICKET_PAGE);
  const end = start + rows.length;
  const last = rows[rows.length - 1];
  return {
    rows,
    total: matching.length,
    kept: items.length,
    live,
    totalCostUsd: round(totalCostUsd),
    nextCursor: end < matching.length && last ? cursorFor(last, query.order) : null,
    // Descending by count, so the states and features a reader actually has land
    // first — and, for features, so the hue ladder is spent on the ones they see.
    states: [...stateCounts]
      .map(([state, count]) => ({ state, count, pickup: pickupStates.includes(state) }))
      .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state)),
    features: [...featureCounts]
      .map(([number, f]) => ({ number, title: f.title, slot: featureSlots.get(number) ?? 0, count: f.count }))
      .sort((a, b) => b.count - a.count || a.number - b.number),
    orphanCount,
  };
}

/** A row's position in the ordering, as `<sort key>:<number>`. */
function cursorFor(row: TicketRow, order: TicketOrder): string {
  if (order === 'cost') return `${row.costUsd ?? -1}:${row.number}`;
  if (order === 'changed') return `${row.changedAt}:${row.number}`;
  return `${row.number}`;
}

/**
 * Where the next page starts: one past the row the cursor names.
 *
 * A cursor whose row has since left the filtered set (an item closed while someone
 * scrolled, on a list filtered to open) finds nothing, and the answer is to start
 * again from the top rather than to guess a position. Repeating rows is the
 * failure a reader can see and dismiss; silently skipping a page is not.
 */
function afterCursor(rows: readonly TicketRow[], cursor: string, order: TicketOrder): number {
  const index = rows.findIndex((row) => cursorFor(row, order) === cursor);
  return index === -1 ? 0 : index + 1;
}

/** Cents, so a page total does not read as float noise. */
function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}
