import type { MirroredTicket } from '../store/tickets.js';
import { watchBucketOf } from '../watchLabels.js';
import type { TicketOrder, TicketRow, TicketStateFilter, TicketWatchFilter } from '../wire.js';

/** How many rows one page of the Tickets tab carries. */
export const TICKET_PAGE = 40;

/** What the route asks for: the two filter axes, an ordering, and where the last page stopped. */
interface TicketQuery {
  watch: TicketWatchFilter;
  state: TicketStateFilter;
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
  /** Total cost across the filtered set, not the page. */
  totalCostUsd: number;
  /** The cursor for the next page, or null at the foot of the list. */
  nextCursor: string | null;
}

interface BuildInput {
  items: readonly MirroredTicket[];
  /** Dollars spent under each goal, by issue number — `buildSpendGoals`' answer, never a second rollup. */
  costs: ReadonlyMap<number, number>;
  /** The harness's own outcome word for a goal it worked, by issue number. */
  outcomes: ReadonlyMap<number, string>;
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
  const { items, costs, outcomes, watchLabel, ignoreLabel, query } = input;

  const matching: TicketRow[] = [];
  let totalCostUsd = 0;
  for (const item of items) {
    if (query.state !== 'any' && item.state !== query.state) continue;
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
    });
  }

  // `items` arrives in tracker-id order, which is already the `added` ordering —
  // an id is auto-incremental, so it is arrival order with no date to parse. Only
  // the cost ordering re-sorts, and it breaks ties on the number so two tickets
  // that cost the same can never swap between pages and hide a row.
  if (query.order === 'cost') {
    matching.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.number - a.number);
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
    totalCostUsd: round(totalCostUsd),
    nextCursor: end < matching.length && last ? cursorFor(last, query.order) : null,
  };
}

/** A row's position in the ordering, as `<sort key>:<number>`. */
function cursorFor(row: TicketRow, order: TicketOrder): string {
  return order === 'cost' ? `${row.costUsd ?? -1}:${row.number}` : `${row.number}`;
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
