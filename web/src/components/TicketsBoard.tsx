import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { boardColumns, dropWarning, type BoardColumn } from '../ticketBoard.js';
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
  // In a ref so `columnRead` below can read the current count without being rebuilt
  // on every render — a new callback identity would re-run every column's fetch.
  const shownCount = useRef(shown.length);
  shownCount.current = shown.length;

  // Held here rather than in a column, because the warnings are about *every* header
  // at once: the whole board's consequences have to be readable before a choice is
  // made rather than after it, which is the habit `stateWhy` and `cascadeNote` keep.
  const [drag, setDrag] = useState<{ row: TicketRow; from: string } | null>(null);
  /**
   * Where the board believes the dragged card is, until real rows say so.
   *
   * It exists only to bridge the drop and the arrival of a fresh page: the route
   * writes to the provider, patches both readings, broadcasts and runs a cycle before
   * it answers, which is long enough that a card left in its old column reads as a
   * drop that missed.
   *
   * **It is released as soon as every drawn column has completed a read**, which is
   * the condition rather than a delay — see {@link settled}. Held any longer it
   * starts lying: one slot cannot describe two moved cards, so a second drop used to
   * revert the first, and a placement surviving a filter change force-drew a card the
   * filter excludes.
   */
  const [placed, setPlaced] = useState<{ row: TicketRow; state: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const [refused, setRefused] = useState<{ number: number; message: string } | null>(null);
  /**
   * Bumped once per landed write, and in every column's fetch dependencies — so a
   * drop re-reads the board from the mirror the route has just patched.
   *
   * Without it `placed` is the *only* thing putting a moved card in its new column,
   * and `placed` is one slot: a second drop replaces it and the first card falls back
   * to its column's never-refreshed page, which is where it started. One drag then
   * appears to move two cards, and the board disagrees with the tracker until
   * something else happens to refetch.
   */
  const [reload, setReload] = useState(0);
  /**
   * Which columns have finished a read since the placement was made.
   *
   * Counted rather than waited on: the round trip is a provider write plus a pulse,
   * so any timeout long enough to be safe is long enough to be visible. Once every
   * drawn column has re-read, the pages are the truth and the placement is retired.
   */
  const settled = useRef(new Set<string>());
  const columnRead = useCallback((state: string) => {
    settled.current.add(state);
    // Read off `shown` at call time rather than captured, so hiding a column while a
    // write is out cannot leave the placement waiting for a column nobody draws.
    if (settled.current.size >= shownCount.current) setPlaced(null);
  }, []);

  const drop = async (column: BoardColumn): Promise<void> => {
    const moving = drag;
    setDrag(null);
    if (moving === null || moving.from === column.state) return;
    // Optimistic, because the write is a round trip to the tracker and a card that
    // sits still for a second reads as a drop that missed.
    setRefused(null);
    settled.current = new Set();
    setPlaced({ row: moving.row, state: column.state });
    setWriting(true);
    try {
      await actions.setIssueState(moving.row.number, column.state);
      // Re-read from the patched mirror, so the placement above stops being the only
      // thing holding this card in its new column.
      setReload((n) => n + 1);
    } catch (err) {
      // Back where it came from, with the provider's own words on it.
      setPlaced(null);
      setRefused({ number: moving.row.number, message: (err as Error).message });
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className="tb">
      {/* Said once, above the columns, rather than discovered one failed drag at a
          time — the same refusal five times over teaches nothing five times over. */}
      {!canSetWorkItemState && (
        <p className="tb-note">This tracker cannot write work item states, so cards here cannot be moved.</p>
      )}
      <div className="tb-cols">
        {shown.map((column) => (
          <Column
            key={column.state}
            column={column}
            query={query}
            view={view}
            actions={actions}
            now={now}
            drag={drag}
            placed={placed}
            writing={writing}
            refused={refused}
            rules={stateRules}
            reload={reload}
            onRead={columnRead}
            draggable={canSetWorkItemState}
            onDragStart={(row) => setDrag({ row, from: column.state })}
            onDragEnd={() => setDrag(null)}
            onDrop={drop}
          />
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
  drag,
  placed,
  writing,
  refused,
  rules,
  reload,
  onRead,
  draggable,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  column: BoardColumn;
  query: BoardQuery;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
  /** The card in the air and the column it left, or null when nothing is being dragged. */
  drag: { row: TicketRow; from: string } | null;
  /** Where the board believes a just-dropped card is, which outlives its write. */
  placed: { row: TicketRow; state: string } | null;
  writing: boolean;
  refused: { number: number; message: string } | null;
  rules: CockpitView['state']['config']['stateRules'];
  /** Bumped by the board on every landed write; re-reads this column's first page. */
  reload: number;
  /** Reported after every completed read, so the board can retire its placement. */
  onRead: (state: string) => void;
  draggable: boolean;
  onDragStart: (row: TicketRow) => void;
  /**
   * The end of a drag however it ended, which is the only signal an *abandoned* one
   * gives. Without it a drag released outside every column leaves the board armed:
   * the headers go on speaking, and the next stray drop writes the state of a card
   * nobody is holding.
   */
  onDragEnd: () => void;
  onDrop: (column: BoardColumn) => Promise<void>;
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
      // Referenced, not sent: the generation is a local signal, so naming it here is
      // what changes this callback's identity when the board reports a landed write —
      // which re-runs the effect below and re-reads the patched mirror. Keeping the
      // column's state rather than remounting it is deliberate: a remount would drop
      // the pages and the scroll position a reader had built up.
      void reload;
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
      onRead(state);
    },
    [watch, tracking, state, feature, order, reload, onRead],
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

  // Only while something is in the air, and only where a write is possible at all —
  // a drop target on a deployment that cannot write is a dead end nobody can explain.
  const droppable = draggable && drag !== null;
  const warning = drag === null ? null : dropWarning(column, drag.from, rules);
  // The moving card is drawn in the column it was dropped on while the write is in
  // flight, and out of the one it left, or it would appear in both at once.
  // Reconciled by number, so a column whose own page already lists the card draws it
  // once — the placement is an override of a stale page, never a second copy.
  const shown =
    placed === null
      ? rows
      : placed.state === column.state
        ? [placed.row, ...rows.filter((row) => row.number !== placed.row.number)]
        : rows.filter((row) => row.number !== placed.row.number);

  return (
    <section
      className={`tb-col${droppable ? ' droppable' : ''}`}
      onDragOver={(e) => {
        // Preventing the default is what marks this a valid target; without it the
        // drop event never fires and the card silently springs back.
        if (droppable) e.preventDefault();
      }}
      onDrop={() => void onDrop(column)}
    >
      <header className="tb-head" style={colour === null ? undefined : { borderTopColor: colour }}>
        <b>{column.state}</b>
        {column.pickup && <i className="tickets-gate">▲</i>}
        <i className="tb-k">
          {rows.length} of {(total ?? column.count).toLocaleString()}
        </i>
        {warning !== null && draggable && <span className={`tb-say ${warning.tone}`}>{warning.words}</span>}
      </header>
      <div className="tb-body">
        <RefLinksExtended refUrls={refUrls}>
          {shown.map((row) => (
            <TicketCard
              key={row.number}
              row={row}
              issue={live.get(row.number) ?? null}
              view={view}
              actions={actions}
              now={now}
              draggable={draggable}
              writing={writing && placed?.row.number === row.number ? placed.state : null}
              refused={refused !== null && refused.number === row.number ? refused.message : null}
              onDragStart={() => onDragStart(row)}
              onDragEnd={onDragEnd}
            />
          ))}
        </RefLinksExtended>
        <div className="tb-foot" ref={foot}>
          {loading && <span className="tickets-spin" aria-hidden="true" />}
          {columnFoot({ loading, empty: shown.length === 0, column, tracking })}
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
