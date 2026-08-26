import { useState, type JSX } from 'react';
import type { CockpitView, DeskRun } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, GoalArrival, Issue, OpenPullRequest, QueueItem, SupplyState, WorldEvent } from '../types.js';
import { buildGoalPage, buildGoalTrack, furthestEnvironment, goalOfPr, type GoalTrack } from '../view/goalPage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { elapsed, fmtUsd, relTime } from '../components/util.js';
import { Ref, RefText, refLabel } from '../components/refs.js';
import { CiLadder, waitedFor } from './GoalPage.js';
import { ProfilePicker } from '../components/ProfilePicker.js';
import { PanelRows, type PanelRowModel } from './PanelRow.js';
import { AgentOnIt } from '../components/AgentOnIt.js';

/**
 * What is shown when no goal is selected: five cards, rows rather than pictures.
 *
 * Document order is reading order — Fleet, Goals in flight, Pull requests, Up
 * next, World signals — and no card carries a CSS `order`, so the DOM and the
 * page agree at every width. The arrangement across tracks is `.cn-grid`'s
 * business alone.
 *
 * Two rules run through all five. **Nothing here re-decides what the server
 * decided**: a PR's court is `attention.status`, its checks are `ciVerdict`, a
 * queued item's hold is the queue's own sentence, and a goal's state is its
 * `pickup.status` — every one quoted, none parsed. And **an empty card still
 * draws**, muted, because a surface that vanishes when quiet is indistinguishable
 * from one that broke.
 */
export function Overview({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  return (
    <div className="cn-grid">
      <GrammarSwitch view={view} actions={actions} />
      <Fleet view={view} actions={actions} />
      <GoalsInFlight view={view} actions={actions} />
      <Rack view={view} actions={actions} />
      <UpNext view={view} actions={actions} />
      <WorldSignals view={view} />
    </div>
  );
}

/**
 * The preview switch, while the row grammar is being chosen.
 *
 * It spans the grid above the cards because it is a statement about all five of
 * them, and it is drawn dashed because it is not part of the cockpit: it exists
 * to be looked at once, and it goes with the grammar that is not chosen. The
 * grammar itself is on the place, so a link carries whichever one the sender was
 * reading. → docs/spec/17-cockpit.md#the-row-grammar
 */
function GrammarSwitch({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  return (
    <div className="cn-grammar">
      <b>Row grammar</b>
      <span>
        {view.panelGrammar === 'facts'
          ? 'Every row is its title and its quantities, each said with what it is.'
          : 'Every card is a table: the quantities become headings, and a row is cells.'}
      </span>
      <span className="cn-gap" />
      {(['facts', 'columns'] as const).map((grammar) => (
        <button
          key={grammar}
          type="button"
          className={`cn-pill ${view.panelGrammar === grammar ? 'cn-on' : ''}`}
          onClick={() => actions.setPanelGrammar(grammar)}
        >
          {grammar === 'facts' ? 'Facts' : 'Columns'}
        </button>
      ))}
    </div>
  );
}

/**
 * Who is out, what they are on, and what it has cost so far.
 *
 * The lamp is red on an agent `escalationByAgent` names, which is a stronger
 * reading than `status === 'waiting'`: an agent can be parked with nothing asked
 * of the operator, and only the first of those belongs in the rail. The two
 * disagree in exactly that case, and the ask wins.
 *
 * Ended shifts are behind a disclosure rather than a second card. They are the
 * same rows read for a different question — what happened — and the count stays
 * in the header at zero, muted, so the way in does not move.
 */
function Fleet({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [showEnded, setShowEnded] = useState(false);
  const ended = view.past;
  const desk = view.deskRuns;

  return (
    <section className="cn-card cn-span2">
      <h3>
        Fleet{' '}
        <i className="cn-n">
          {view.live.length} out
          {/* Stated beside the count rather than added to it: nobody dispatched
              these and they take no slot, so "out" would be the wrong word and
              a bigger number would be the wrong reading. */}
          {desk.length > 0 && ` · ${desk.length} at a keyboard`}
        </i>
        <button
          type="button"
          className={`cn-more ${ended.length === 0 ? 'cn-quiet' : ''}`}
          onClick={() => setShowEnded(!showEnded)}
          title="Shifts that have ended — the agents no longer running"
        >
          {ended.length} shift{ended.length === 1 ? '' : 's'} ended {showEnded ? '⌄' : '›'}
        </button>
      </h3>
      {view.live.length === 0 && desk.length === 0 && <p className="cn-empty">Nobody is out.</p>}
      {showEnded && ended.length === 0 && <p className="cn-empty">No shift has ended.</p>}
      <PanelRows
        grammar={view.panelGrammar}
        subject="Agent is on"
        refsLabel="On"
        rows={[
          ...view.live.map((agent) => agentRow(agent, view, actions)),
          // Below the dispatched agents, because that is the order the harness
          // answers "what is happening" in: what it sent out, then what it did
          // not send.
          ...desk.map((run) => deskRow(run, view)),
          ...(showEnded ? ended.map((agent) => agentRow(agent, view, actions)) : []),
        ]}
      />
      <RunwayBand view={view} />
    </section>
  );
}

/**
 * What is behind the agents above — the fleet's runway, along the foot of the
 * card the agents are on.
 *
 * **The placement is the sentence.** Who is out, then what is queued behind
 * them, in that order and in one card: a fleet reading that leaves out "and then
 * what" is the reading an operator has to assemble themselves, every time, from
 * two cards that never agreed on what counted as work. The foot rather than the
 * head because the agents are the card's subject and this is its consequence,
 * and it costs nothing to reach — Fleet's rows are bounded by the agent cap, so
 * this line never travels far down the page.
 *
 * **Nothing here re-decides what the server decided**, the rule the other five
 * cards keep: the state, the wording and every count are quoted from
 * `state.runway`, which is the same function's answer as the bench row's. The
 * band draws no control for the same reason the row carries no button — the
 * reading is a statement about the fleet, and a "watch something" shortcut here
 * would make it a prompt for the quickest fix rather than the truest one.
 *
 * **And it always draws**, muted when healthy, on the empty-card rule: a band
 * that vanished when the queue was full would be indistinguishable from one that
 * broke, on exactly the deployment where nobody has seen it before.
 */
function RunwayBand({ view }: { view: CockpitView }): JSX.Element {
  const r = view.state.runway;
  // Paused is not idleness and must not wear the alarm: the fleet is stopped
  // because somebody stopped it, and `idleSlots` is already zero for them.
  const tone = view.state.control.paused ? 'grey' : RUNWAY_TONE[r.state];
  const total = r.inflight + r.queued + r.reservoir;
  return (
    <div className={`cn-runway cn-t-${tone}`}>
      <span className="cn-runway-read" title={runwayTitle(r)}>
        {runwayReading(r)}
      </span>
      <span className="cn-tag">{RUNWAY_LABEL[r.state]}</span>
      <span className="cn-runway-say">{view.state.control.paused ? 'Dispatch is paused.' : r.headline}</span>
      {/* The same four buckets whatever the state, so a glance across a week
          reads as one shape changing rather than as several different bands. */}
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

/**
 * The reading itself, and it changes unit rather than lying.
 *
 * With nothing queued there is no runway to state — a duration would be a
 * forecast about a queue that does not exist — so the band counts idle slots
 * instead, which is the fact that has replaced it.
 *
 * The duration is **fleet time**: the hours a person was the next mover are out
 * of the median it is built from
 * ([25](../../../docs/spec/25-supply.md#the-lead-time-is-fleet-time)). The band
 * is one line and cannot say so, which is what {@link runwayTitle} is for — the
 * bench row and its notification carry it in the sentence.
 */
function runwayReading(r: CockpitView['state']['runway']): string {
  if (r.runwayMinutes !== null) return fmtRunway(r.runwayMinutes);
  if (r.state === 'unknown') return '—';
  return `${r.idleSlots} idle`;
}

/**
 * What the one-line reading had to leave out, on hover: which quantity it is, and
 * the calendar span it came from.
 *
 * A tooltip rather than a second line because the band's whole placement argument
 * is that it costs nothing to reach; a figure that dropped by two thirds with no
 * account of why anywhere on the card reads as a gauge that broke, though.
 * Composed here from quoted figures only — the sentence itself stays the server's.
 */
function runwayTitle(r: CockpitView['state']['runway']): string | undefined {
  if (r.runwayMinutes === null || r.medianLeadMinutes === null) return undefined;
  const held = r.medianHeldMinutes ?? 0;
  const fleet = `Fleet time: a ${fmtRunway(r.medianLeadMinutes)} median goal across ${r.inflight + r.queued} goals.`;
  return held <= 0
    ? fleet
    : `${fleet} Its median calendar span is ${fmtRunway(r.medianLeadMinutes + held)} — the ${fmtRunway(held)} spent waiting on you is not counted.`;
}

/** `53m`, `3h 07m` — the band is one line, so the reading is as short as it can be and still be a duration. */
function fmtRunway(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Total over {@link SupplyState} for `KIND_TONE`'s reason: a state added to the
 * lens fails the typecheck here rather than drawing in whatever the last rule in
 * the sheet said. `unknown` is grey deliberately — it is not a mild warning, it
 * is the absence of a reading.
 */
const RUNWAY_TONE: Record<SupplyState, 'green' | 'amber' | 'grey'> = {
  healthy: 'green',
  thin: 'amber',
  dry: 'amber',
  starved: 'amber',
  unknown: 'grey',
};

/** One word per state, and the same words the spec uses, so a support answer and the glass agree. */
const RUNWAY_LABEL: Record<SupplyState, string> = {
  healthy: 'Healthy',
  thin: 'Thin',
  dry: 'Dry',
  starved: 'Starved',
  unknown: 'No history yet',
};

/**
 * One agent: what it is on, and the way to each of the things it names.
 *
 * **The name is the button, and the refs sit beside it** — the backlog row's
 * shape, for its reason: a link inside a button is a second destination for one
 * click, and the row's own destination is the transcript. Before that split this
 * card said "Fix failing CI on PR #412" under "#212" with neither of them a way
 * anywhere, so the two questions a fleet row raises — *what is it working on* and
 * *what is that* — could only be answered somewhere else.
 *
 * **Two refs, not one.** The origin is what was dispatched at (`pr:412` for a CI
 * task, `issue:212:part:writes` for a part), and it is a pull request as often as
 * a goal. So the goal is resolved separately through {@link goalOfPr} — the
 * server's own three-way match, read backwards — and drawn as well whenever it is
 * not already what the origin says. A ticketless pull request resolves to no goal
 * and draws none, which is the honest answer rather than an invented one.
 */
function agentRow(agent: Agent, view: CockpitView, actions: CockpitActions): PanelRowModel {
  const task = view.taskFor(agent);
  const origin = task?.originRef ?? null;
  const done = agent.endedAt !== null;
  const limited = view.limitParked.has(agent.id);
  const lamp = view.escalationByAgent.has(agent.id)
    ? 'cn-lamp-ask'
    : done
      ? 'cn-off'
      : agent.status === 'waiting'
        ? 'cn-wait'
        : 'cn-run';
  return {
    key: agent.id,
    lamp: <i className={`cn-lamp ${lamp}`} />,
    title: task?.title ?? agent.id,
    open: () => actions.select(agent.id),
    openTitle: "Open this agent's drawer",
    // Two refs where there are two: the origin it was dispatched at, and the goal
    // behind it when that origin is a pull request some ticket owns.
    refs: <OnWhat origin={origin} view={view} />,
    facts: [
      // A limit park says so where the note would be. The note underneath is
      // whatever the agent last said it was doing, which on a parked row reads as
      // though it still is.
      { label: 'doing', value: limited ? 'Out of account limit' : (agent.note ?? agent.status), alarm: limited },
      { label: 'for', value: elapsed(agent.startedAt, agent.endedAt, view.now) },
      ...(agent.costUsd !== null ? [{ label: 'cost', value: fmtUsd(agent.costUsd) }] : []),
    ],
    // What is going on with this row, as a word, with the harness's own sentence
    // behind it.
    ...agentState(agent, view),
    // The way out of the park, where the park is shown — beside the name rather
    // than inside it, since the row's own click opens the transcript.
    action: limited ? (
      <AsyncButton
        className="cn-btn"
        onClick={() => actions.resumeAgent(agent.id)}
        title={agent.waitingReason ?? 'Resume this agent now the limit has cleared'}
        pendingLabel="Resuming…"
      >
        Resume
      </AsyncButton>
    ) : undefined,
    spent: done,
  };
}

/**
 * Why a fleet row is not moving, as one word and the sentence behind it.
 *
 * The four states are the harness's own and are read from four different facts,
 * because they are four different things — an escalation naming the agent, the
 * limit park, the stall park, and a plain wait. They are ranked rather than
 * merged: an agent that is asking you something and also parked is your move
 * first, and a row can only wear one word.
 *
 * A running agent wears none. That is the point of the column: on a fleet of five
 * the two words in it are the two rows worth looking at, where five `?` markers
 * were five rows to hover.
 */
function agentState(agent: Agent, view: CockpitView): Pick<PanelRowModel, 'why' | 'whyLabel' | 'whyTone'> {
  const escalation = view.escalationByAgent.get(agent.id);
  if (escalation !== undefined) {
    // The ask itself, not a summary of it: the rail carries the same sentence, and
    // two surfaces wording one question differently is the drift the refs rule
    // exists to stop one layer down.
    return { whyLabel: 'question', whyTone: 'ask', why: escalation.prompt };
  }
  if (view.limitParked.has(agent.id)) {
    return {
      whyLabel: 'limit',
      whyTone: 'hold',
      why:
        (agent.waitingReason ?? 'The account’s usage limit is spent.') +
        ' It takes a fleet slot until it is resumed or ended.',
    };
  }
  const stallExpiry = view.stallExpiryByAgent.get(agent.id);
  if (stallExpiry !== undefined) {
    return {
      whyLabel: 'stalled',
      whyTone: 'hold',
      why:
        'It stopped without saying so. The harness records it done by itself ' +
        `${relTime(stallExpiry, view.now)} unless it speaks again.`,
    };
  }
  if (agent.status === 'waiting') {
    return { whyLabel: 'blocked', whyTone: 'hold', why: agent.waitingReason };
  }
  // How a shift ended, on the rows behind the disclosure. `done` is the ordinary
  // ending and wears nothing — a word on every ended row would say only that the
  // row has ended, which the list it is in already says.
  if (ENDED_BADLY[agent.status] !== undefined) {
    return { whyLabel: ENDED_BADLY[agent.status], whyTone: 'quiet', why: agent.waitingReason };
  }
  return {};
}

/** The endings worth a word, in the harness's own vocabulary. */
const ENDED_BADLY: Partial<Record<Agent['status'], string>> = {
  failed: 'failed',
  crashed: 'crashed',
  killed: 'killed',
  interrupted: 'stopped',
};

/**
 * What a dispatch was aimed at, as ways there: the origin itself, and the goal
 * behind it when the origin is a pull request some ticket owns.
 *
 * Shared by the fleet rows and nothing else so far, and a component rather than
 * two lines inline because "which refs does this row carry" is the decision that
 * keeps getting made differently on each surface that lists work.
 *
 * A dispatch with no origin still draws the group, empty: `cn-refs` is a ruled
 * slot in the row, and a slot that disappears on the rows that have nothing to put
 * in it leaves the list ragged rather than columned.
 */
function OnWhat({ origin, view }: { origin: string | null; view: CockpitView }): JSX.Element {
  const pr = origin === null ? null : /^pr:(\d+)/.exec(origin);
  const goal = pr ? goalOfPr(view.state, Number(pr[1])) : null;
  return (
    <>
      {origin !== null && <Ref to={origin} label={pr ? `PR ${refLabel(origin)}` : refLabel(origin)} />}
      {goal !== null && <Ref to={goal} />}
    </>
  );
}

/**
 * A validation check somebody is running at their own keyboard.
 *
 * It is in flight and it is not an agent, and every difference between the two
 * is drawn rather than left to be inferred:
 *
 * - **A `div`, not a button.** There is no transcript to open, nothing to kill
 *   and nothing to inject into — so the row offers no way in at all. A card
 *   wearing an agent's affordances with none of them working is worse than one
 *   that never offered them.
 * - **A hollow lamp**, where an agent's is filled. The harness is not running
 *   this and cannot report on it; what it knows is that somebody said they were.
 * - **No cost column.** Nothing here is billed to the fleet, and a `$0.00` would
 *   read as "cheap" rather than "not ours to count".
 * - **A dashed edge**, the same grammar the lamp uses: this entry was not cut
 *   from a dispatch.
 *
 * The hover carries the two things a glance cannot: that it takes no slot, and
 * that it ends on its own. It leaves the list by itself when the reading lands,
 * when the session closes, or when the claim ages out — the entry is drawn off a
 * claim the server has already put through `claimIsLive`, so it goes at the same
 * instant the claim stops blocking `validate-check`.
 */
function deskRow(run: DeskRun, view: CockpitView): PanelRowModel {
  return {
    key: `${run.originRef}|${run.checkId}`,
    lamp: <i className="cn-lamp cn-desk-lamp" />,
    title: run.title,
    refs: <Ref to={run.originRef} />,
    facts: [
      { label: 'check', value: run.letter },
      { label: 'who', value: run.label },
      { label: 'for', value: elapsed(run.claimedAt, null, view.now) },
    ],
    // The desk run's own state, in the same column the agents wear theirs: this is
    // what is going on with the row, and it is not a dispatch. The two things a
    // glance cannot carry are behind it — that it takes no slot, and that it ends
    // on its own.
    whyLabel: 'at a keyboard',
    whyTone: 'quiet',
    why:
      `Nobody dispatched this: ${run.label} claimed check ${run.letter} of ${refLabel(run.originRef)} ` +
      `${relTime(run.claimedAt, view.now)}, at their own keyboard. It takes no fleet slot, and it ends ` +
      'when the reading lands, when the session closes, or when the claim ages out.',
    desk: true,
  };
}

/**
 * The statuses that mean the harness has a goal in hand *now*. Read off
 * `pickup.status`, which is the dispatcher's own answer to "what am I doing with
 * this", rather than re-inferred from agents, plans and pull requests — three
 * inputs the server has already folded into one word.
 */
const IN_FLIGHT = new Set(['active', 'has_pr', 'planning', 'delivered']);

/**
 * Every goal with work in flight, each a way into its own page.
 *
 * The row's track is folded by {@link buildGoalTrack} off the very page the click
 * opens, so what a segment counts and what the plan draws underneath cannot
 * disagree — that is the whole reason the helper exists rather than a second
 * pass over `PlanPart.status` here.
 *
 * The court is read off `needsYou`, the rail's own queue: a goal is in your court
 * exactly when the rail is holding an ask about it. Anything else would let the row
 * say "you" with nothing to answer, or the rail hold a row the overview marks as
 * the harness's business — and it is said once, as the alarmed `asking you` count,
 * rather than a second time as a chip whose only reading was that count being
 * non-zero.
 */
function GoalsInFlight({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goals = view.state.world.issues.filter((issue) => IN_FLIGHT.has(issue.pickup.status));

  return (
    <section className="cn-card cn-span2">
      <h3>
        Goals in flight <i className="cn-n">{goals.length}</i>
      </h3>
      {goals.length === 0 && <p className="cn-empty">No goal is in flight.</p>}
      <PanelRows
        grammar={view.panelGrammar}
        subject="Goal"
        rows={goals.map((issue) => goalRow(issue, view, actions))}
      />
    </section>
  );
}

function goalRow(issue: Issue, view: CockpitView, actions: CockpitActions): PanelRowModel {
  const ref = `issue:${issue.number}`;
  const page = buildGoalPage(view.state, ref, view.needsYou);
  const track = page === null ? null : buildGoalTrack(page.parts);
  const asks = view.needsYou.filter((n) => n.goalRef === ref).length;
  const furthest = furthestEnvironment(view.state, ref);

  return {
    key: String(issue.number),
    title: `#${issue.number} ${issue.title}`,
    className: 'cn-goal-row',
    open: () => actions.selectGoal(ref),
    openTitle: `Open goal #${issue.number} — its plan, its pull requests and anything it is asking you`,
    // The row *is* the way to this goal, so it names nothing else: a ref beside
    // the title would be a second token for the destination the row already is.
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
    // The pickup status *is* the row's state, so it wears the state column rather
    // than sitting as a fact with a bare `?` beside it holding its own reasons.
    // Two readings of one verdict, and the marker was the half that said nothing
    // until you hovered it. In the operator's words, not the enum's: `has_pr` is a
    // value the dispatcher passes to itself.
    whyLabel: PICKUP_WORD[issue.pickup.status] ?? issue.pickup.status,
    whyTone: PICKUP_TONE[issue.pickup.status] ?? 'quiet',
    // The dispatcher's own account of what it is doing with this goal — most
    // actionable first, and until now on no overview surface at all.
    why: issue.pickup.reasons.join(' '),
    reading: track !== null ? <Track track={track} /> : undefined,
    // An agent on one of this goal's parts, read off the parts rather than off the
    // track: `now` counts `in_review` too, and a pull request sitting open is not
    // somebody's hands on the work.
    live: page !== null && page.parts.some((part) => part.agentLive),
    chips: (
      <>
        {/* Where the work actually got to, on the row rather than a page deeper.
            Only ever drawn for an environment holding the goal *whole* — `partial`
            has no furthest anything, and a chip claiming one would be the boolean
            rollup the reach fold exists to refuse. */}
        {furthest !== null && <i className="cn-chip cn-ok">{furthest}</i>}
      </>
    ),
  };
}

/**
 * `IssuePickupStatusKind` in the words the page is written in. The kind is an
 * identifier the dispatcher passes between its own rules, and every one of them
 * that reached the glass did so unedited — `has_pr` is the shape of that, and it
 * asks the operator to know the enum before the row means anything.
 *
 * A status with no entry falls through as itself, so a kind added server-side
 * degrades to the old reading rather than to a blank.
 */
const PICKUP_WORD: Record<string, string> = {
  has_pr: 'in review',
  active: 'working',
  eligible: 'up next',
  blocked: 'no capacity',
  retained: 'kept',
  container: 'a container',
};

/**
 * `hold` is the harness stopped and waiting on something: no capacity, no watch
 * label, a cooldown to sit out. `ask` is the one status parked on a person by
 * design. Everything else is the harness getting on with it, and quiet — the tone
 * is about whether the row wants anything, not about how far along it is.
 */
const PICKUP_TONE: Record<string, 'ask' | 'hold' | 'quiet'> = {
  escalated: 'ask',
  unwatched: 'hold',
  blocked: 'hold',
  cooldown: 'hold',
  appraisal: 'hold',
};

/**
 * One segment per part, in the four groups the goal page draws its waves in and
 * wearing the same tones: green landed, blue moving, red stuck, bare not started.
 * A goal with no plan has no segments — a single empty bar would claim a part
 * that does not exist.
 */
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

/**
 * What the segments mean, in words, on hover. Four colours with no legend is a
 * reading only somebody who has read this file can take, and a legend on the card
 * would cost more room than the track itself — so the bar keeps the shape and the
 * hover carries the key. Only the groups this goal actually has, most advanced
 * first, so the sentence is about *this* goal rather than the vocabulary.
 */
function trackTitle(track: GoalTrack): string {
  const parts = [
    track.merged > 0 ? `${track.merged} merged` : '',
    track.now > 0 ? `${track.now} in progress` : '',
    track.held > 0 ? `${track.held} blocked` : '',
    track.waiting > 0 ? `${track.waiting} not started` : '',
  ].filter((part) => part !== '');
  return `${track.total} ${track.total === 1 ? 'part' : 'parts'} — ${parts.join(', ')}`;
}

/**
 * Every open pull request, and the toggle that takes one off the harness's books.
 *
 * The toggle is **disabled rather than absent** with no ignore label configured:
 * the gate being off is a fact about the deployment worth seeing, and a control
 * that comes and goes with a config key reads as a bug in the page.
 *
 * The merged count is drawn only where the snapshot carries a closed list at all.
 * Absent means the retention window is off — nothing was counted, which is not
 * the same claim as none merged.
 */
function Rack({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { config } = view.state;
  const open = view.state.world.pullRequests;
  const closed = view.state.world.closedPullRequests;
  const merged = closed === undefined ? null : closed.filter((pr) => pr.merged).length;
  const { watchLabel } = config;

  return (
    <section className="cn-card cn-span2">
      <h3>
        Pull requests <i className="cn-n">{open.length} open</i>
        {merged !== null && <span className="cn-more">{merged} merged</span>}
      </h3>
      {open.length === 0 && <p className="cn-empty">No pull request is open.</p>}
      <PanelRows
        grammar={view.panelGrammar}
        subject="Pull request"
        refsLabel="Goal"
        rows={open.map((pr) => prRow(pr, view, actions, watchLabel))}
      />
    </section>
  );
}

/**
 * One open pull request: its checks, whose court it is in, and the toggle that
 * takes it off the harness's books.
 */
function prRow(pr: OpenPullRequest, view: CockpitView, actions: CockpitActions, watchLabel: string): PanelRowModel {
  // The server's verdict, not a second reading of the labels: `unwatched` is the
  // first arm `prAttentionStatus` takes, so on an open PR it *is* the absent tag.
  // Drawn as a spent row for the reason the backlog dims an unwatched goal — the
  // chip alone leaves a row the harness will never touch sitting at the same
  // weight as the ones it is working.
  const unwatched = pr.attention.status === 'unwatched';
  // The goal this PR is delivering, joined the server's own three ways rather
  // than through the plan parts alone: a goal worked whole has no parts at all,
  // which is most finished goals, and the rack drew no goal for any of them.
  const goal = goalOfPr(view.state, pr.number);
  const onIt = view.agentOnBranch.get(pr.branch);
  return {
    key: String(pr.number),
    title: pr.title,
    // The pull request's own number moves out of the title and into the refs
    // slot, where every other card keeps what a row names: as a prefix it was a
    // way somewhere that only this card put there.
    refs: (
      <>
        <Ref to={`pr:${pr.number}`} />
        {goal !== null && <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />}
      </>
    ),
    facts: prFacts(pr, view.now),
    // Whose court it is in, which is the one question the card is for — the
    // server's word, with the server's own reasoning behind it. It was drawn
    // twice before, as a `?` holding the reasons and as a chip holding the same
    // reasons in a `title`, one column apart: two hovers, one sentence, and a
    // state column that said nothing.
    whyLabel: pr.attention.status,
    whyTone: COURT_TONE[pr.attention.status] ?? 'quiet',
    why: pr.attention.reasons.join(' '),
    // What is happening to this pull request *now* beats what its checks last
    // said: an agent on the branch is about to change them, so the ladder is a
    // reading of a commit that is being replaced. Only while one is actually on
    // it — every other row keeps its checks. The chip is `AgentOnIt`, the same one
    // a plan part draws, because it is the same sentence.
    reading:
      onIt === undefined ? <CiLadder pr={pr} /> : <AgentOnIt agentId={onIt.id} note={onIt.note} actions={actions} />,
    toggle: (
      <AsyncButton
        className="cn-eye"
        disabled={watchLabel === ''}
        onClick={() => actions.setPrWatched(pr.number, unwatched)}
        title={
          watchLabel === ''
            ? 'No watch label configured — the watch gate is off'
            : unwatched
              ? `Tag this PR "${watchLabel}" and let the harness work it`
              : `Take the "${watchLabel}" tag off so the harness leaves this PR alone`
        }
      >
        <Eye open={!unwatched} />
      </AsyncButton>
    ),
    spent: unwatched,
    // And the row itself says so, which is the reading that carries across a card:
    // the marker above is where to *go*, this is what is *happening*.
    live: onIt !== undefined,
  };
}

/**
 * Whose court, in the tones the state column already speaks.
 *
 * `you` is the only one that is your move, so it is the only `ask`. A pull request
 * nobody's turn — stalled, or opted out — is amber for the reason the fleet's
 * parks are: nothing is going to happen to it on its own.
 */
const COURT_TONE: Record<string, 'ask' | 'hold' | 'quiet'> = {
  you: 'ask',
  stalled: 'hold',
  unwatched: 'hold',
};

/**
 * What is true of this pull request that the ladder and the court do not say.
 *
 * `branch` used to be the only one, and it is the row's least useful fact: the
 * title says what the work is, the refs say where it is, and a slug repeats both
 * in a form nothing here is asked in. These three are each a *reason a pull
 * request is not merged yet*, which is the question a rack of open pull requests
 * exists to answer — and each is drawn only where it is true, so a row with none
 * of them is visibly a pull request with nothing in its way.
 */
function prFacts(pr: OpenPullRequest, now: number): PanelRowModel['facts'] {
  const facts: { label: string; value: string; alarm?: boolean }[] = [];
  if (pr.unresolvedComments.length > 0) {
    facts.push({ label: 'comments', value: String(pr.unresolvedComments.length), alarm: true });
  }
  // Only the real conflict: `behind` is a base the harness updates by itself, and
  // an alarm on it would be an alarm on every pull request open while main moves.
  if (pr.mergeableState === 'dirty') facts.push({ label: 'merge', value: 'conflict', alarm: true });
  const since = pr.attention.reviewWaitingSince;
  if (since !== undefined) facts.push({ label: 'waiting', value: waitedFor(since, now) });
  return facts.length === 0 ? undefined : facts;
}

/**
 * The watch switch, as the state it is in rather than as the word for the other
 * one.
 *
 * `watch` / `unwatch` was a verb that changed under the pointer: a row said
 * `unwatch` precisely when it *was* watched, so the card's own text contradicted
 * every row it appeared on until you worked out it was an instruction. An open eye
 * says the harness is looking at this; a struck one says it is not. The verb
 * survives in the hover, where an instruction belongs.
 */
function Eye({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M1 8s2.6-4.2 7-4.2S15 8 15 8s-2.6 4.2-7 4.2S1 8 1 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="8" r="1.9" fill="currentColor" />
      {!open && <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * What the last pulse ranked, each row carrying the queue's own reason verbatim.
 *
 * The reason is the whole point of the card — it is the direct answer to "are we
 * working on the right thing" — so it wraps rather than being clipped to one
 * line, and nothing here re-words it. A held item is toned amber off `status`,
 * which is a fact the same sentence already states in words.
 */
function UpNext({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const items = view.state.upcoming?.items ?? [];
  return (
    <section className="cn-card">
      <h3>
        Up next <i className="cn-n">{items.length} queued</i>
      </h3>
      {items.length === 0 && <p className="cn-empty">Nothing is queued.</p>}
      <PanelRows
        grammar={view.panelGrammar}
        subject="Dispatch"
        refsLabel="On"
        rows={items.map((item) => queueRow(item, view, actions))}
      />
    </section>
  );
}

/**
 * A queued dispatch, as a way to what it is queued against — the origin is a goal
 * ref as often as a pull request, so it goes through `Ref` rather than out to the
 * provider unconditionally, and the reason it quotes carries `#n` mentions of its
 * own.
 */
function queueRow(item: QueueItem, view: CockpitView, actions: CockpitActions): PanelRowModel {
  const config = view.state.config;
  const held = item.status !== 'dispatching';
  return {
    key: `${item.origin}|${item.rule}`,
    title: item.title,
    refs: <Ref to={item.origin} />,
    facts: [
      { label: 'rule', value: item.rule },
      { label: 'status', value: item.status, alarm: held },
    ],
    // The queue's own sentence, verbatim and unre-worded — the direct answer to
    // "are we working on the right thing". Behind the marker rather than on the
    // glass: it is a paragraph on the rows that are held, and the word that says
    // *which* rows those are is a fact above.
    why: item.reason,
    chips:
      // Why this row is where it is. Without it a flagged goal's parts sit at the
      // top of the panel with nothing anywhere connecting the order to the click
      // that caused it.
      item.expedited === true ? (
        <i className="cn-chip" title="Its goal is marked a priority, so everything under it is ranked first">
          priority
        </i>
      ) : undefined,
    // What this row will run on, and the one place it can be changed before it
    // runs. The queue is where the judgement is available — an operator reading
    // "resolve the conflict on issue/390/watcher" knows it is mechanical work, and
    // the row is in front of them.
    action: (
      <ProfilePicker
        profiles={config.profiles}
        value={item.override ?? null}
        // Only meaningful while nothing is overridden: with an override standing,
        // `item.profile` *is* the override, and naming it as the fallback would
        // promise that clearing the control changes nothing.
        defaultProfile={item.override === undefined ? (item.profile ?? null) : null}
        inheritLabel={item.profileSource === 'pin' && item.override === undefined ? 'Pinned' : 'Auto'}
        onPick={(profile) => void actions.setUpNextProfile(item.origin, profile)}
      />
    ),
  };
}

/**
 * The world's changes, one row per `(kind, ref)` with a count — three review
 * comments on one pull request are one signal, not three unrelated rows. The
 * server's order (newest first) is kept: re-sorting by count would move the row
 * an operator is watching the moment it moves again.
 */
function WorldSignals({ view }: { view: CockpitView }): JSX.Element {
  // Both halves of "what has happened", newest first: the world's own transitions
  // and the environments the work has arrived in.
  const rows = [
    ...groupSignals(view.state.worldEvents),
    ...arrivalSignals(view.state.environmentArrivals ?? [], view.now),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  return (
    <section className="cn-card">
      <h3>
        World signals <i className="cn-n">{rows.length}</i>
      </h3>
      {rows.length === 0 && <p className="cn-empty">The world has not moved.</p>}
      <PanelRows
        grammar={view.panelGrammar}
        subject="What happened"
        refsLabel="Goal"
        rows={rows.map((row) => ({
          key: row.key,
          title: <RefText text={row.summary} />,
          // The goal behind the signal, beside the sentence rather than inside
          // it. The summary's own `#412` already links out to the provider, so
          // repeating the pull request here would be one ref twice — what a
          // signal never offers is the way onto the goal page.
          refs: <Ref to={goalBehind(view, row.ref)} />,
          facts: [
            { label: 'kind', value: row.kind },
            { label: 'when', value: relTime(row.createdAt, view.now) },
            // The count is a fact with a name now, rather than the same slot a
            // fleet row puts a dollar figure in.
            ...(row.count > 1 ? [{ label: 'times', value: `×${row.count}` }] : []),
          ],
        }))}
      />
    </section>
  );
}

/**
 * The goal a ref stands under: a goal ref names itself, a pull request resolves
 * through the ticket that owns it, and anything else — a ticketless PR, a `job:`
 * origin, a ref the world has forgotten — resolves to nothing and draws nothing.
 */
function goalBehind(view: CockpitView, ref: string | null): string | null {
  if (ref === null) return null;
  if (/^issue:\d+/.test(ref)) return ref;
  const pr = /^pr:(\d+)/.exec(ref);
  return pr ? goalOfPr(view.state, Number(pr[1])) : null;
}

/**
 * One row of the feed, flattened off whatever produced it.
 *
 * Flat rather than "a `WorldEvent` and a count" because the card draws two
 * different things now — the world's own transitions, and the environments a
 * goal's work has arrived in — and an arrival is deliberately not a world event
 * ({@link arrivalSignals}). Carrying one as the other would need a `kind` the
 * union does not have, cast into it at the one place the row then prints it.
 */
interface Signal {
  key: string;
  /** What kind of thing happened, as the row prints it. */
  kind: string;
  /** The world object it concerns, for the goal link beside the sentence. */
  ref: string | null;
  summary: string;
  createdAt: string;
  count: number;
}

function groupSignals(events: readonly WorldEvent[]): Signal[] {
  const rows = new Map<string, Signal>();
  for (const event of events) {
    const key = `${event.kind}|${event.ref ?? ''}`;
    const seen = rows.get(key);
    // The newest of its group — the server sends newest first, so it is the first seen.
    if (seen) seen.count += 1;
    else
      rows.set(key, {
        key,
        kind: event.kind,
        ref: event.ref,
        summary: event.summary,
        createdAt: event.createdAt,
        count: 1,
      });
  }
  return [...rows.values()];
}

/**
 * The environment arrivals, as signals — merged into the feed here rather than
 * carried in `worldEvents` from the server.
 *
 * **An arrival is deliberately not a `WorldEvent`.** Those are derived by diffing
 * consecutive world snapshots, and a standing delivery verdict is expired by
 * *any* world event on its issue ref (`deliveryHold`) — so an arrival written as
 * one would lift the delivery park on the very goal it announced and hand the
 * work back to the fleet to do again. Adapting it at the feed's own door costs
 * one function and has no such reader.
 *
 * One row per arrival rather than one per `(kind, ref)`: two environments
 * reaching one goal is two things that happened, and rolling them together would
 * hide the second under a count of the first.
 */
function arrivalSignals(arrivals: readonly GoalArrival[], now: number): Signal[] {
  const cutoff = now - SIGNAL_WINDOW_MS;
  return arrivals
    .filter((a) => Date.parse(a.arrivedAt) >= cutoff)
    .map((a) => ({
      key: `arrival|${a.goalRef}|${a.environment}`,
      kind: 'environment',
      ref: a.goalRef,
      summary: `${refLabel(a.goalRef)} reached ${a.environment}`,
      createdAt: a.arrivedAt,
      count: 1,
    }));
}

/**
 * How far back an arrival stays in the feed. The world events beside it are
 * capped at 100 rows by the server and thin out on their own; arrivals are rare
 * enough that a deployment with four environments would otherwise keep last
 * spring's on the card.
 */
const SIGNAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
