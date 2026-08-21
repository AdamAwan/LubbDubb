import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { boardColumns, type BoardColumn } from '../ticketBoard.js';
import { stateColour } from '../stateColour.js';
import type {
  Issue,
  TicketOrder,
  TicketRow,
  TicketStateFacet,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../types.js';
import type { CockpitView } from '../view/viewModel.js';
import { RefLinksExtended } from './refs.js';
import { TicketCard } from './TicketCard.js';

/** What every column's fetch is narrowed by, minus the state that makes it a column. */
interface BoardQuery {
  watch: TicketWatchFilter;
  tracking: TicketTrackingFilter;
  feature: number | 'none' | null;
  order: TicketOrder;
}

/**
 * The card view: one column per tracker state, each scrolling and paging on its own.
 *
 * **A column is a `/api/tickets` request pinned to its own state.** No new route and
 * no new payload: the list route already filters `state` as an exact match on
 * `work_item_state`, which is a column's definition. Bucketing one shared page
 * client-side was the alternative, and it makes a column's contents depend on how far
 * somebody scrolled a list that is not on screen.
 *
 * **The board scrolls sideways and each column scrolls inside itself**, so a column
 * running off the right edge hides nothing in the others.
 *
 * **A state the config omits gets no column, and the foot says so.** Items on no board
 * at all, unreported, is how a typo in `issueBoardStates` comes to look exactly like a
 * quiet tracker.
 */
export function TicketsBoard({
  query,
  facets,
  hidden,
  view,
  actions,
  now,
}: {
  query: BoardQuery;
  facets: readonly TicketStateFacet[];
  /** The columns the operator has hidden, from `Place.ticketColumns`. */
  hidden: readonly string[];
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  const { boardStates, stateRules, canSetWorkItemState } = view.state.config;
  const { columns, unlisted } = boardColumns(boardStates, facets, stateRules?.pickup ?? []);
  const shown = columns.filter((column) => !hidden.includes(column.state));

  return (
    <div className="tb">
      {/* Said once, above the columns, rather than discovered one failed drag at a
          time — the same refusal five times over teaches nothing five times over. */}
      {!canSetWorkItemState && (
        <p className="tb-note">This tracker cannot write work item states, so cards here cannot be moved.</p>
      )}
      <div className="tb-cols">
        {shown.map((column) => (
          <Column key={column.state} column={column} query={query} view={view} actions={actions} now={now} />
        ))}
      </div>
      {unlisted.length > 0 && (
        <p className="tb-unlisted">
          No column for{' '}
          {unlisted.map((facet, i) => (
            <span key={facet.state}>
              {i > 0 ? ', ' : ''}
              <b>{facet.state}</b> · {facet.count.toLocaleString()} item{facet.count === 1 ? '' : 's'}
            </span>
          ))}
          {' — '}
          <code>issueBoardStates</code> does not list {unlisted.length === 1 ? 'it' : 'them'}, so that work is on no
          board at all.
        </p>
      )}
    </div>
  );
}

/**
 * One column: its own page, its own cursor, its own observer.
 *
 * The observer is rooted on **this** column's scroll box rather than on `.cn-sit`.
 * Rooted on the situation area a column's foot would intersect as soon as the board
 * was on screen, and every column would fetch its whole history at once.
 *
 * The header count is this column's own `total` once its first page lands, and the
 * whole-mirror facet before that — so the two numbers in "12 of 218" are about one set.
 */
function Column({
  column,
  query,
  view,
  actions,
  now,
}: {
  column: BoardColumn;
  query: BoardQuery;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  // The scalars rather than the record they arrive in: `query` is rebuilt by the
  // caller on every render, so a dependency on the object identity re-runs the effect
  // every render — a fetch loop that clears the rows it just set, and looks exactly
  // like a column that never loads.
  const { watch, tracking, feature, order } = query;
  const state = column.state;

  const read = useCallback(
    async (from: string | null) => {
      setLoading(true);
      const page = await api.getTickets({
        watch,
        tracking,
        state,
        feature: feature === null ? null : String(feature),
        order,
        cursor: from,
      });
      setRows((prev) => (from === null ? page.rows : [...prev, ...page.rows]));
      setRefUrls((prev) => (from === null ? page.refUrls : { ...prev, ...page.refUrls }));
      setTotal(page.total);
      setCursor(page.nextCursor);
      setDone(page.nextCursor === null);
      setLoading(false);
    },
    [watch, tracking, state, feature, order],
  );

  useEffect(() => {
    // Cleared first, for the table's reason: a filter change must never show the
    // previous page while its own first one is in flight, or the cards read as
    // matching a filter they do not.
    setRows([]);
    setCursor(null);
    setDone(false);
    void read(null);
  }, [read]);

  const foot = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = foot.current;
    if (sentinel === null || done || loading) return;
    const root = sentinel.closest('.tb-body');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void read(cursor);
      },
      { root, rootMargin: '300px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, done, loading, read]);

  // The world, by number — the overlay every live reading on a card comes from.
  const worldIssues = view.state.world.issues;
  const live = useMemo(() => new Map<number, Issue>(worldIssues.map((issue) => [issue.number, issue])), [worldIssues]);
  const colour = stateColour(view.state.config.stateColours, column.state);

  return (
    <section className="tb-col">
      <header className="tb-head" style={colour === null ? undefined : { borderTopColor: colour }}>
        <b>{column.state}</b>
        {column.pickup && <i className="tickets-gate">▲</i>}
        <i className="tb-k">
          {rows.length} of {(total ?? column.count).toLocaleString()}
        </i>
      </header>
      <div className="tb-body">
        <RefLinksExtended refUrls={refUrls}>
          {rows.map((row) => (
            <TicketCard
              key={row.number}
              row={row}
              issue={live.get(row.number) ?? null}
              view={view}
              actions={actions}
              now={now}
              draggable={false}
            />
          ))}
        </RefLinksExtended>
        <div className="tb-foot" ref={foot}>
          {loading && <span className="tickets-spin" aria-hidden="true" />}
          {columnFoot({ loading, empty: rows.length === 0, column, tracking })}
        </div>
      </div>
    </section>
  );
}

/**
 * What the foot of a column says, in each state it has.
 *
 * Three different emptinesses, because they are three different facts — and a column
 * that simply stops reads as one that failed to load, which is the table's `footWords`
 * lesson applied per column.
 */
function columnFoot(state: {
  loading: boolean;
  empty: boolean;
  column: BoardColumn;
  tracking: TicketTrackingFilter;
}): string {
  if (state.loading || !state.empty) return '';
  if (state.column.empty) return 'Nothing has ever been in this state.';
  if (state.tracking === 'live' && state.column.live === 0) {
    return `Nothing under ${state.column.state} is still in the tracker’s open set — widen Tracking to see it.`;
  }
  return 'Nothing here matches these filters.';
}
