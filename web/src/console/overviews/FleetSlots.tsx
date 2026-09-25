import type { JSX } from 'react';
import type { Agent } from '../../types.js';
import type { CockpitView } from '../../view/viewModel.js';
import type { CockpitActions } from '../../cockpit/actions.js';
import { Ref } from '../../components/refs.js';
import { standsFor } from '../../view/goalPage.js';
import { elapsed } from '../../components/util.js';
import { agentLamp } from '../fleetRows.js';

// → docs/spec/17-cockpit.md#what-the-fleet-is-doing-above-the-ask

/** How many agents get a tile before the rest become a count on the control. */
const TILED = 5;

/**
 * What the fleet is doing, as a tile per slot under the ask.
 *
 * The focus shape's argument is that the thing to do is in front of you and
 * nothing else is — and the cost of that turned out to be the operator leaving
 * it to check the fleet was still moving, which is the trip this shape exists to
 * remove. So the reading comes to the shape rather than the shape being abandoned
 * for it, at a weight that keeps the ask the only thing at full voice.
 *
 * **A tile per _slot_, not per agent**, which is what makes the free one a
 * reading rather than a gap: the card answers "is the fleet full" in the same
 * glance as "what is it on", and those are the two questions that were sending
 * people to the Cards shape. The free tile is drawn once and carries its own
 * count, so the card cannot grow a row of empty boxes on a deployment with a
 * large cap.
 *
 * **Under the ask, not over it.** At this height above it, the tiles push the ask
 * itself down the page, which is the one thing the shape exists to prevent — and
 * a tile is a thing to look at rather than a line to skim past, so it belongs
 * after the work rather than in front of it.
 *
 * Drawn on an empty fleet too, saying so. A card that vanishes when its reading
 * is empty reads as one that failed to load, which is the argument the ask's own
 * aside already makes for a goal-less ask.
 */
export function FleetSlots({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const out = view.live;
  const tiled = out.slice(0, TILED);
  const untiled = out.length - tiled.length;
  /* Clamped at zero rather than subtracted blind: an agent parked on a limit or
     taken off the fleet holds its slot while the cap is lowered under it, so the
     live count outruns the cap and a raw difference draws negative free slots. */
  const free = Math.max(0, view.state.control.cap - out.length);

  return (
    <section className="cn-ov-slots">
      <header className="cn-ov-slots-head">
        <h3>Out on the fleet</h3>
        <span className="cn-ov-slots-read">{reading(view)}</span>
        <button
          type="button"
          className="cn-ov-slots-all"
          onClick={() => actions.setOverviewShape('cards')}
          title="The Cards shape — the whole fleet, the queue behind it and the runway"
        >
          {untiled > 0 ? `${untiled} more →` : 'Fleet →'}
        </button>
      </header>

      <div className="cn-ov-slot-grid">
        {tiled.map((agent) => (
          <SlotTile key={agent.id} agent={agent} view={view} actions={actions} />
        ))}
        {free > 0 && <FreeTile free={free} view={view} actions={actions} />}
        {out.length === 0 && free === 0 && (
          <p className="cn-ov-slots-none">The cap is zero — no slot to dispatch into.</p>
        )}
      </div>
    </section>
  );
}

/**
 * The card's one sentence. It counts the things a tile cannot: a desk run takes
 * no slot, so it has no tile and would otherwise be a person at a keyboard the
 * focus shape never mentions.
 */
function reading(view: CockpitView): string {
  const working = view.live.filter((a) => a.status !== 'waiting').length;
  const holding = view.live.length - working;
  const free = Math.max(0, view.state.control.cap - view.live.length);
  const parts = [`${working} working`];
  if (holding > 0) parts.push(`${holding} holding`);
  if (view.deskRuns.length > 0) parts.push(`${view.deskRuns.length} at a keyboard`);
  parts.push(free === 0 ? 'no slot free' : `${free} slot${free === 1 ? '' : 's'} free`);
  if (view.state.control.paused) parts.push('dispatch paused');
  return parts.join(' · ');
}

/**
 * The tile ground for a lamp modifier. Derived from `agentLamp` rather than read
 * off the status a second time, because the two disagreed: an agent with an open
 * escalation drew the asking lamp on the *running* ground, so the tile said "this
 * one is fine" under a lamp saying "this one wants you", and the ground is the
 * half that is read at a glance.
 *
 * **Amber, not red, for the one that asked.** The ground carries the cut the
 * glance needs — moving, or waiting on you — and the lamp keeps the finer one.
 * Red here put three shouting tiles under an ask on a deployment with three open
 * escalations, on the shape whose argument is that one thing at a time is loud.
 * Red on this surface belongs to the ask, and every escalation is already an ask
 * in the queue the operator is working through.
 */
function slotTone(lamp: string): string {
  return lamp === 'cn-wait' || lamp === 'cn-lamp-ask' ? 'cn-ov-slot-wait' : 'cn-ov-slot-run';
}

/**
 * One agent's slot: what it is on, how long it has been at it, and what it says
 * it is doing. The title is the control and opens the agent's drawer; the ref
 * sits beside it rather than inside it.
 *
 * The note gets its own line rather than competing with the title for one, which
 * is the whole reason this shape has room where a single row did not.
 *
 * One ref, and it is the one `standsFor` answers: a crash recovery's requeue is
 * dispatched at `job:<id>` and keeps the work it redoes on the job, so the origin
 * drawn literally is a way to an opaque job id.
 */
function SlotTile({ agent, view, actions }: { agent: Agent; view: CockpitView; actions: CockpitActions }): JSX.Element {
  const task = view.taskFor(agent);
  const origin = task?.originRef ?? null;
  const ref = standsFor(view.state, origin) ?? origin;
  const note = view.limitParked.has(agent.id) ? 'Out of account limit' : (agent.note ?? agent.status);
  const title = task?.title ?? agent.id;
  const lamp = agentLamp(agent, view);

  return (
    <article className={`cn-ov-slot ${slotTone(lamp)}`}>
      <div className="cn-ov-slot-top">
        <i className={`cn-lamp ${lamp}`} />
        <button
          type="button"
          className="cn-ov-slot-name"
          onClick={() => actions.select(agent.id)}
          title={`${title} — open this agent's drawer`}
        >
          {title}
        </button>
        <span className="cn-ov-slot-for">{elapsed(agent.startedAt, agent.endedAt, view.now)}</span>
      </div>
      <div className="cn-ov-slot-foot">
        <span className="cn-ov-slot-note" title={note}>
          {note}
        </span>
        {ref !== null && (
          <span className="cn-refs cn-ov-slot-refs">
            <Ref to={ref} />
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * The slots nobody is in, as one tile carrying its count.
 *
 * What it says is about the *queue*, not the slot: an idle slot with work
 * waiting is a fleet about to move, and an idle slot with nothing queued is a
 * fleet out of work — the same emptiness, and the difference is the only thing
 * anybody would act on. So the tile is the way to whichever of those it is.
 */
function FreeTile({ free, view, actions }: { free: number; view: CockpitView; actions: CockpitActions }): JSX.Element {
  const queued = view.upNext.length;
  const paused = view.state.control.paused;
  const say = paused ? 'dispatch is paused' : queued === 0 ? 'nothing queued' : `next off the queue of ${queued}`;

  return (
    <article className="cn-ov-slot cn-ov-slot-free">
      <div className="cn-ov-slot-top">
        <i className="cn-lamp cn-off" />
        <button
          type="button"
          className="cn-ov-slot-name"
          onClick={() => (queued === 0 ? actions.openPanel('launch') : actions.openPanel('upnext'))}
          title={
            queued === 0 ? 'Write a brief — the fleet is out of work' : 'Up next — the queue these slots fill from'
          }
        >
          {free === 1 ? '1 slot free' : `${free} slots free`}
        </button>
      </div>
      <div className="cn-ov-slot-foot">
        <span className="cn-ov-slot-note">{say}</span>
      </div>
    </article>
  );
}
