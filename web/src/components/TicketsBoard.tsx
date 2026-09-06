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

// → docs/spec/17-cockpit.md

interface BoardQuery {
  watch: TicketWatchFilter;
  tracking: TicketTrackingFilter;
  feature: number | 'none' | null;
  order: TicketOrder;
}

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
  hidden: readonly string[];
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  const { boardStates, stateRules, canSetWorkItemState } = view.state.config;
  const { columns, unlisted } = boardColumns(boardStates, facets, stateRules?.pickup ?? []);
  const shown = columns.filter((column) => !hidden.includes(column.state));
  const shownCount = useRef(shown.length);
  shownCount.current = shown.length;

  const [drag, setDrag] = useState<{ row: TicketRow; from: string } | null>(null);
  const [placed, setPlaced] = useState<{ row: TicketRow; state: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const [refused, setRefused] = useState<{ number: number; message: string } | null>(null);
  const [reload, setReload] = useState(0);
  const settled = useRef(new Set<string>());
  const columnRead = useCallback((state: string) => {
    settled.current.add(state);
    if (settled.current.size >= shownCount.current) setPlaced(null);
  }, []);

  const drop = async (column: BoardColumn): Promise<void> => {
    const moving = drag;
    setDrag(null);
    if (moving === null || moving.from === column.state) return;
    setRefused(null);
    settled.current = new Set();
    setPlaced({ row: moving.row, state: column.state });
    setWriting(true);
    try {
      await actions.setIssueState(moving.row.number, column.state);
      setReload((n) => n + 1);
    } catch (err) {
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
  drag: { row: TicketRow; from: string } | null;
  placed: { row: TicketRow; state: string } | null;
  writing: boolean;
  refused: { number: number; message: string } | null;
  rules: CockpitView['state']['config']['stateRules'];
  reload: number;
  onRead: (state: string) => void;
  draggable: boolean;
  onDragStart: (row: TicketRow) => void;
  onDragEnd: () => void;
  onDrop: (column: BoardColumn) => Promise<void>;
}): JSX.Element {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  const { watch, tracking, feature, order } = query;
  const state = column.state;

  const read = useCallback(
    async (from: string | null) => {
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

  const worldIssues = view.state.world.issues;
  const live = useMemo(() => new Map<number, Issue>(worldIssues.map((issue) => [issue.number, issue])), [worldIssues]);
  const colour = stateColour(view.state.config.stateColours, column.state);

  const droppable = draggable && drag !== null;
  const warning = drag === null ? null : dropWarning(column, drag.from, rules);
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
        if (droppable) e.preventDefault();
      }}
      onDrop={() => void onDrop(column)}
    >
      <header className="tb-head">
        {/* The operator's colour letters the state's own name. It was a strip along the
            top of the header and that read as decoration; on the word it is the same
            reading the table's state chips carry. Absent leaves the name in the
            default ink, exactly as a chip with no colour draws. */}
        <b style={colour === null ? undefined : { color: colour }}>{column.state}</b>
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
