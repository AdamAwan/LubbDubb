import type { JSX } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { FeatureBoardPayload, FeatureChildRow, FeatureRollup } from '../types.js';
import type { FeatureHold, FeatureHolds } from '../view/featureHolds.js';
import type { NeedRow } from '../view/needsYou.js';
import { featureHolds } from '../view/featureHolds.js';
import { needBody } from '../console/NeedsBand.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, holdingLabel } from '../console/QueueRail.js';
import { Ref } from './refs.js';
import { Button } from './button.js';
import { relTime } from './util.js';
import { FeatureAccount, FeatureMarks } from './featureAccount.js';

// → docs/spec/17-cockpit.md#the-feature-board

/**
 * The feature board, worked rather than read.
 *
 * The board answers _how is the Environments work going_ — which is the question
 * nobody outside the fleet can otherwise ask, and it answers it well. What it
 * does not answer is _what do I do about it_: `holds.you` reaches the card as a
 * count in the corner, one more reading on a surface already made of them, with
 * no way from the number to the thing it counts.
 *
 * This mode keeps the context and puts the act in front of it. One Feature at a
 * time: its summariser's account and its bar above, because that is what makes
 * the ask legible — then its asks, one at a time, with the control that answers
 * them; then its goals. The same two readings the board already computes, in the
 * order somebody sitting down to work would want them.
 */
export function FeatureFocus({
  board,
  view,
  actions,
  onAnswered,
}: {
  board: FeatureBoardPayload;
  view: CockpitView;
  actions: CockpitActions;
  onAnswered: () => void;
}): JSX.Element {
  const cards = board.features.map((rollup) => ({
    rollup,
    holds: featureHolds(
      view.state,
      view.needsYou,
      rollup.children.map((c) => c.number),
    ),
  }));
  const ordered = [...cards].sort(
    (a, b) => b.holds.you.length - a.holds.you.length || a.rollup.number - b.rollup.number,
  );
  const picked = ordered.find((c) => c.rollup.number === view.featureCard) ?? ordered[0];

  if (picked === undefined) return <p className="muted">Nothing in the tracker hangs off a container yet.</p>;

  return (
    <div className="cn-ff">
      {/* Every Feature stays one press away, with its own count on it: the whole
          argument for focusing on one is lost if choosing which costs a trip back
          to the board. */}
      <nav className="cn-ff-pick" aria-label="Features">
        {ordered.map(({ rollup, holds }) => (
          <button
            key={rollup.number}
            type="button"
            aria-current={rollup.number === picked.rollup.number}
            className={rollup.number === picked.rollup.number ? 'cn-ff-on' : ''}
            onClick={() => actions.setFeatureQuery({ featureCard: rollup.number })}
          >
            {rollup.title}
            {holds.you.length > 0 && <i className="cn-ff-n">{holds.you.length}</i>}
          </button>
        ))}
      </nav>

      <Context
        summaries={view.state.config.featureSummaries}
        rollup={picked.rollup}
        holds={picked.holds}
        onChanged={onAnswered}
      />
      <YourMove holds={picked.holds} view={view} actions={actions} onAnswered={onAnswered} />
      <Goals rollup={picked.rollup} holds={picked.holds} actions={actions} />
    </div>
  );
}

/**
 * What the Feature is and how it is going — the summariser's own account, never
 * reworded. This is the half of the board worth keeping: an ask means very little
 * on its own, and a great deal under the paragraph saying what the work is for.
 */
function Context({
  rollup,
  summaries,
  holds,
  onChanged,
}: {
  rollup: FeatureRollup;
  summaries: boolean;
  holds: FeatureHolds;
  onChanged: () => void;
}): JSX.Element {
  const c = rollup.counts;
  return (
    <header className="cn-ff-head">
      <h2>
        {rollup.title} <Ref to={`issue:${rollup.number}`} />
        <span className="cn-ff-marks">
          <FeatureMarks feature={rollup} onChanged={onChanged} />
        </span>
      </h2>
      {rollup.summary === null ? (
        summaries && <p className="cn-psub">Not yet summarised.</p>
      ) : (
        <>
          {rollup.summary.headline !== null && <p className="cn-ff-headline">{rollup.summary.headline}</p>}
          <p className="cn-ff-lede">{rollup.summary.standing}</p>
          <FeatureAccount summary={rollup.summary} />
        </>
      )}
      <div className="cn-ff-counts">
        <span>
          <b>{c.delivered}</b> delivered
        </span>
        <span>
          <b>{c.inFlight}</b> in flight
        </span>
        <span>
          <b>{c.queued}</b> queued
        </span>
        {c.unwatched > 0 && (
          <span>
            <b>{c.unwatched}</b> not watched
          </span>
        )}
        <span className="cn-ff-of">{c.total} in all</span>
        <span className="cn-ff-courts">
          <b className={holds.you.length > 0 ? 'cn-ff-you' : ''}>{holds.you.length}</b> yours ·{' '}
          <b>{holds.fleet.length}</b> the fleet&apos;s · <b>{holds.world.length}</b> the world&apos;s
        </span>
      </div>
    </header>
  );
}

/**
 * The Feature's asks, one at a time. Skipping is a cursor through this sitting
 * rather than a place: the order is the server's, and a reload should start at
 * the top of it again.
 */
function YourMove({
  holds,
  view,
  actions,
  onAnswered,
}: {
  holds: FeatureHolds;
  view: CockpitView;
  actions: CockpitActions;
  onAnswered: () => void;
}): JSX.Element {
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const rows = holds.you
    .map((hold) => ({ hold, row: needOf(hold, view) }))
    .filter((pair): pair is { hold: FeatureHold; row: NeedRow } => pair.row !== null);
  const live = rows.filter(({ row }) => !skipped.includes(row.id));
  const here = live[0];

  if (rows.length === 0) {
    return (
      <section className="cn-ff-move cn-ff-move-clear">
        <h3>Nothing here is waiting on you</h3>
        <p className="cn-psub">
          {holds.fleet.length > 0
            ? `The fleet is holding ${holds.fleet.length} of these itself.`
            : 'The work on this Feature is with the fleet.'}
        </p>
      </section>
    );
  }

  if (here === undefined) {
    return (
      <section className="cn-ff-move cn-ff-move-clear">
        <h3>That is all of them, for now</h3>
        <p className="cn-psub">{skipped.length} set aside in this sitting.</p>
        <Button tone="secondary" onClick={() => setSkipped([])}>
          Bring them back
        </Button>
      </section>
    );
  }

  const body = needBody(here.row, view, actions);

  return (
    <section className={`cn-ff-move cn-t-${KIND_TONE[here.row.kind]}`}>
      <h3>
        Your move
        <span className="cn-ff-progress">
          {rows.length - live.length + 1} of {rows.length} on this Feature
        </span>
      </h3>

      <div className="cn-ff-ask">
        <div className="cn-ff-ask-head">
          <span className="cn-sym" aria-hidden="true">
            {KIND_SYMBOL[here.row.kind]}
          </span>
          <span className="cn-ff-ask-title">{here.row.title}</span>
        </div>
        <div className="cn-ff-ask-meta">
          <span className="cn-ff-kind">{KIND_LABEL[here.row.kind]}</span>
          {here.row.goalRef !== null && <Ref to={here.row.goalRef} />}
          {here.row.originRef !== null && here.row.originRef !== here.row.goalRef && <Ref to={here.row.originRef} />}
          {here.row.raisedAt !== '' && <span>{relTime(here.row.raisedAt, view.now)}</span>}
          {here.row.holding > 0 && <span className="cn-ff-holding">{holdingLabel(here.row.holding)}</span>}
        </div>

        <div className="cn-ff-ask-body" onClickCapture={() => queueMicrotask(onAnswered)}>
          {body}
        </div>

        <footer className="cn-ff-ask-foot">
          <Button tone="secondary" ghost onClick={() => setSkipped([...skipped, here.row.id])}>
            Skip for now
          </Button>
          {live.length > 1 && <span className="cn-psub">{live.length - 1} more here</span>}
        </footer>
      </div>
    </section>
  );
}

/**
 * The Feature's goals, as lanes: the standing the board already quotes, and
 * whose move each one is. This is the context the ask above sits in — which of
 * these the ask is about, and what else is going on around it.
 */
function Goals({
  rollup,
  holds,
  actions,
}: {
  rollup: FeatureRollup;
  holds: FeatureHolds;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <section className="cn-ff-goals">
      <h3>The goals</h3>
      {rollup.children.map((child) => (
        <GoalLane key={child.number} child={child} holds={holds} actions={actions} />
      ))}
    </section>
  );
}

function GoalLane({
  child,
  holds,
  actions,
}: {
  child: FeatureChildRow;
  holds: FeatureHolds;
  actions: CockpitActions;
}): JSX.Element {
  const yours = holds.you.filter((h) => h.goal === child.number);
  const fleet = holds.fleet.filter((h) => h.goal === child.number);
  const onIt = holds.agents.some((a) => a.goal === child.number && a.state === 'working');
  const top = yours[0];

  return (
    <article className={`cn-ff-lane ${yours.length > 0 ? 'cn-ff-lane-mine' : ''}`}>
      <span className={`cn-ff-standing cn-fb-${child.standing}`} />
      <button type="button" className="cn-ff-lane-name" onClick={() => actions.selectGoal(`issue:${child.number}`)}>
        {child.title}
      </button>
      <Ref to={`issue:${child.number}`} />
      <span className="cn-ff-lane-move">
        {top !== undefined ? (
          <b className="cn-ff-you">
            your move{yours.length > 1 ? ` · ${yours.length}` : ''} — {top.kind}
          </b>
        ) : onIt ? (
          <span>an agent is on it</span>
        ) : fleet.length > 0 ? (
          <span>the fleet · {fleet[0]?.kind}</span>
        ) : (
          <span className="cn-psub">{STANDING_WORD[child.standing] ?? child.standing}</span>
        )}
      </span>
    </article>
  );
}

const STANDING_WORD: Record<string, string> = {
  delivered: 'delivered',
  inFlight: 'in flight',
  fellShort: 'fell short',
  settled: 'settled',
  queued: 'queued',
  unwatched: 'not watched',
};

/** The ask a hold stands for, or null where the snapshot no longer carries it. */
function needOf(hold: FeatureHold, view: CockpitView): NeedRow | null {
  if (hold.needId === null) return null;
  return view.needsYou.find((n) => n.id === hold.needId) ?? null;
}
