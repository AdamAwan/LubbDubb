import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Issue, OpenPullRequest, QueueItem, SupplyState } from '../types.js';
import { buildGoalPage, furthestEnvironment, type GoalTrack } from '../view/goalPage.js';
import { buildGoalTrack } from '../view/goalStages.js';
import { Ref } from '../components/refs.js';
import { StaleChip } from './goalChips.js';
import { OverviewSwitch } from './overviews/OverviewSwitch.js';
import { ProfilePicker } from '../components/ProfilePicker.js';
import { GroupHead, PanelRows, type PanelRowModel, type RowGroup } from './PanelRow.js';
import { prRow } from './prRow.js';
import { Who } from '../components/who.js';
import { AgentOnIt } from '../components/AgentOnIt.js';
import { orphanCount, orphanGoal } from '../view/orphanGoal.js';
import { Tag } from '../components/tag.js';
import { agentRow, deskRow, ejectedRow, readyingRow } from './fleetRows.js';

// → docs/spec/17-cockpit.md

export function Overview({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  return (
    <>
      <OverviewSwitch shape="cards" actions={actions} />
      <div className="cn-grid">
        <Fleet view={view} actions={actions} />
        <GoalsInFlight view={view} actions={actions} />
        <Rack view={view} actions={actions} />
      </div>
    </>
  );
}

const FLEET_ROWS = 7;

function Fleet({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [showEnded, setShowEnded] = useState(false);
  const ended = view.past;
  const desk = view.deskRuns;
  const ejected = view.ejected;
  const readying = view.readying;
  const queued = view.upNext;
  const endedTotal = view.state.endedAgents;

  const out = [
    ...view.live.map((agent) => agentRow(agent, view, actions)),
    ...readying.map((action) => readyingRow(action, view)),
    ...desk.map((run) => deskRow(run, view)),
    ...ejected.map((held) => ejectedRow(held, view, actions)),
    ...(showEnded ? ended.map((agent) => agentRow(agent, view, actions)) : []),
  ];
  const room = Math.max(0, FLEET_ROWS - (view.live.length + readying.length + desk.length + ejected.length));
  const queueRows = queued.slice(0, room).map((item) => queueRow(item, view, actions));
  const rail = [...out, ...queueRows];

  return (
    <section className="cn-card cn-span2 cn-fleet">
      <h3>
        Fleet <FleetCount view={view} />
        <button
          type="button"
          className={`cn-more ${endedTotal === 0 ? 'cn-quiet' : ''}`}
          onClick={() => setShowEnded(!showEnded)}
          title="Shifts that have ended — the agents no longer running"
          aria-expanded={showEnded}
        >
          {endedTotal} shift{endedTotal === 1 ? '' : 's'} ended {showEnded ? '⌄' : '›'}
        </button>
      </h3>
      {view.live.length === 0 && desk.length === 0 && readying.length === 0 && ejected.length === 0 && (
        <p className="cn-empty">Nobody is out.</p>
      )}
      {showEnded && ended.length === 0 && <p className="cn-empty">No shift has ended.</p>}
      {/* The list is a recent tail; say so rather than let the count above mislead. */}
      {showEnded && endedTotal > ended.length && (
        <p className="cn-empty">
          The {ended.length} most recent, of {endedTotal}. Older runs are on the goal they were dispatched for.
        </p>
      )}
      <PanelRows rows={out} rail={rail} />
      <UpNextHead queued={queued} shown={queueRows.length} actions={actions} />
      {queueRows.length > 0 && <PanelRows rows={queueRows} rail={rail} />}
      {queued.length === 0 && <p className="cn-empty">Nothing is queued.</p>}
      <RunwayBand view={view} />
    </section>
  );
}

function FleetCount({ view }: { view: CockpitView }): JSX.Element {
  const { readying, deskRuns: desk, ejected } = view;
  return (
    <i className="cn-n">
      {view.live.length} out
      {/* Beside the count, not folded in: nobody has dispatched these yet and
          they take no slot, so "out" would be the wrong word. */}
      {readying.length > 0 && ` · ${readying.length} being readied`}
      {desk.length > 0 && ` · ${desk.length} at a keyboard`}
      {/* Counted apart from "out": nobody dispatched these and no agent is on
          them, but unlike a desk run each is holding a slot. */}
      {ejected.length > 0 && ` · ${ejected.length} taken off the fleet`}
    </i>
  );
}

/* The head of the queue, in the same list as the agents — nothing folded,
   nothing moves when opened. Always draws, even empty. */
function UpNextHead({
  queued,
  shown,
  actions,
}: {
  queued: readonly QueueItem[];
  shown: number;
  actions: CockpitActions;
}): JSX.Element {
  const asking = queued.filter((item) => item.status === 'unapproved').length;
  return (
    <GroupHead
      group={{
        key: 'upnext',
        label: 'Up next',
        foot: true,
        note: (
          <>
            {queued.length === 0 ? 'nothing queued' : `${queued.length} queued`}
            {asking > 0 && <span className="cn-alarm"> · {asking} on you</span>}
          </>
        ),
        control: (
          <>
            {queued.length > shown && (
              <button type="button" className="cn-group-more" onClick={() => actions.openPanel('upnext')}>
                All {queued.length} →
              </button>
            )}
            {/* The queue's *cause*: what the harness does next is decided off
                what the world just did, so this links to the signal feed
                rather than repeating the queue. No count — the sentence is
                the point, not a figure. Always drawn, even on an empty queue.
                → `WorldSignals` */}
            <button
              type="button"
              className="cn-group-more"
              onClick={() => actions.openPanel('signals')}
              title="What the world did — the feed these dispatch decisions are taken off"
            >
              Up next is determined by world signals →
            </button>
          </>
        ),
      }}
    />
  );
}

function RunwayBand({ view }: { view: CockpitView }): JSX.Element {
  const r = view.state.runway;
  const tone = view.state.control.paused ? 'grey' : RUNWAY_TONE[r.state];
  const total = r.inflight + r.queued + r.reservoir;
  return (
    <div className={`cn-runway cn-t-${tone}`}>
      <span className="cn-runway-read" title={runwayTitle(r)}>
        {runwayReading(r)}
      </span>
      <Tag>{RUNWAY_LABEL[r.state]}</Tag>
      <span className="cn-runway-say">{view.state.control.paused ? 'Dispatch is paused.' : r.headline}</span>
      {/* Same four buckets whatever the state, so a glance reads as one shape. */}
      <span className="cn-runway-bar" aria-hidden="true">
        <i className="cn-seg-inflight" style={{ flexGrow: r.inflight }} />
        <i className="cn-seg-queued" style={{ flexGrow: r.queued }} />
        <i className="cn-seg-reservoir" style={{ flexGrow: r.reservoir }} />
        {total === 0 && <i className="cn-seg-empty" style={{ flexGrow: 1 }} />}
      </span>
      <span className="cn-runway-legend">
        {r.queued} queued · {r.reservoir} unwatched
      </span>
    </div>
  );
}

function runwayReading(r: CockpitView['state']['runway']): string {
  if (r.runwayMinutes !== null) return fmtRunway(r.runwayMinutes);
  if (r.state === 'unknown') return '—';
  return `${r.idleSlots} idle`;
}

function runwayTitle(r: CockpitView['state']['runway']): string | undefined {
  if (r.runwayMinutes === null || r.medianLeadMinutes === null) return undefined;
  const held = r.medianHeldMinutes ?? 0;
  const fleet = `Fleet time: a ${fmtRunway(r.medianLeadMinutes)} median goal across ${r.inflight + r.queued} goals.`;
  return held <= 0
    ? fleet
    : `${fleet} Its median calendar span is ${fmtRunway(r.medianLeadMinutes + held)} — the ${fmtRunway(held)} spent waiting on you is not counted.`;
}

function fmtRunway(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const RUNWAY_TONE: Record<SupplyState, 'green' | 'amber' | 'grey'> = {
  healthy: 'green',
  thin: 'amber',
  dry: 'amber',
  starved: 'amber',
  unknown: 'grey',
};

const RUNWAY_LABEL: Record<SupplyState, string> = {
  healthy: 'Healthy',
  thin: 'Thin',
  dry: 'Dry',
  starved: 'Starved',
  unknown: 'No history yet',
};

/** @public shared with the overview's alternative shapes, which draw the same set. */
export const IN_FLIGHT = new Set(['active', 'has_pr', 'planning', 'delivered']);

function GoalsInFlight({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [showKept, setShowKept] = useState(false);
  const retained = view.state.retainedRuns ?? [];
  const working = retained.filter((issue) => retainedWorkInFlight(issue, view));
  const kept = retained.filter((issue) => !retainedWorkInFlight(issue, view));
  const goals = [...view.state.world.issues.filter((issue) => IN_FLIGHT.has(issue.pickup.status)), ...working];
  const orphans = orphanCount(view.state, goals);

  return (
    <section className="cn-card cn-span2 cn-lamp-mark">
      <h3>
        Goals in flight <i className="cn-n">{goals.length}</i>
        {orphans > 0 && (
          <i
            className="cn-n cn-alarm"
            title="These goals hang off no Feature. Their work will merge and close, and the backlog will never show it."
          >
            {orphans} with no Feature
          </i>
        )}
        <button
          type="button"
          className={`cn-more ${kept.length === 0 ? 'cn-quiet' : ''}`}
          onClick={() => setShowKept(!showKept)}
          title="Runs the harness still holds on closed tickets, with nothing left in flight — open one to dismiss it"
        >
          {kept.length} kept {showKept ? '⌄' : '›'}
        </button>
      </h3>
      {goals.length === 0 && !showKept && <p className="cn-empty">No goal is in flight.</p>}
      {showKept && kept.length === 0 && <p className="cn-empty">No run is being kept.</p>}
      <PanelRows
        rows={[
          ...goals.map((issue) => goalRow(issue, view, actions)),
          ...(showKept ? kept.map((issue) => goalRow(issue, view, actions)) : []),
        ]}
      />
    </section>
  );
}

function retainedWorkInFlight(issue: Issue, view: CockpitView): boolean {
  const ref = `issue:${issue.number}`;
  if (view.agentOnGoal.get(ref) !== undefined) return true;
  if (view.needsYou.some((n) => n.goalRef === ref)) return true;
  const page = buildGoalPage(view.state, ref, view.needsYou, null);
  if (page === null) return false;
  const track = buildGoalTrack(page.parts);
  return track.now + track.held + track.waiting > 0;
}

function goalRow(issue: Issue, view: CockpitView, actions: CockpitActions): PanelRowModel {
  const ref = `issue:${issue.number}`;
  const page = buildGoalPage(view.state, ref, view.needsYou, null);
  const track = page === null ? null : buildGoalTrack(page.parts);
  const asks = view.needsYou.filter((n) => n.goalRef === ref).length;
  const onIt = view.agentOnGoal.get(ref);
  const furthest = furthestEnvironment(view.state, ref);
  const orphan = orphanGoal(view.state, issue);

  return {
    key: String(issue.number),
    title: `#${issue.number} ${issue.title}`,
    className: `cn-goal-row ${orphan === null ? '' : 'cn-row-orphan'}`,
    open: () => actions.selectGoal(ref),
    openTitle: `Open goal #${issue.number} — its plan, its pull requests and anything it is asking you`,
    refs: null,
    facts: [
      ...(track !== null && track.total > 0
        ? [
            { label: 'parts', value: track.total },
            { label: 'merged', value: track.merged },
          ]
        : []),
      ...(asks > 0 ? [{ label: 'asking you', value: asks, alarm: true }] : []),
    ],
    whyLabel: PICKUP_WORD[issue.pickup.status] ?? issue.pickup.status,
    whyTone: PICKUP_TONE[issue.pickup.status] ?? 'quiet',
    why: issue.pickup.reasons.join(' '),
    reading: track !== null ? <Track track={track} /> : undefined,
    live: onIt !== undefined,
    lamp: onIt === undefined ? undefined : <AgentOnIt agentId={onIt.id} note={onIt.note} actions={actions} />,
    chips: (
      <>
        {/* Only drawn for an environment holding the goal *whole* — `partial` has
            no furthest anything. */}
        {furthest !== null && (
          <Tag tone="green" fill>
            {furthest}
          </Tag>
        )}
        {/* A retained run: the tracker's copy is stale, the harness's record is not. */}
        {issue.stale !== undefined && <StaleChip stale={issue.stale} now={view.now} />}
        {/* Not a `<Ref>` or button: the row's title already opens this goal. */}
        {orphan !== null && (
          <Tag tone="amber" fill title="This goal hangs off no Feature — open it to place it">
            ▲ no Feature
          </Tag>
        )}
      </>
    ),
  };
}

/**
 * The pickup kind in the operator's words. The kind is an identifier the
 * dispatcher passes between its own rules; `has_pr` reaching the glass unedited
 * asks the operator to know the enum before the row means anything.
 *
 * @public shared with the overview's alternative shapes.
 */
export const PICKUP_WORD: Record<string, string> = {
  has_pr: 'in review',
  active: 'working',
  eligible: 'up next',
  blocked: 'no capacity',
  retained: 'kept',
  container: 'a container',
};

const PICKUP_TONE: Record<string, 'ask' | 'hold' | 'quiet'> = {
  escalated: 'ask',
  unwatched: 'hold',
  blocked: 'hold',
  cooldown: 'hold',
  appraisal: 'hold',
};

function Track({ track }: { track: GoalTrack }): JSX.Element {
  const segs = [
    ...Array<string>(track.merged).fill('cn-done'),
    ...Array<string>(track.now).fill('cn-live'),
    ...Array<string>(track.held).fill('cn-block'),
    ...Array<string>(track.waiting).fill(''),
  ];
  return (
    <span className="cn-track" title={trackTitle(track)}>
      {segs.map((tone, i) => (
        <i className={`cn-seg ${tone}`} key={i} />
      ))}
    </span>
  );
}

function trackTitle(track: GoalTrack): string {
  const parts = [
    track.merged > 0 ? `${track.merged} merged` : '',
    track.now > 0 ? `${track.now} in progress` : '',
    track.held > 0 ? `${track.held} blocked` : '',
    track.waiting > 0 ? `${track.waiting} not started` : '',
  ].filter((part) => part !== '');
  return `${track.total} ${track.total === 1 ? 'part' : 'parts'} — ${parts.join(', ')}`;
}

function Rack({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const open = view.state.world.pullRequests;
  const closed = view.state.world.closedPullRequests;
  const merged = closed === undefined ? null : closed.filter((pr) => pr.merged).length;
  const asking = open.filter(isAsking);
  const answered = open.filter((pr) => isAssigned(pr) && !isAsking(pr));
  const fleet = open.filter((pr) => !isAssigned(pr));
  const grouped = asking.length + answered.length > 0;
  const marks = open.some((pr) => whoAsked(pr) !== null);
  const ordered = grouped ? [...asking, ...answered, ...fleet] : open;

  return (
    <section className="cn-card cn-span2 cn-lamp-mark cn-read-marks">
      <h3>
        Pull requests <i className="cn-n">{open.length} open</i>
        {/* Quiet at zero rather than absent, so a bare zero doesn't dominate the
            corner of a card whose subject is the rows underneath. */}
        {merged !== null && <span className={merged === 0 ? 'cn-more cn-quiet' : 'cn-more'}>{merged} merged</span>}
      </h3>
      {open.length === 0 && <p className="cn-empty">No pull request is open.</p>}
      <PanelRows
        layout="stacked"
        words="subline"
        rows={ordered.map((pr) => {
          const row = prRow(pr, view, actions);
          const who = marks ? { who: <Who name={whoAsked(pr)} /> } : {};
          if (!grouped) return { ...row, ...who };
          return { ...row, ...who, group: band(pr, asking.length, answered.length, fleet.length) };
        })}
      />
    </section>
  );
}

function isAssigned(pr: OpenPullRequest): boolean {
  return pr.viewerAssignment !== undefined;
}

function isAsking(pr: OpenPullRequest): boolean {
  return pr.attention.assignedToYou !== undefined;
}

function whoAsked(pr: OpenPullRequest): string | null {
  const author = pr.author?.trim() ?? '';
  return pr.viewerAuthored === false && author !== '' ? author : null;
}

function band(pr: OpenPullRequest, asking: number, answered: number, fleet: number): RowGroup {
  if (isAsking(pr)) return { key: 'asking', label: 'Assigned to review', note: `${asking}`, tone: 'ask' };
  if (isAssigned(pr)) return { key: 'answered', label: 'Assigned, not waiting on you', note: `${answered}` };
  return { key: 'fleet', label: 'The fleet’s', note: `${fleet}` };
}

export function queueRow(item: QueueItem, view: CockpitView, actions: CockpitActions): PanelRowModel {
  const config = view.state.config;
  const held = item.status !== 'dispatching';
  return {
    key: `${item.origin}|${item.rule}`,
    lamp: <i className="cn-lamp cn-queued-lamp" />,
    queued: true,
    title: item.title,
    refs: <Ref to={item.origin} />,
    facts: [{ label: 'rule', value: item.rule }],
    whyLabel: item.status,
    whyTone: item.status === 'unapproved' ? 'ask' : held ? 'hold' : 'quiet',
    why: item.reason,
    chips:
      item.expedited === true ? (
        <Tag title="Its goal is marked a priority, so everything under it is ranked first">priority</Tag>
      ) : undefined,
    action: (
      <ProfilePicker
        profiles={config.profiles}
        value={item.override ?? null}
        defaultProfile={item.override === undefined ? (item.profile ?? null) : null}
        inheritLabel={item.profileSource === 'pin' && item.override === undefined ? 'Pinned' : 'Auto'}
        onPick={(profile) => void actions.setUpNextProfile(item.origin, profile)}
      />
    ),
  };
}
