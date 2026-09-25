import { useMemo, useState, type JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { LIVE_WORK, widenedFor } from '../cockpit/place.js';
import type { TicketStateFacet } from '../types.js';
import type { CockpitView } from '../view/viewModel.js';
import { UnrecordedWork } from './UnrecordedWork.js';
import { TicketsBoard } from './TicketsBoard.js';
import { absDate } from './util.js';
import { useTicketFeed } from './ticketsFeed.js';
import { TicketsFacets, TicketsFilterBar, type TicketQueryPlace } from './ticketsFilters.js';
import { TicketsTable } from './ticketsRows.js';

// → docs/spec/17-cockpit.md

interface TicketsPanelProps {
  query: TicketQueryPlace;
  onQuery: (next: Partial<TicketQueryPlace>) => void;
  view: CockpitView;
  actions: CockpitActions;
  now: number;
}

export function TicketsPanel({ query, onQuery, view, actions, now }: TicketsPanelProps): JSX.Element {
  const feed = useTicketFeed(query);
  const [clearedState, setClearedState] = useState('');
  const { states, anchorAt } = feed;

  const worldIssues = view.state.world.issues;
  const live_ = useMemo(() => new Map(worldIssues.map((issue) => [issue.number, issue])), [worldIssues]);

  return (
    <div className="tickets">
      <div className="tickets-head">
        <h1>Tickets</h1>
        <i className="tickets-live">{feed.live.toLocaleString()} live</i>
        <i className="tickets-n">{feed.kept.toLocaleString()} kept</i>
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

      <TicketsFilterBar
        query={query}
        onQuery={onQuery}
        states={states}
        loaded={feed.rows.length}
        total={feed.total}
        totalCostUsd={feed.totalCostUsd}
        onClearedState={setClearedState}
      />

      <NarrowingNotes
        query={query}
        states={states}
        clearedState={clearedState}
        onQuery={onQuery}
        onRestored={() => setClearedState('')}
      />

      <TicketsFacets
        query={query}
        onQuery={onQuery}
        states={states}
        features={feed.features}
        orphanCount={feed.orphanCount}
      />

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
        <TicketsTable
          query={query}
          onQuery={onQuery}
          feed={feed}
          live={live_}
          view={view}
          actions={actions}
          now={now}
        />
      )}
    </div>
  );
}

function NarrowingNotes({
  query,
  states,
  clearedState,
  onQuery,
  onRestored,
}: {
  query: TicketQueryPlace;
  states: readonly TicketStateFacet[];
  clearedState: string;
  onQuery: (next: Partial<TicketQueryPlace>) => void;
  onRestored: () => void;
}): JSX.Element {
  const widened = widenedFor(query.state, query.tracking, states);
  return (
    <>
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
              onRestored();
            }}
            title="Back to the table, narrowed to that state again"
          >
            Back to the table
          </button>
        </div>
      )}
    </>
  );
}
