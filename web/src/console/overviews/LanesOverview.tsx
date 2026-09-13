import type { JSX } from 'react';
import type { CockpitView } from '../../view/viewModel.js';
import type { CockpitActions } from '../../cockpit/actions.js';
import type { NeedRow } from '../../view/needsYou.js';
import type { Issue } from '../../types.js';
import { Ref } from '../../components/refs.js';
import { buildGoalPage, buildGoalTrack, type GoalTrack } from '../../view/goalPage.js';
import { Button } from '../../components/button.js';
import { KIND_LABEL, holdingLabel } from '../QueueRail.js';
import { IN_FLIGHT, PICKUP_WORD } from '../Overview.js';
import { OverviewSwitch } from './OverviewSwitch.js';
import { byWeight } from './asks.js';

// → docs/spec/17-cockpit.md#the-overview

/**
 * Shape C — lanes. The overview keeps its rhythm and changes its subject: from
 * the fleet to the work. One lane per goal in flight, its parts drawn as a track
 * off the same `buildGoalTrack` fold the cards use, and one column on the right
 * answering the only question the operator needs — **whose move is it**. Goals
 * where the answer is theirs sort to the top and carry the control.
 *
 * What it gives up is the ask that belongs to no goal: an upgrade, a config gap,
 * a supply ask. Those are counted in the footer and stay on the rail.
 */
export function LanesOverview({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goals = view.state.world.issues.filter((issue) => IN_FLIGHT.has(issue.pickup.status));
  const lanes = goals
    .map((issue) => lane(issue, view))
    .sort((a, b) => {
      if (a.asks.length !== b.asks.length) return b.asks.length - a.asks.length;
      return b.held - a.held;
    });
  const yours = lanes.filter((l) => l.asks.length > 0).length;
  const homeless = view.needsYou.filter((n) => n.goalRef === null);

  return (
    <div className="cn-ov-lanes">
      <OverviewSwitch shape="lanes" actions={actions} />

      <header className="cn-ov-lanes-banner">
        {yours === 0 ? (
          <span className="cn-ov-banner-clear">No goal is waiting on you.</span>
        ) : (
          <span className="cn-ov-banner-count">
            <em>{yours}</em> of {lanes.length} {lanes.length === 1 ? 'goal is' : 'goals are'} your move
          </span>
        )}
      </header>

      {lanes.length === 0 && <p className="cn-empty">No goal is in flight.</p>}

      {lanes.map((l) => (
        <Lane key={l.issue.number} lane={l} actions={actions} />
      ))}

      <Legend />

      {homeless.length > 0 && (
        <p className="cn-ov-lanes-homeless">
          {homeless.length} {homeless.length === 1 ? 'ask belongs' : 'asks belong'} to no goal —{' '}
          {homeless.map((n) => KIND_LABEL[n.kind]).join(', ')}. They stay on the rail; this shape has no lane for them.
        </p>
      )}
    </div>
  );
}

interface LaneModel {
  issue: Issue;
  track: GoalTrack | null;
  asks: NeedRow[];
  held: number;
  onIt: boolean;
}

function lane(issue: Issue, view: CockpitView): LaneModel {
  const ref = `issue:${issue.number}`;
  const page = buildGoalPage(view.state, ref, view.needsYou, null);
  const asks = view.needsYou.filter((n) => n.goalRef === ref).sort(byWeight);
  return {
    issue,
    track: page === null ? null : buildGoalTrack(page.parts),
    asks,
    held: asks.reduce((sum, a) => sum + a.holding, 0),
    onIt: view.agentOnGoal.get(ref) !== undefined,
  };
}

function Lane({ lane, actions }: { lane: LaneModel; actions: CockpitActions }): JSX.Element {
  const ref = `issue:${lane.issue.number}`;
  const top = lane.asks[0];

  return (
    <article className={`cn-ov-lane ${top === undefined ? '' : 'cn-ov-lane-mine'}`}>
      <div className="cn-ov-lane-goal">
        <button type="button" className="cn-ov-lane-name" onClick={() => actions.selectGoal(ref)}>
          {lane.issue.title}
        </button>
        <Ref to={ref} />
      </div>

      <Track track={lane.track} stuck={top !== undefined} />

      <div className="cn-ov-lane-move">
        {top === undefined ? (
          <>
            <span className="cn-ov-lane-who">
              Harness · {lane.onIt ? 'working' : (PICKUP_WORD[lane.issue.pickup.status] ?? lane.issue.pickup.status)}
            </span>
            {lane.track !== null && lane.track.total > 0 && (
              <span className="cn-ov-lane-facts">
                {lane.track.merged} of {lane.track.total} merged
              </span>
            )}
          </>
        ) : (
          <>
            <span className="cn-ov-lane-who cn-ov-lane-yours">
              Your move
              {lane.held > 0 && ` · ${holdingLabel(lane.held)}`}
              {lane.asks.length > 1 && ` · ${lane.asks.length} asks`}
            </span>
            <Button tone="primary" size="small" onClick={() => actions.openPanel({ ask: top.id })}>
              {KIND_LABEL[top.kind]}
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * The parts, as segments. The track is the goal's shape at a glance — what has
 * landed, what an agent is on, where the wall is — and it is the whole of what
 * this shape says about the harness's progress: a colour, never a row somebody
 * has to read.
 */
function Track({ track, stuck }: { track: GoalTrack | null; stuck: boolean }): JSX.Element {
  if (track === null || track.total === 0) {
    return (
      <div className="cn-ov-track">
        <span className="cn-ov-seg cn-ov-seg-none">no plan yet</span>
      </div>
    );
  }
  const segs: { key: string; kind: string; label: string }[] = [];
  for (let i = 0; i < track.merged; i += 1) segs.push({ key: `m${i}`, kind: 'done', label: '✓' });
  for (let i = 0; i < track.now; i += 1) {
    segs.push({
      key: `n${i}`,
      kind: stuck && i === 0 ? 'stuck' : 'live',
      label: stuck && i === 0 ? 'asked you' : 'working',
    });
  }
  for (let i = 0; i < track.held; i += 1) segs.push({ key: `h${i}`, kind: 'held', label: 'held' });
  for (let i = 0; i < track.waiting; i += 1) segs.push({ key: `w${i}`, kind: 'wait', label: '' });

  return (
    <div
      className="cn-ov-track"
      title={`${track.merged} merged · ${track.now} live · ${track.held} held · ${track.waiting} waiting`}
    >
      {segs.map((s) => (
        <span key={s.key} className={`cn-ov-seg cn-ov-seg-${s.kind}`}>
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Legend(): JSX.Element {
  return (
    <div className="cn-ov-lane-legend">
      <span>
        <i className="cn-ov-sw cn-ov-seg-done" /> landed
      </span>
      <span>
        <i className="cn-ov-sw cn-ov-seg-live" /> an agent is on it
      </span>
      <span>
        <i className="cn-ov-sw cn-ov-seg-stuck" /> stopped on you
      </span>
      <span>
        <i className="cn-ov-sw cn-ov-seg-held" /> held
      </span>
      <span>
        <i className="cn-ov-sw cn-ov-seg-wait" /> not started
      </span>
    </div>
  );
}
