import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { cascadeNote, featureBlocks, issueTypeTone, watchReading, type TicketFeatureBlock } from '../issueGroups.js';
import type {
  Issue,
  TicketFeatureFacet,
  TicketOrder,
  TicketRow,
  TicketStateFacet,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../types.js';
import { LIVE_WORK, statePick, widenedFor } from '../cockpit/place.js';
import { watchBucket } from '../worldBuckets.js';
import type { CockpitView } from '../view/viewModel.js';
import { stateColour } from '../stateColour.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref, RefLinksExtended } from './refs.js';
import { TicketsBoard } from './TicketsBoard.js';
import { absDate, fmtUsd, relAge } from './util.js';

/** What the tab is narrowed to, grouped and ordered by — every field of it a `Place` field. */
interface TicketQueryPlace {
  watch: TicketWatchFilter;
  tracking: TicketTrackingFilter;
  /** The tracker's own word, or `any`. Free-form: it is the tracker's vocabulary, not ours. */
  state: string;
  /** A feature number, `none` for the orphans, or null for every feature. */
  feature: number | 'none' | null;
  /** Features as headings, or one flat list with a feature column. */
  group: 'feature' | 'flat';
  order: TicketOrder;
  /** The table, or the board of state columns. */
  view: 'table' | 'card';
  /** The board columns the operator has hidden. */
  columns: string[];
}

interface TicketsPanelProps {
  query: TicketQueryPlace;
  onQuery: (next: Partial<TicketQueryPlace>) => void;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}

const WATCH_OPTIONS: ReadonlyArray<{ value: TicketWatchFilter; label: string; title: string }> = [
  { value: 'any', label: 'Any', title: 'Every item, however it is tagged' },
  { value: 'watched', label: 'Watched', title: 'Tagged work-this — the harness will pick these up' },
  {
    value: 'unwatched',
    label: 'Unwatched',
    title: 'Untagged — nobody has opted these in, so the harness leaves them alone',
  },
];

const TRACKING_OPTIONS: ReadonlyArray<{ value: TicketTrackingFilter; label: string; title: string }> = [
  { value: 'any', label: 'Any', title: 'The whole history, live and frozen' },
  { value: 'live', label: 'Live', title: 'Still in the tracker’s open set — this is the work' },
  { value: 'frozen', label: 'Frozen', title: 'Left the open set; kept exactly as it was last seen' },
];

const GROUP_OPTIONS: ReadonlyArray<{ value: 'feature' | 'flat'; label: string; title: string }> = [
  { value: 'feature', label: 'By feature', title: 'Features as headings, with their work indented under them' },
  { value: 'flat', label: 'Flat', title: 'One list, with the feature as a column' },
];

const VIEW_OPTIONS: ReadonlyArray<{ value: 'table' | 'card'; label: string; title: string }> = [
  { value: 'table', label: 'Table', title: 'One list, sortable, with a row per item' },
  { value: 'card', label: 'Cards', title: 'A column per tracker state, with the work as cards' },
];

/**
 * The ordering, as a control rather than a column header.
 *
 * Drawn in card view only: the table sorts from its own headers, which is where a
 * reader of a table looks, and a board has none.
 */
const ORDER_OPTIONS: ReadonlyArray<{ value: TicketOrder; label: string; title: string }> = [
  { value: 'added', label: 'Added', title: 'Newest tracker id first' },
  { value: 'changed', label: 'Changed', title: 'Order by when the tracker last saw it change' },
  { value: 'cost', label: 'Cost', title: 'Order by what the fleet has spent under each ticket' },
];

/**
 * Every ticket the assignment filter has returned since the harness first swept —
 * and, since the backlog was folded into it, the one surface triage happens on
 * (issues #329, #351).
 *
 * **Three axes, because they are three different questions.** `watch` is a label an
 * operator sets and the dispatcher's gate reads; `tracking` is what the *harness* is
 * doing about the item; `state` is the tracker's own word. Watch is three-valued and
 * not two — an item nobody has opted in is *unwatched*, one tagged leave-alone is
 * *ignored*, and folding them would report a triage nobody made.
 *
 * **The mirror is the list; the world is the overlay.** Rows come from the route,
 * which reads the local mirror and is fetched on open and per page rather than
 * polled. Everything that is a *live reading* — the pickup reasons, the assay, the
 * current labels — is read off the state snapshot the cockpit already has, for the
 * one reason that matters: those are the server's own sentences, and a second
 * derivation of them here would be a second opinion about a decision made
 * elsewhere.
 *
 * **Two controls, and no more.** The watch switch and the intake override, both
 * writing through the actions the backlog already used. A row is otherwise a
 * reading.
 */
export function TicketsPanel({ query, onQuery, view, actions, now }: TicketsPanelProps): JSX.Element {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [kept, setKept] = useState(0);
  const [live, setLive] = useState(0);
  const [states, setStates] = useState<TicketStateFacet[]>([]);
  const [features, setFeatures] = useState<TicketFeatureFacet[]>([]);
  const [orphanCount, setOrphanCount] = useState(0);
  const [totalCostUsd, setTotalCostUsd] = useState(0);
  const [anchorAt, setAnchorAt] = useState('');
  const [backfilling, setBackfilling] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  // What the State narrowing was when the board took over, so the notice can name it
  // and the way back can restore it. Not a `Place` field: it is a fact about one
  // switch that just happened, not somewhere the operator can be — and a URL
  // carrying it would re-announce the clearing on every reload of a shared link.
  const [clearedState, setClearedState] = useState('');

  // The scalars rather than the record they arrive in: `query` is built fresh by the
  // caller on every render, so a dependency on the object identity re-runs the
  // effect on every render — a fetch loop that clears the rows it just set, and
  // looks exactly like a list that never loads.
  const { watch, tracking, state, feature, order } = query;

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
      setKept(page.kept);
      setLive(page.live);
      setStates(page.states);
      setFeatures(page.features);
      setOrphanCount(page.orphanCount);
      setTotalCostUsd(page.totalCostUsd);
      setAnchorAt(page.anchorAt);
      setBackfilling(page.backfilling);
      setCursor(page.nextCursor);
      setDone(page.nextCursor === null);
      setLoading(false);
    },
    [watch, tracking, state, feature, order],
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

  // The world, by number — the overlay every live reading comes from.
  const worldIssues = view.state.world.issues;
  const live_ = useMemo(() => new Map(worldIssues.map((issue) => [issue.number, issue])), [worldIssues]);
  const held = useMemo(() => intakeHeld(worldIssues, view.state.config), [worldIssues, view.state.config]);

  // Which state the tracking axis is standing widened for, if any — read back off
  // the facets this page already carries rather than remembered, because a
  // remembered widening is a second copy of the two `Place` fields that state it.
  const widened = widenedFor(query.state, query.tracking, states);

  return (
    <div className="tickets">
      <div className="tickets-head">
        <h1>Tickets</h1>
        <i className="tickets-live">{live.toLocaleString()} live</i>
        <i className="tickets-n">{kept.toLocaleString()} kept</i>
        <span className="tickets-hint">
          {anchorAt === '' ? 'no history has been read yet' : `history from ${absDate(anchorAt)}`} · everything seen
          since is kept
        </span>
      </div>

      {/* Intake is drawn *above* the list rather than as a filter on it: an unclear
          assay is the one intake reading that stops dispatch, and among a page of
          rows it reads as a detail rather than as the thing holding all the work. */}
      {held.length > 0 && <IntakeCallout held={held} actions={actions} />}

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
          label="Tracking"
          options={TRACKING_OPTIONS}
          value={query.tracking}
          onPick={(tracking) => onQuery({ tracking })}
          hint="What the harness is doing about it"
        />
        <i className="tickets-fdiv" />
        {/* A flat board has no headings to indent under, so the arrangement control
            is the table's alone; the ordering takes its place, because the table
            sorts from its column headers and the board has none. */}
        {query.view === 'table' ? (
          <Segment
            label="Group"
            options={GROUP_OPTIONS}
            value={query.group}
            onPick={(group) => onQuery({ group })}
            hint="How the list is arranged"
          />
        ) : (
          <Segment
            label="Order"
            options={ORDER_OPTIONS}
            value={query.order}
            onPick={(order) => onQuery({ order })}
            hint="How each column is ordered"
          />
        )}
        <i className="tickets-fdiv" />
        <div className="tickets-fgroup">
          <span className="tickets-flabel" title="How the work is laid out">
            View
          </span>
          <div className="tickets-seg">
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === query.view ? 'on' : ''}
                // Disabled rather than hidden where the tracker has no native states:
                // there are no columns to draw, and a control that vanishes on some
                // deployments is one nobody can ask a question about.
                disabled={states.length === 0 && option.value === 'card'}
                aria-pressed={option.value === query.view}
                title={
                  states.length === 0 && option.value === 'card'
                    ? 'This tracker reports no native states, so there are no columns to draw'
                    : option.title
                }
                onClick={() => {
                  if (option.value === query.view) return;
                  if (option.value === 'card') {
                    // `state` stops meaning anything once every state is a column, so
                    // it is cleared — and said, below. A control silently ignored is
                    // worse than one that moved and told you.
                    setClearedState(query.state === 'any' ? '' : query.state);
                    onQuery({ view: 'card', state: 'any' });
                  } else {
                    setClearedState('');
                    onQuery({ view: 'table' });
                  }
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
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

      {/* Said where the axis actually moved, and offered back as the pair rather
          than the axis — `widenedFor` owns both halves of why (issue #418). */}
      {widened !== null && (
        <div className="tickets-widened">
          <span>
            Showing the whole history, live and frozen: nothing under <b>{widened.state}</b> is still in the tracker’s
            open set, so picking it widened <b>Tracking</b> to <b>Any</b>.
          </span>
          <button
            type="button"
            onClick={() => onQuery(LIVE_WORK)}
            title="Back to what the tab opens on: every state, and only the items still in the tracker’s open set"
          >
            Back to live work
          </button>
        </div>
      )}

      {/* The `tickets-widened` idiom pointed the other way: the axis did not widen,
          it stopped applying — and either way a control that moved has to say so. */}
      {query.view === 'card' && clearedState !== '' && (
        <div className="tickets-widened">
          <span>
            Cards draw every state as a column, so the <b>State</b> narrowing to <b>{clearedState}</b> was cleared.
          </span>
          <button
            type="button"
            onClick={() => {
              onQuery({ view: 'table', state: clearedState });
              setClearedState('');
            }}
            title="Back to the table, narrowed to that state again"
          >
            Back to the table
          </button>
        </div>
      )}

      {/* Drawn only where the provider has native states. A filter offering states
          the tracker cannot produce is a control that always returns nothing. */}
      {states.length > 0 &&
        (query.view === 'card' ? (
          <StateTier
            states={states}
            hidden={query.columns}
            onToggle={(state) =>
              onQuery({
                columns: query.columns.includes(state)
                  ? query.columns.filter((s) => s !== state)
                  : [...query.columns, state],
              })
            }
          />
        ) : (
          <StateTier
            states={states}
            value={query.state}
            onPick={(facet) => onQuery(statePick(facet, query.tracking))}
          />
        ))}

      {(features.length > 0 || orphanCount > 0) && (
        <FeatureLegend
          features={features}
          orphanCount={orphanCount}
          value={query.feature}
          onPick={(feature) => onQuery({ feature })}
        />
      )}

      {/* The route's URLs merged over the shell's, so a `<Ref>` to a ticket that
          left the world months ago still resolves to a link. Without this the rows
          would render correct-looking references that go nowhere. */}
      {query.view === 'card' ? (
        <TicketsBoard
          query={{ watch: query.watch, tracking: query.tracking, feature: query.feature, order: query.order }}
          facets={states}
          hidden={query.columns}
          view={view}
          actions={actions}
          now={now}
        />
      ) : (
        <RefLinksExtended refUrls={refUrls}>
          <section className="tickets-card">
            <div className={`tickets-rows by-${query.order} ${query.group === 'feature' ? 'grouped' : ''}`}>
              <div className="tickets-thead">
                <span>#</span>
                <span>Ticket</span>
                {query.group === 'flat' && <span>Feature</span>}
                <span>Watch</span>
                <span>State</span>
                <SortHead label="Cost" order="cost" active={query.order} onPick={onQuery} />
                <SortHead label="Changed" order="changed" active={query.order} onPick={onQuery} />
                <span />
              </div>

              {query.group === 'flat'
                ? rows.map((row) => (
                    <TicketRowView
                      key={row.number}
                      row={row}
                      issue={live_.get(row.number) ?? null}
                      view={view}
                      actions={actions}
                      now={now}
                      showFeature
                    />
                  ))
                : featureBlocks(rows).map((block) => (
                    <FeatureBlockView
                      key={block.key}
                      block={block}
                      live={live_}
                      view={view}
                      actions={actions}
                      now={now}
                    />
                  ))}

              <div className="tickets-foot" ref={foot}>
                {loading && <span className="tickets-spin" aria-hidden="true" />}
                {footWords({ loading, backfilling, done, empty: rows.length === 0, anchorAt })}
              </div>
            </div>
          </section>
        </RefLinksExtended>
      )}
    </div>
  );
}

/**
 * The goals an `unclear` assay is holding, in the harness's own words.
 *
 * Read off the world rather than the mirror because it is a live reading: the
 * assay moves, and a copy of it in a record would be a verdict that outlived its
 * own evidence. An **unwatched** item is never intake, whatever a stale verdict
 * says — nothing assays a goal nobody opted in, so a verdict on one is left over
 * from before it was dropped, and the drop outranks it.
 */
function intakeHeld(issues: readonly Issue[], config: { watchLabel: string }): Issue[] {
  return issues.filter(
    (issue) =>
      issue.state === 'open' &&
      issue.assay?.verdict === 'unclear' &&
      watchBucket(issue.labels, config.watchLabel) === 'watched',
  );
}

/** The intake call-out: what is held, why, and the one button that unblocks it. */
function IntakeCallout({ held, actions }: { held: Issue[]; actions: CockpitActions }): JSX.Element {
  return (
    <section className="tickets-intake">
      <div className="tickets-intake-head">
        <i className="tickets-lamp" />
        <b>
          {held.length} goal{held.length === 1 ? ' is' : 's are'} held at intake
        </b>
        <span>— an unclear assay stops pickup, so nothing under them moves until you say otherwise</span>
      </div>
      {held.map((issue) => (
        <div className="tickets-intake-row" key={issue.id}>
          <button
            type="button"
            className="tickets-intake-name"
            onClick={() => actions.selectGoal(`issue:${issue.number}`)}
            title="Open this goal — its plan, its ticket and anything it is asking you"
          >
            <b>
              #{issue.number} {issue.title}
            </b>
            {/* The assayer's own sentence, quoted whole: it is the only account of
                why this goal is held, so a paraphrase would be the only account
                there is, and wrong. */}
            <span className="tickets-quote">Assay: unclear — “{issue.assay?.summary}”</span>
          </button>
          <AsyncButton
            className="ghost"
            onClick={() => actions.setIssueAssay(issue.number, 'workable')}
            title="Work it anyway — the harness stops holding pickup and runs a cycle now"
          >
            Override → workable
          </AsyncButton>
        </div>
      ))}
    </section>
  );
}

/**
 * The tracker's own states, with counts, and a mark on the ones the harness picks up
 * from — as a filter over the table, and as column visibility over the board.
 *
 * One control with two jobs rather than two controls, because it is the same question
 * asked of the same list: *which of the tracker's states am I looking at*. On a board
 * the answer is which columns are drawn, so `aria-pressed` means "drawn" and the
 * chips carry no `Any`, there being nothing to widen back to.
 */
function StateTier(
  props:
    | { states: readonly TicketStateFacet[]; value: string; onPick: (next: TicketStateFacet | null) => void }
    | { states: readonly TicketStateFacet[]; hidden: readonly string[]; onToggle: (state: string) => void },
): JSX.Element {
  const columns = 'onToggle' in props;
  return (
    <div className="tickets-states">
      <span
        className="tickets-flabel"
        title={columns ? 'Which columns the board draws' : 'What the tracker itself calls it'}
      >
        {columns ? 'Columns' : 'State'}
      </span>
      {!columns && (
        <button
          type="button"
          className={props.value === 'any' ? 'on' : ''}
          onClick={() => props.onPick(null)}
          aria-pressed={props.value === 'any'}
        >
          Any
        </button>
      )}
      {props.states.map((facet) => {
        const on = columns ? !props.hidden.includes(facet.state) : props.value === facet.state;
        return (
          <button
            key={facet.state}
            type="button"
            className={`${on ? 'on' : ''} ${facet.pickup ? 'gate' : ''}`}
            aria-pressed={on}
            onClick={() => (columns ? props.onToggle(facet.state) : props.onPick(facet))}
            title={
              columns
                ? `${on ? 'Hide' : 'Show'} the ${facet.state} column${facet.pickup ? ' — a state the harness picks up from' : ''}`
                : stateWhy(facet)
            }
          >
            {facet.state}
            {facet.pickup && <i className="tickets-gate">▲</i>}
            <i className="tickets-k">{facet.count.toLocaleString()}</i>
          </button>
        );
      })}
      <span className="tickets-why">
        <i className="tickets-gate">▲</i> a state <code>pickupStates</code> lets through
      </span>
    </div>
  );
}

/** Why a state chip is what it is: the pickup gate, and whether anything under it is still live. */
function stateWhy(facet: TicketStateFacet): string {
  const gate = facet.pickup
    ? `"${facet.state}" is one of the states pickupStates lets the harness work`
    : `"${facet.state}" is not a state the harness picks up from`;
  // Said before the click rather than discovered after it: the tracking row above
  // is about to change, and a filter that moves a control the reader did not touch
  // has to say so.
  return facet.live === 0
    ? `${gate}. Nothing under it is still in the tracker's open set, so picking it shows the whole history`
    : gate;
}

/**
 * The legend, which is also the filter.
 *
 * `slot` is an index into the stylesheet's hue ladder rather than a colour: the
 * palette belongs to the theme, and a colour on the wire would be one no theme
 * could reach. The number and the name ride on every chip too, so the column works
 * for a colour-blind reader and in a screenshot.
 */
function FeatureLegend({
  features,
  orphanCount,
  value,
  onPick,
}: {
  features: readonly TicketFeatureFacet[];
  orphanCount: number;
  value: number | 'none' | null;
  onPick: (next: number | 'none' | null) => void;
}): JSX.Element {
  return (
    <div className="tickets-legend">
      <span className="tickets-flabel">Feature</span>
      {features.map((f) => (
        <button
          key={f.number}
          type="button"
          className={`tickets-fchip ${value === f.number ? 'on' : ''}`}
          aria-pressed={value === f.number}
          onClick={() => onPick(value === f.number ? null : f.number)}
          title={`#${f.number} · ${f.count} item${f.count === 1 ? '' : 's'}`}
        >
          <i className={`tickets-sw f${f.slot}`} />
          {f.title}
          <i className="tickets-k">{f.count.toLocaleString()}</i>
        </button>
      ))}
      {orphanCount > 0 && (
        <button
          type="button"
          className={`tickets-fchip orphan ${value === 'none' ? 'on' : ''}`}
          aria-pressed={value === 'none'}
          onClick={() => onPick(value === 'none' ? null : 'none')}
          title="The tracker says these hang off no feature — not the same as a parent we could not read"
        >
          <i className="tickets-sw" />
          No feature
          <i className="tickets-k">{orphanCount.toLocaleString()}</i>
        </button>
      )}
    </div>
  );
}

/**
 * One feature and the work under it, or one headless run of rows.
 *
 * **A feature is a heading, never a row.** Nothing is ever dispatched at a
 * container, so listing one among the items being triaged asks an operator to
 * remember which is which on every read.
 *
 * **Open by default.** The tab's job is to show what is waiting, and a surface that
 * hides it behind a click reports an empty board. A fold is `Place.collapsed`, so
 * stepping back into the tab restores the same folded features and a shared link
 * shows what the sender was looking at.
 */
function FeatureBlockView({
  block,
  live,
  view,
  actions,
  now,
}: {
  block: TicketFeatureBlock;
  live: ReadonlyMap<number, Issue>;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  const feature = block.feature;
  const collapsed = feature !== null && view.collapsedFeatures.has(feature.number);
  const rows = block.rows.map((row) => (
    <TicketRowView
      key={row.number}
      row={row}
      issue={live.get(row.number) ?? null}
      view={view}
      actions={actions}
      now={now}
      nested={feature !== null}
    />
  ));

  if (feature === null && !block.orphans) return <>{rows}</>;
  if (feature === null) {
    return (
      <>
        <div className="tickets-fhead plain">
          <span />
          <span className="tickets-fname">
            <b>No feature</b>
            <i className="tickets-fcount">
              · {block.rows.length} item{block.rows.length === 1 ? '' : 's'} the tracker says hang off nothing
            </i>
          </span>
        </div>
        {rows}
      </>
    );
  }

  // The feature's own row, when the mirror holds it. Non-null means the heading can
  // carry the container's controls exactly as a row would; null means it is a label
  // reconstructed from a child's parent, and there is nothing here to tag.
  const featureIssue = live.get(feature.number) ?? null;
  return (
    <>
      <div className="tickets-fhead">
        <button
          type="button"
          className="tickets-fold"
          aria-expanded={!collapsed}
          onClick={() => actions.collapseFeature(feature.number, !collapsed)}
          title={collapsed ? 'Show the work under this feature' : 'Fold this feature away'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <i className={`tickets-stripe f${feature.slot ?? 0}`} />
        <span className="tickets-fname">
          {featureIssue === null ? (
            <b>{feature.title}</b>
          ) : (
            <button
              type="button"
              className="tickets-fopen"
              onClick={() => actions.selectGoal(`issue:${feature.number}`)}
              title="Open this feature's page — its children, its plan and anything it is asking you"
            >
              <b>{feature.title}</b>
            </button>
          )}
          <i className="tickets-fnum">#{feature.number}</i>
          <i className="tickets-fcount">
            · {block.rows.length} shown
            {featureIssue === null ? ' · not in the filtered item list' : ''}
          </i>
        </span>
        {featureIssue !== null && <WatchSwitch issue={featureIssue} row={null} view={view} actions={actions} />}
        <span className="cn-refs">
          <Ref to={`issue:${feature.number}`} />
        </span>
      </div>
      {!collapsed && rows}
    </>
  );
}

/**
 * One row: what it is, what the harness is doing about it in the harness's own
 * words, and the one control that changes that.
 *
 * **The name opens the goal's page**, through the same `selectGoal` a queue row and
 * an overview row call — one way into a goal, from everywhere that lists one. It is
 * the name rather than the whole row, because the row carries controls of its own
 * and a button cannot hold them; the reference sits beside it in a `cn-refs` group,
 * since a link inside a button is a second destination for one click.
 */
function TicketRowView({
  row,
  issue,
  view,
  actions,
  now,
  nested = false,
  showFeature = false,
}: {
  row: TicketRow;
  /** The live world's own row, when it still holds one — the source of every live reading. */
  issue: Issue | null;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
  nested?: boolean;
  showFeature?: boolean;
}): JSX.Element {
  const [why, setWhy] = useState(false);
  // Quoted, never re-derived: `pickup.reasons` is the dispatcher's own account of
  // what it would do next cycle, and a second reading of the gates here would be a
  // second opinion about a decision made elsewhere.
  const reasons = issue?.pickup.reasons ?? [];
  const intake = issue?.assay?.verdict === 'unclear';
  const frozen = row.tracking === 'frozen';

  return (
    <>
      <div className={`tickets-row ${frozen ? 'frozen' : ''} ${nested ? 'nested' : ''} ${intake ? 'held' : ''}`}>
        <span className="tickets-id">#{row.number}</span>
        <span className="tickets-what">
          {intake && <i className="tickets-lamp" />}
          <button
            type="button"
            className="tickets-name-btn"
            onClick={() => actions.selectGoal(`issue:${row.number}`)}
            title="Open this goal — its plan, its ticket, its pull requests and anything it is asking you"
          >
            <b className="tickets-name">{row.title}</b>
            <span className="tickets-sub">
              {row.outcome !== null && <i className="chip small tickets-verdict">{row.outcome}</i>}
              {row.issueType !== null && (
                <i className={`tickets-type ${issueTypeTone(row.issueType)}`}>{row.issueType}</i>
              )}
              {frozen && <span>frozen{row.changedAt ? ` · last change ${relAge(row.changedAt, now)}` : ''}</span>}
              {reasons[0] !== undefined && <span className="tickets-reason">{reasons[0]}</span>}
            </span>
          </button>
          {reasons.length > 0 && (
            <button
              type="button"
              className={`tickets-why-b ${issue?.pickup.eligible === false && !intake ? '' : 'quiet'}`}
              aria-expanded={why}
              onClick={() => setWhy(!why)}
              title="Why is nothing on this?"
            >
              ?
            </button>
          )}
        </span>
        {showFeature && (
          <span>
            <FeatureCell row={row} />
          </span>
        )}
        <span>
          <WatchSwitch issue={issue} row={row} view={view} actions={actions} />
        </span>
        <span>
          <StateChip row={row} colours={view.state.config.stateColours} />
        </span>
        {/* An em dash, not `$0.00`: never worked and worked for free are different
            facts, and a zero would state the wrong one. */}
        <span className={`tickets-cost${row.costUsd === null ? ' none' : ''}`}>
          {row.costUsd === null ? '—' : fmtUsd(row.costUsd)}
        </span>
        <span className="tickets-added" title={`added ${row.addedAt}`}>
          {relAge(row.changedAt, now)}
        </span>
        {/* The row names the ticket and this is the way to it — a reference is drawn
            with `<Ref>`, never as text, and never inside a button. */}
        <span className="cn-refs">
          <Ref to={`issue:${row.number}`} />
        </span>
      </div>
      {/* Expanded rather than hover-only: a tooltip nobody can select text out of is
          where a stack trace goes to die. */}
      {why && (
        <div className="tickets-why">
          <h4>Why nothing is on this</h4>
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p>The dispatcher’s own words, as of the last pulse — this list re-derives nothing.</p>
        </div>
      )}
    </>
  );
}

/** The feature a row hangs off, in the flat arrangement where there is no heading to say it. */
function FeatureCell({ row }: { row: TicketRow }): JSX.Element {
  if (row.parent) {
    return (
      <span className="tickets-feat" title={`Feature #${row.parent.number}`}>
        <i className={`tickets-sw f${row.featureSlot ?? 0}`} />
        <i className="tickets-fnum">{row.parent.number}</i>
        <i className="tickets-ft">{row.parent.title}</i>
      </span>
    );
  }
  // The two absences, kept apart: the tracker saying there is no parent, and the
  // link never having been resolved. Drawing them the same would tell a reader an
  // item belongs to no feature when the truth is that we could not tell.
  return row.parent === null ? (
    <span className="tickets-feat orphan" title="The tracker says this hangs off no feature">
      <i className="tickets-sw" />
      <i className="tickets-ft">no feature</i>
    </span>
  ) : (
    <span className="tickets-feat unknown" title="This tracker reports no hierarchy, or the link could not be read">
      <i className="tickets-ft">—</i>
    </span>
  );
}

/**
 * The tracker's own word where there is one, and the coarse reading where there is not.
 *
 * The operator's colour wins over the built-in tone, and over nothing at all —
 * which is the point of the setting: a tracker with a dozen state words draws
 * eleven of them the same grey, and this is the one place the difference is meant
 * to be readable at a glance. Frozen keeps its dashed border either way: closed is
 * a fact about the item, not a shade of its last state.
 */
function StateChip({ row, colours }: { row: TicketRow; colours: Readonly<Record<string, string>> }): JSX.Element {
  const label = row.workItemState ?? row.state;
  const tone =
    row.tracking === 'frozen' ? 'frozen' : (row.workItemState ?? row.state).toLowerCase().replace(/\s+/g, '');
  const colour = stateColour(colours, label);
  return (
    <i
      className={`tickets-state ${tone}`}
      style={colour === null ? undefined : { color: colour, borderColor: colour }}
      title={`${label} · ${row.tracking} in the harness's reading`}
    >
      {label}
    </i>
  );
}

/**
 * The one control on a row or a feature heading, and what it costs.
 *
 * `setIssueWatched` writes the one tag, on or off — there is no second tag and no
 * third state (`src/watchLabels.ts`), so an untagged item is *unwatched* rather
 * than untriaged, and the titles say what the click does rather than what the
 * label reads.
 *
 * **Which of the two readings of that tag it draws is load-bearing**, and that
 * choice is `watchReading`'s — the world where the world holds the item, and the
 * mirror only for the rows it no longer does. Reading them the other way round is
 * a toggle that never visibly moves.
 *
 * **On a container it cascades**, and the title says so with the number it will
 * reach. A container is still never dispatched at, but watching one is not an empty
 * click: the tags go on every descendant, which is what "work this feature" has
 * always meant.
 *
 * Refused in three cases, each with a title that says which: a deployment with the
 * gate off (`labelPrefix: ''`) has no tag to write in either direction; a **frozen**
 * row has nothing in the tracker left to tag; and a row the world no longer holds
 * cannot have its cascade counted.
 */
function WatchSwitch({
  issue,
  row,
  view,
  actions,
}: {
  issue: Issue | null;
  /** The mirror's row, for the frozen reading and the bucket. Null on a feature heading. */
  row: TicketRow | null;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { watchLabel, containerTypes } = view.state.config;
  const frozen = row?.tracking === 'frozen';
  const off =
    watchLabel === ''
      ? 'No watch label configured — the watch gate is off'
      : frozen
        ? 'Closed in the tracker — there is nothing here to tag'
        : issue === null
          ? 'The world no longer holds this item, so there is nothing to tag'
          : null;

  // What the click will also reach — the words are a pure function, so the
  // invariant that a click writing eight tags says eight is tested without a render.
  const also = issue === null ? '' : cascadeNote(issue, containerTypes);
  const bucket = watchReading(issue, row, watchLabel);

  return (
    <span className={`tickets-switch ${off !== null ? 'off' : ''}`}>
      <AsyncButton
        className={bucket === 'watched' ? 'on w' : ''}
        disabled={off !== null || bucket === 'watched'}
        onClick={() => actions.setIssueWatched(issue?.number ?? row?.number ?? 0, true)}
        title={off ?? `Tag #${issue?.number ?? row?.number}${also} "${watchLabel}" so the harness picks it up`}
      >
        Watch
      </AsyncButton>
      <AsyncButton
        className={bucket === 'unwatched' ? 'on u' : ''}
        disabled={off !== null || bucket === 'unwatched'}
        onClick={() => actions.setIssueWatched(issue?.number ?? row?.number ?? 0, false)}
        title={
          off ?? `Take "${watchLabel}" off #${issue?.number ?? row?.number}${also}, so the harness leaves it alone`
        }
      >
        Unwatch
      </AsyncButton>
    </span>
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
  if (state.empty) return 'Nothing here — no item matches these filters.';
  if (!state.done) return '';
  return state.anchorAt === ''
    ? 'That is all of them.'
    : `Start of history — ${absDate(state.anchorAt)}, a month before the first scan. Nothing older was ever fetched, and nothing seen since has been dropped.`;
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
 * Not a segmented control beside the filters: two controls for one job is two
 * places to leave disagreeing, and a header is where a reader of a table looks for
 * the sort anyway.
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
            : 'Order by when the tracker last saw it change'
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
