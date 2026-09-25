import { useState, type JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import {
  cascadeNote,
  featureBlocks,
  issueTypeTone,
  watchOff,
  watchReading,
  type TicketFeatureBlock,
} from '../issueGroups.js';
import type { Issue, TicketOrder, TicketRow } from '../types.js';
import type { CockpitView } from '../view/viewModel.js';
import { stateColour } from '../stateColour.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref, RefLinksExtended } from './refs.js';
import { absDate, fmtUsd, relAge } from './util.js';
import { Panel } from './panel.js';
import { Tag } from './tag.js';
import { logUsage } from '../cockpit/usage.js';
import type { TicketFeed } from './ticketsFeed.js';
import type { TicketQueryPlace } from './ticketsFilters.js';

export function TicketsTable({
  query,
  onQuery,
  feed,
  live,
  view,
  actions,
  now,
}: {
  query: TicketQueryPlace;
  onQuery: (next: Partial<TicketQueryPlace>) => void;
  feed: TicketFeed;
  live: ReadonlyMap<number, Issue>;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  const { rows, loading, backfilling, done, anchorAt } = feed;
  /* The route's URLs merged over the shell's, so a `<Ref>` to a ticket that
     left the world months ago still resolves to a link. Without this the rows
     would render correct-looking references that go nowhere. */
  return (
    <RefLinksExtended refUrls={feed.refUrls}>
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
                  issue={live.get(row.number) ?? null}
                  view={view}
                  actions={actions}
                  now={now}
                  showFeature
                />
              ))
            : featureBlocks(rows).map((block) => (
                <FeatureBlockView key={block.key} block={block} live={live} view={view} actions={actions} now={now} />
              ))}

          <div className="tickets-foot" ref={feed.foot}>
            {loading && <span className="tickets-spin" aria-hidden="true" />}
            {footWords({ loading, backfilling, done, empty: rows.length === 0, anchorAt })}
          </div>
        </div>
      </Panel>
    </RefLinksExtended>
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

  return (
    <>
      <FeatureHead
        feature={feature}
        shown={block.rows.length}
        featureIssue={live.get(feature.number) ?? null}
        collapsed={collapsed}
        view={view}
        actions={actions}
      />
      {!collapsed && rows}
    </>
  );
}

function FeatureHead({
  feature,
  shown,
  featureIssue,
  collapsed,
  view,
  actions,
}: {
  feature: NonNullable<TicketFeatureBlock['feature']>;
  shown: number;
  featureIssue: Issue | null;
  collapsed: boolean;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
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
          · {shown} shown
          {featureIssue === null ? ' · not in the filtered item list' : ''}
        </i>
      </span>
      {featureIssue !== null && <WatchSwitch issue={featureIssue} row={null} view={view} actions={actions} />}
      <span className="cn-refs">
        <Ref to={`issue:${feature.number}`} />
      </span>
    </div>
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
        <TicketWhat
          row={row}
          issue={issue}
          reasons={reasons}
          intake={intake}
          frozen={frozen}
          why={why}
          onWhy={() => setWhy(!why)}
          actions={actions}
          now={now}
        />
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

function TicketWhat({
  row,
  issue,
  reasons,
  intake,
  frozen,
  why,
  onWhy,
  actions,
  now,
}: {
  row: TicketRow;
  issue: Issue | null;
  reasons: readonly string[];
  intake: boolean;
  frozen: boolean;
  why: boolean;
  onWhy: () => void;
  actions: CockpitActions;
  now: number;
}): JSX.Element {
  return (
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
          onClick={onWhy}
          title="Why is nothing on this?"
        >
          ?
        </button>
      )}
    </span>
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
  const off = watchOff(watchLabel, row?.tracking === 'frozen', issue);
  const also = issue === null ? '' : cascadeNote(issue, containerTypes);
  const bucket = watchReading(issue, row, watchLabel);
  const number = issue?.number ?? row?.number;

  return (
    <span className={`tickets-switch ${off !== null ? 'off' : ''}`}>
      <AsyncButton
        className={bucket === 'watched' ? 'on w' : ''}
        disabled={off !== null || bucket === 'watched'}
        onClick={() => actions.setIssueWatched(number ?? 0, true)}
        title={off ?? `Tag #${number}${also} "${watchLabel}" so the harness picks it up`}
      >
        Watch
      </AsyncButton>
      <AsyncButton
        className={bucket === 'unwatched' ? 'on u' : ''}
        disabled={off !== null || bucket === 'unwatched'}
        onClick={() => actions.setIssueWatched(number ?? 0, false)}
        title={off ?? `Take "${watchLabel}" off #${number}${also}, so the harness leaves it alone`}
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
