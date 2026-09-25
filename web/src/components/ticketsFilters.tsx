import type { JSX } from 'react';
import type {
  TicketFeatureFacet,
  TicketOrder,
  TicketStateFacet,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../types.js';
import { statePick } from '../cockpit/place.js';
import { fmtUsd } from './util.js';

export interface TicketQueryPlace {
  watch: TicketWatchFilter;
  tracking: TicketTrackingFilter;
  state: string;
  feature: number | 'none' | null;
  group: 'feature' | 'flat';
  order: TicketOrder;
  view: 'table' | 'card';
  columns: string[];
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

export function TicketsFilterBar({
  query,
  onQuery,
  states,
  loaded,
  total,
  totalCostUsd,
  onClearedState,
}: {
  query: TicketQueryPlace;
  onQuery: (next: Partial<TicketQueryPlace>) => void;
  states: readonly TicketStateFacet[];
  loaded: number;
  total: number;
  totalCostUsd: number;
  onClearedState: (state: string) => void;
}): JSX.Element {
  return (
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
      <ViewSwitch query={query} onQuery={onQuery} states={states} onClearedState={onClearedState} />
      <span className="tickets-sum">
        {/* Loaded of total, because an infinite list with no total says nothing
            about whether you are near the end. */}
        <b>{loaded}</b> of <b>{total.toLocaleString()}</b> loaded
        {totalCostUsd > 0 && (
          <>
            {' · '}
            <b>{fmtUsd(totalCostUsd)}</b> spent
          </>
        )}
      </span>
    </div>
  );
}

function ViewSwitch({
  query,
  onQuery,
  states,
  onClearedState,
}: {
  query: TicketQueryPlace;
  onQuery: (next: Partial<TicketQueryPlace>) => void;
  states: readonly TicketStateFacet[];
  onClearedState: (state: string) => void;
}): JSX.Element {
  return (
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
                onClearedState(query.state === 'any' ? '' : query.state);
                onQuery({ view: 'card', state: 'any' });
              } else {
                onClearedState('');
                onQuery({ view: 'table' });
              }
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* Drawn only where the provider has native states. A filter offering states
   the tracker cannot produce is a control that always returns nothing. */
export function TicketsFacets({
  query,
  onQuery,
  states,
  features,
  orphanCount,
}: {
  query: TicketQueryPlace;
  onQuery: (next: Partial<TicketQueryPlace>) => void;
  states: readonly TicketStateFacet[];
  features: readonly TicketFeatureFacet[];
  orphanCount: number;
}): JSX.Element {
  return (
    <>
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
    </>
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
