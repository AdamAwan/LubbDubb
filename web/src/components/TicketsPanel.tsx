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
import type { CockpitView } from '../view/viewModel.js';
import { stateColour } from '../stateColour.js';
import { AsyncButton } from './AsyncButton.js';
import { UnrecordedWork } from './UnrecordedWork.js';
import { Ref, RefLinksExtended } from './refs.js';
import { TicketsBoard } from './TicketsBoard.js';
import { absDate, fmtUsd, relAge } from './util.js';
import { Panel } from './panel.js';
import { Tag } from './tag.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

interface TicketQueryPlace {
  watch: TicketWatchFilter;
  tracking: TicketTrackingFilter;
  state: string;
  feature: number | 'none' | null;
  group: 'feature' | 'flat';
  order: TicketOrder;
  view: 'table' | 'card';
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

const ORDER_OPTIONS: ReadonlyArray<{ value: TicketOrder; label: string; title: string }> = [
  { value: 'added', label: 'Added', title: 'Newest tracker id first' },
  { value: 'changed', label: 'Changed', title: 'Order by when the tracker last saw it change' },
  { value: 'cost', label: 'Cost', title: 'Order by what the fleet has spent under each ticket' },
];

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
  const [clearedState, setClearedState] = useState('');

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
    setRows([]);
    setCursor(null);
    setDone(false);
    void read(null);
  }, [read]);

  const foot = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = foot.current;
    if (sentinel === null || done || loading) return;
    const root = sentinel.closest('.cn-sit');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void read(cursor);
      },
      { root, rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, done, loading, read]);

  const worldIssues = view.state.world.issues;
  const live_ = useMemo(() => new Map(worldIssues.map((issue) => [issue.number, issue])), [worldIssues]);

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

      {/* Work nothing in the tracker accounts for, above the list of things it
          does. It is here because `File a work item` / `Ignore` is a triage
          decision and this is the surface triage happens on. It draws its own
          fetch and nothing at all when there is nothing outstanding.
          → docs/spec/17-cockpit.md#unrecorded-work */}
      <UnrecordedWork now={now} canFileTickets={view.state.config.canFileTickets} />

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
          <Panel density="flush" className="tickets-card">
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
          </Panel>
        </RefLinksExtended>
      )}
    </div>
  );
}

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

function stateWhy(facet: TicketStateFacet): string {
  const gate = facet.pickup
    ? `"${facet.state}" is one of the states pickupStates lets the harness work`
    : `"${facet.state}" is not a state the harness picks up from`;
  return facet.live === 0
    ? `${gate}. Nothing under it is still in the tracker's open set, so picking it shows the whole history`
    : gate;
}

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

  const featureIssue = live.get(feature.number) ?? null;
  return (
    <>
      <div className="tickets-fhead">
        <button
          type="button"
          className="tickets-fold"
          aria-expanded={!collapsed}
          onClick={() => {
            if (collapsed) logUsage('feature.expand');
            actions.collapseFeature(feature.number, !collapsed);
          }}
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
  issue: Issue | null;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
  nested?: boolean;
  showFeature?: boolean;
}): JSX.Element {
  const [why, setWhy] = useState(false);
  const reasons = issue?.pickup.reasons ?? [];
  const intake = issue?.appraisal?.verdict === 'unclear';
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
              {row.outcome !== null && (
                <Tag tone="amber" fill>
                  {row.outcome}
                </Tag>
              )}
              {row.issueType !== null && <Tag tone={issueTypeTone(row.issueType)}>{row.issueType}</Tag>}
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

function StateChip({ row, colours }: { row: TicketRow; colours: Readonly<Record<string, string>> }): JSX.Element {
  const label = row.workItemState ?? row.state;
  const tone =
    row.tracking === 'frozen' ? 'frozen' : (row.workItemState ?? row.state).toLowerCase().replace(/\s+/g, '');
  const colour = stateColour(colours, label);
  return (
    <i
      className={tone === 'frozen' ? 'tag tag-dashed' : 'tag'}
      style={colour === null ? undefined : { color: colour, borderColor: colour }}
      title={`${label} · ${row.tracking} in the harness's reading`}
    >
      {label}
    </i>
  );
}

function WatchSwitch({
  issue,
  row,
  view,
  actions,
}: {
  issue: Issue | null;
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
