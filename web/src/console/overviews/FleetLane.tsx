import type { JSX } from 'react';
import type { Agent } from '../../types.js';
import type { CockpitView } from '../../view/viewModel.js';
import type { CockpitActions } from '../../cockpit/actions.js';
import { Ref } from '../../components/refs.js';
import { standsFor } from '../../view/goalPage.js';
import { elapsed } from '../../components/util.js';
import { agentLamp } from '../Overview.js';

// → docs/spec/17-cockpit.md#the-overview

/** How many agents the lane names before the rest become a count. */
const NAMED = 3;

/**
 * What the fleet is doing, as one row above the ask.
 *
 * The focus shape's argument is that the thing to do is in front of you and
 * nothing else is — and the cost of that turned out to be the operator leaving
 * it to check the fleet was still moving, which is the flick-back the shape
 * exists to remove. So the reading comes to the shape rather than the shape
 * being abandoned for it: a card of its own, one row tall, carrying what the
 * fleet band's row carries minus everything that does not fit on a line.
 *
 * **Above the ask, not below it.** Below, a long ask body scrolls the lane off
 * exactly when it would be reached for, and it is the glance that has to be
 * cheap rather than the card. Above, it shares the switch's band and is never
 * more than a line away from wherever the reader's eye already is.
 *
 * It names agents rather than counting them — a count answers whether the fleet
 * is alive and nothing else, and "is it alive" was never the question that sent
 * anybody to the Cards shape. Past {@link NAMED} the rest *are* a count, on the
 * control that hands over the shape which draws them all.
 *
 * Drawn on an empty fleet too, saying so. A band that vanishes when its reading
 * is empty reads as one that failed to load, which is the argument the ask's own
 * aside already makes for a goal-less ask.
 */
export function FleetLane({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const out = view.live;
  const named = out.slice(0, NAMED);
  const rest = out.length - named.length;
  const paused = view.state.control.paused;

  return (
    <div className="cn-ov-lane">
      {/* "Out 4", never "4 of 3": an agent parked on a limit or ejected still
          holds its slot while the cap is lowered under it, so a denominator here
          draws a fleet over its own cap and reads as a bug in the reading. The
          top bar's `CAP` control is where the cap is a number. */}
      <span className="cn-ov-lane-label">{out.length === 0 ? 'Fleet' : `Out ${out.length}`}</span>

      {out.length === 0 ? (
        <span className="cn-ov-lane-none">{paused ? 'Nobody is out, and dispatch is paused.' : 'Nobody is out.'}</span>
      ) : (
        <span className="cn-ov-lane-items">
          {named.map((agent) => (
            <LaneItem key={agent.id} agent={agent} view={view} actions={actions} />
          ))}
        </span>
      )}

      {/* The Cards shape owns the fleet band, so the way to the rest of the fleet
          is that shape rather than a second copy of it here — the same answer
          `buildLeads` gives for a reading the cards already draw. */}
      <button
        type="button"
        className="cn-ov-lane-more"
        onClick={() => actions.setOverviewShape('cards')}
        title="The Cards shape — the whole fleet, the queue behind it and the runway"
      >
        {rest > 0 ? `${rest} more →` : 'Fleet →'}
      </button>
    </div>
  );
}

/**
 * One agent on the line: what it is on, and how long it has been at it. The
 * title is the control and opens the agent's drawer; the ref sits beside it
 * rather than inside it.
 *
 * **The agent's own note is on the hover, not on the line.** Four fields across
 * three agents does not fit a row at any width the cockpit is read at — every
 * one of them ellipses, and the field that loses is the name, which is the one
 * carrying which work this is. The lamp already says what state the agent is in,
 * and the drawer behind the name carries the note in full.
 *
 * One ref, and it is the one `standsFor` answers: a crash recovery's requeue is
 * dispatched at `job:<id>` and keeps the work it redoes on the job, so the origin
 * drawn literally is a way to an opaque job id. Where nothing stands in, the two
 * are the same ref and the fleet band's pair collapses to the half that is worth
 * the width on a line this tight.
 */
function LaneItem({ agent, view, actions }: { agent: Agent; view: CockpitView; actions: CockpitActions }): JSX.Element {
  const task = view.taskFor(agent);
  const origin = task?.originRef ?? null;
  const ref = standsFor(view.state, origin) ?? origin;
  const note = view.limitParked.has(agent.id) ? 'Out of account limit' : (agent.note ?? agent.status);
  const title = task?.title ?? agent.id;

  return (
    <span className="cn-ov-lane-item">
      <i className={`cn-lamp ${agentLamp(agent, view)}`} />
      <button
        type="button"
        className="cn-ov-lane-name"
        onClick={() => actions.select(agent.id)}
        title={`${title} — ${note}. Opens this agent's drawer.`}
      >
        {title}
      </button>
      {ref !== null && (
        <span className="cn-refs cn-ov-lane-refs">
          <Ref to={ref} />
        </span>
      )}
      <span className="cn-ov-lane-for">{elapsed(agent.startedAt, agent.endedAt, view.now)}</span>
    </span>
  );
}
