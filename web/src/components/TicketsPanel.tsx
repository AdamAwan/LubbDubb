import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { TicketOrder, TicketRow, TicketStateFilter, TicketWatchFilter } from '../types.js';
import { Ref, RefLinksExtended } from './refs.js';
import { fmtUsd, relAge } from './util.js';

/** What the tab is narrowed to and ordered by — every field of it a `Place` field. */
interface TicketQueryPlace {
  watch: TicketWatchFilter;
  state: TicketStateFilter;
  order: TicketOrder;
}

interface TicketsPanelProps {
  query: TicketQueryPlace;
  onQuery: (next: Partial<TicketQueryPlace>) => void;
  now: number;
}

const WATCH_OPTIONS: ReadonlyArray<{ value: TicketWatchFilter; label: string; title: string }> = [
  { value: 'any', label: 'Any', title: 'Every item, however it is tagged' },
  { value: 'watched', label: 'Watched', title: 'Tagged work-this — the harness will pick these up' },
  { value: 'unwatched', label: 'Unwatched', title: 'Nobody has opted these in yet' },
  { value: 'ignored', label: 'Ignored', title: 'Tagged leave-alone — the dispatcher skips these' },
];

const STATE_OPTIONS: ReadonlyArray<{ value: TicketStateFilter; label: string; title: string }> = [
  { value: 'any', label: 'Any', title: 'Open and closed' },
  { value: 'open', label: 'Open', title: 'Still open in the tracker' },
  { value: 'closed', label: 'Closed', title: 'Closed in the tracker' },
];

/**
 * Every ticket the assignment filter has returned since the harness first swept,
 * narrowed by the harness's reading and the tracker's (issue #329).
 *
 * **Two axes, because they are two different questions.** `watch` is a label an
 * operator sets and the dispatcher's gate reads; `state` is the tracker's own word.
 * Watch is three-valued and not two — an item nobody has opted in is *unwatched*,
 * one tagged leave-alone is *ignored*, and folding them would report a triage
 * nobody made.
 *
 * **Fetched on open and per page, never polled**, like the work tree: the mirror is
 * all-time and only grows. Changing a filter starts a new list rather than
 * appending to the old one, which is what the query in the effect's dependency
 * list buys.
 *
 * The harness's own outcome for a goal rides on the row as a chip but is **not** a
 * third filter: it answers a different question from either axis, and a third
 * control would make the row a cube. And nothing here is a control that changes the
 * world — a history you can edit from is not a history.
 */
export function TicketsPanel({ query, onQuery, now }: TicketsPanelProps): JSX.Element {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [kept, setKept] = useState(0);
  const [totalCostUsd, setTotalCostUsd] = useState(0);
  const [anchorAt, setAnchorAt] = useState('');
  const [backfilling, setBackfilling] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  // The three scalars rather than the record they arrive in: `query` is built
  // fresh by the caller on every render, so a dependency on the object identity
  // re-runs the effect below on every render — which is a fetch loop that clears
  // the rows it just set, and looks exactly like a list that never loads.
  const { watch, state, order } = query;

  // The read that both the first page and every later one go through. `cursor` is
  // passed rather than read from state so the observer below cannot fire twice on
  // one cursor and append a page to itself.
  const read = useCallback(
    async (from: string | null) => {
      setLoading(true);
      const page = await api.getTickets({ watch, state, order, cursor: from });
      setRows((prev) => (from === null ? page.rows : [...prev, ...page.rows]));
      setRefUrls((prev) => (from === null ? page.refUrls : { ...prev, ...page.refUrls }));
      setTotal(page.total);
      setKept(page.kept);
      setTotalCostUsd(page.totalCostUsd);
      setAnchorAt(page.anchorAt);
      setBackfilling(page.backfilling);
      setCursor(page.nextCursor);
      setDone(page.nextCursor === null);
      setLoading(false);
    },
    [watch, state, order],
  );

  useEffect(() => {
    // Cleared first, so a filter change never shows the previous list while its own
    // first page is in flight — the rows would read as matching a filter they do not.
    setRows([]);
    setCursor(null);
    setDone(false);
    void read(null);
  }, [read]);

  const foot = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = foot.current;
    if (sentinel === null || done || loading) return;
    // Observed inside the situation area, which is the element that actually
    // scrolls — against the viewport it would never intersect, and the list would
    // simply stop at forty rows with no way to say why.
    const root = sentinel.closest('.cn-sit');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void read(cursor);
      },
      // A page ahead of the foot, so the next one is usually there by the time a
      // reader reaches it.
      { root, rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, done, loading, read]);

  return (
    <div className="tickets">
      <div className="tickets-head">
        <h1>Tickets</h1>
        <i className="tickets-n">{kept.toLocaleString()} kept</i>
        <span className="tickets-hint">
          {anchorAt === '' ? 'no history has been read yet' : `history from ${absDate(anchorAt)}`} · everything seen
          since is kept
        </span>
      </div>

      <div className="tickets-filters">
        <Segment
          label="Watch"
          options={WATCH_OPTIONS}
          value={query.watch}
          onPick={(watch) => onQuery({ watch })}
          hint="What the harness has been told about it"
        />
        <i className="tickets-fdiv" />
        <Segment
          label="State"
          options={STATE_OPTIONS}
          value={query.state}
          onPick={(state) => onQuery({ state })}
          hint="What the tracker says about it"
        />
        <span className="tickets-sum">
          {/* Loaded of total, because an infinite list with no total says nothing
              about whether you are near the end. */}
          <b>{rows.length}</b> of <b>{total.toLocaleString()}</b> loaded
          {totalCostUsd > 0 && (
            <>
              {' · '}
              <b>{fmtUsd(totalCostUsd)}</b> spent
            </>
          )}
        </span>
      </div>

      {/* The route's URLs merged over the shell's, so a `<Ref>` to a ticket that
          left the world months ago still resolves to a link. Without this the rows
          would render correct-looking references that go nowhere. */}
      <RefLinksExtended refUrls={refUrls}>
        <section className="tickets-card">
          <div className={`tickets-rows by-${query.order}`}>
            <div className="tickets-thead">
              <span>#</span>
              <span>Ticket</span>
              <span>Watch</span>
              <span>State</span>
              <SortHead label="Cost" order="cost" active={query.order} onPick={onQuery} />
              <SortHead label="Added" order="added" active={query.order} onPick={onQuery} />
              <span />
            </div>

            {rows.map((row) => (
              <TicketRowView key={row.number} row={row} now={now} />
            ))}

            <div className="tickets-foot" ref={foot}>
              {loading && <span className="tickets-spin" aria-hidden="true" />}
              {footWords({ loading, backfilling, done, empty: rows.length === 0, anchorAt })}
            </div>
          </div>
        </section>
      </RefLinksExtended>
    </div>
  );
}

/**
 * What the foot of the list says, in each of the four states it has.
 *
 * The foot is a real state rather than an absence: a list that simply stops reads
 * as one that failed to load. Reaching the end names the floor, because the floor
 * is a cap and a silent cap is the thing this codebase refuses.
 */
function footWords(state: {
  loading: boolean;
  backfilling: boolean;
  done: boolean;
  empty: boolean;
  anchorAt: string;
}): string {
  if (state.backfilling) return 'Reading the last month from the tracker — this happens once.';
  if (state.loading) return 'Reading the next page…';
  if (state.empty) return 'Nothing here — no item matches these two filters.';
  if (!state.done) return '';
  return state.anchorAt === ''
    ? 'That is all of them.'
    : `Start of history — ${absDate(state.anchorAt)}, a month before the first scan. Nothing older was ever fetched, and nothing seen since has been dropped.`;
}

/** One row. Nothing in it is a control: a completed ticket has no page to open. */
function TicketRowView({ row, now }: { row: TicketRow; now: number }): JSX.Element {
  return (
    <div className={`tickets-row${row.state === 'closed' ? ' closed' : ''}`}>
      <span className="tickets-id">#{row.number}</span>
      <span className="tickets-what">
        <b className="tickets-name">{row.title}</b>
        {row.outcome !== null && (
          <span className="tickets-sub">
            <i className="chip small tickets-verdict">{row.outcome}</i>
          </span>
        )}
      </span>
      <span>
        <i className={`chip small tickets-watch ${row.watch}`}>{row.watch}</i>
      </span>
      <span>
        <i className={`chip small tickets-state ${row.state}`}>{row.state}</i>
      </span>
      {/* An em dash, not `$0.00`: never worked and worked for free are different
          facts, and a zero would state the wrong one. */}
      <span className={`tickets-cost${row.costUsd === null ? ' none' : ''}`}>
        {row.costUsd === null ? '—' : fmtUsd(row.costUsd)}
      </span>
      <span className="tickets-added" title={row.addedAt}>
        {relAge(row.addedAt, now)}
      </span>
      {/* The row names the ticket and this is the way to it — a reference is drawn
          with `<Ref>`, never as text, and never inside a button. */}
      <span className="cn-refs">
        <Ref to={`issue:${row.number}`} />
      </span>
    </div>
  );
}

/** One filter axis. */
function Segment<T extends string>({
  label,
  options,
  value,
  onPick,
  hint,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; title: string }>;
  value: T;
  onPick: (next: T) => void;
  hint: string;
}): JSX.Element {
  return (
    <div className="tickets-fgroup">
      <span className="tickets-flabel" title={hint}>
        {label}
      </span>
      <div className="tickets-seg">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? 'on' : ''}
            title={option.title}
            aria-pressed={option.value === value}
            onClick={() => onPick(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A sortable column header — the one place the list is ordered from.
 *
 * Not a third segmented control beside the filters: two controls for one job is
 * two places to leave disagreeing, and a header is where a reader of a table looks
 * for the sort anyway.
 */
function SortHead({
  label,
  order,
  active,
  onPick,
}: {
  label: string;
  order: TicketOrder;
  active: TicketOrder;
  onPick: (next: { order: TicketOrder }) => void;
}): JSX.Element {
  return (
    <span className="tickets-num">
      <button
        type="button"
        className={order === active ? 'on' : ''}
        title={
          order === 'cost'
            ? 'Order by what the fleet has spent under each ticket'
            : 'Order by tracker id — newest added first'
        }
        aria-pressed={order === active}
        onClick={() => onPick({ order })}
      >
        {label}
        {order === active && <i className="tickets-arrow">▼</i>}
      </button>
    </span>
  );
}

/** The floor's date, as someone would say it. */
function absDate(iso: string): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return iso;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
