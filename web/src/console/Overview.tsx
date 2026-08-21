import { useState, type JSX } from 'react';
import type { CockpitView, DeskRun } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, GoalArrival, Issue, QueueItem, SupplyState, WorldEvent } from '../types.js';
import { buildGoalPage, buildGoalTrack, furthestEnvironment, goalOfPr, type GoalTrack } from '../view/goalPage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { elapsed, fmtUsd, relTime } from '../components/util.js';
import { Ref, RefText, refLabel } from '../components/refs.js';
import { CiLadder, CourtChip } from './GoalPage.js';
import { ProfilePicker } from '../components/ProfilePicker.js';
import { productionReading } from '../view/production.js';

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
      <Fleet view={view} actions={actions} />
      <GoalsInFlight view={view} actions={actions} />
      <Rack view={view} actions={actions} />
      <UpNext view={view} actions={actions} />
      <Rate view={view} actions={actions} />
      <WorldSignals view={view} />
    </div>
  );
}

/**
 * Is the floor producing, or merely busy?
 *
 * The one reading in the cockpit that is against **time**, and the only way to
 * tell a fleet that is working from one that is spinning. It was the Output
 * panel; the half of it that was about money is the Insights page's headline
 * ratio now, and what is left is the half that belongs on the overview — rates
 * over the last six hours, which is a *now* question rather than an analytical
 * one.
 *
 * It stays a **fixed six hours** while everything on Insights obeys a control,
 * and deliberately: this card answers "what is happening", and a window an
 * operator has to set before the answer means anything is not that question. It
 * says the span out loud for the same reason.
 *
 * **The churn ratio is the point.** Dispatches are effort and merges are output,
 * so a rising first figure over a flat second one is a fleet going round. The
 * truncation note is not decoration either: a rate that silently under-reports
 * is worse than no rate.
 */
function Rate({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const reading = productionReading({
    decisions: view.state.decisions,
    worldEvents: view.state.worldEvents,
    fiveHourCostUsd: view.state.usage.windows.fiveHourCostUsd,
    now: view.now,
  });
  const hours = Math.round(reading.windowMs / 3_600_000);
  return (
    <section className="cn-card">
      <h3>
        Rate <i className="cn-n">last {hours}h</i>
        {/* The way on to the money behind these rates. A card that names a
            reading and offers no way to it is the cockpit's most repeated dead
            end. */}
        <button type="button" className="cn-tgl" onClick={() => actions.openInsights({})}>
          Insights
        </button>
      </h3>
      <div className="cn-rows">
        {reading.series.map((s) => (
          <div className="cn-row" key={s.key}>
            <span className="cn-grow">
              <b className="cn-name">{s.label}</b>
              {/* The first half being empty is not a 0% change — there is nothing
                  to have changed from, and an arrow there would be invented. */}
              <span className="cn-sub">
                {s.deltaPct === null
                  ? 'nothing in the first half to compare against'
                  : `${s.deltaPct > 0 ? '+' : ''}${s.deltaPct}% against the first half`}
              </span>
            </span>
            <span className="cn-num">{s.perHour.toFixed(1)}/h</span>
          </div>
        ))}
      </div>
      <p className="cn-empty">
        {reading.churnRatio === null
          ? `Nothing has merged in ${hours}h — every dispatch so far is effort without output.`
          : `${reading.churnRatio.toFixed(1)} dispatches per merge — the number that separates producing from churning.`}
      </p>
      {reading.truncated && (
        <p className="cn-empty">
          The decision log does not reach back {hours}h, so the dispatch and escalation rates are a floor.
        </p>
      )}
    </section>
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
      <div className="cn-rows">
        {view.live.length === 0 && desk.length === 0 && <p className="cn-empty">Nobody is out.</p>}
        {view.live.map((agent) => (
          <AgentRow key={agent.id} agent={agent} view={view} actions={actions} />
        ))}
        {/* Below the dispatched agents, because that is the order the harness
            answers "what is happening" in: what it sent out, then what it did
            not send. */}
        {desk.map((run) => (
          <DeskRow key={`${run.originRef}|${run.checkId}`} run={run} view={view} />
        ))}
        {showEnded &&
          (ended.length === 0 ? (
            <p className="cn-empty">No shift has ended.</p>
          ) : (
            ended.map((agent) => <AgentRow key={agent.id} agent={agent} view={view} actions={actions} />)
          ))}
      </div>
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
function AgentRow({ agent, view, actions }: { agent: Agent; view: CockpitView; actions: CockpitActions }): JSX.Element {
  const task = view.taskFor(agent);
  const origin = task?.originRef ?? null;
  const done = agent.endedAt !== null;
  const limited = view.limitParked.has(agent.id);
  const lamp = view.escalationByAgent.has(agent.id)
    ? 'cn-ask'
    : done
      ? 'cn-off'
      : agent.status === 'waiting'
        ? 'cn-wait'
        : 'cn-run';
  return (
    <div className={`cn-row ${done ? 'cn-spent' : ''}`}>
      <i className={`cn-lamp ${lamp}`} />
      <button
        type="button"
        className="cn-grow"
        onClick={() => actions.select(agent.id)}
        title="Open this agent's drawer"
      >
        <b className="cn-name">{task?.title ?? agent.id}</b>
        <span className="cn-sub">
          {/* A limit park says so on the row itself. The note underneath is whatever
              the agent last said it was doing, which on a parked row reads as though
              it still is. */}
          {limited ? 'Out of account limit' : (agent.note ?? agent.status)} ·{' '}
          {elapsed(agent.startedAt, agent.endedAt, view.now)}
        </span>
      </button>
      <OnWhat origin={origin} view={view} />
      {/* The way out of the park, where the park is shown — beside the name rather
          than inside it, since the row's own click opens the transcript. */}
      {limited && (
        <AsyncButton
          className="cn-btn"
          onClick={() => actions.resumeAgent(agent.id)}
          title={agent.waitingReason ?? 'Resume this agent now the limit has cleared'}
          pendingLabel="Resuming…"
        >
          Resume
        </AsyncButton>
      )}
      {agent.costUsd !== null && <span className="cn-num">{fmtUsd(agent.costUsd)}</span>}
    </div>
  );
}

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
    <span className="cn-refs">
      {origin !== null && <Ref to={origin} label={pr ? `PR ${refLabel(origin)}` : refLabel(origin)} />}
      {goal !== null && <Ref to={goal} />}
    </span>
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
function DeskRow({ run, view }: { run: DeskRun; view: CockpitView }): JSX.Element {
  return (
    <div
      className="cn-row cn-desk"
      title={
        `${run.label} is running check ${run.letter} of ${refLabel(run.originRef)} — claimed ${relTime(run.claimedAt, view.now)}. ` +
        'Nobody dispatched it: it takes no fleet slot, and it ends when the reading lands, ' +
        'when the session closes, or when the claim ages out.'
      }
    >
      <i className="cn-lamp cn-desk-lamp" />
      <span className="cn-grow">
        <b className="cn-name">{run.title}</b>
        <span className="cn-sub">
          check {run.letter} · {run.label} · {elapsed(run.claimedAt, null, view.now)}
        </span>
      </span>
      <span className="cn-refs">
        <Ref to={run.originRef} />
      </span>
      <i className="cn-chip cn-desk-chip">at a keyboard</i>
    </div>
  );
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
 * The court chip is read off `needsYou`, the rail's own queue: a goal is in your
 * court exactly when the rail is holding an ask about it. Anything else would let
 * a chip say "you" with nothing to answer, or the rail hold a row the overview
 * marks as the harness's business.
 */
function GoalsInFlight({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goals = view.state.world.issues.filter((issue) => IN_FLIGHT.has(issue.pickup.status));

  return (
    <section className="cn-card cn-span2">
      <h3>
        Goals in flight <i className="cn-n">{goals.length}</i>
      </h3>
      <div className="cn-rows">
        {goals.length === 0 && <p className="cn-empty">No goal is in flight.</p>}
        {goals.map((issue) => (
          <GoalRow key={issue.number} issue={issue} view={view} actions={actions} />
        ))}
      </div>
    </section>
  );
}

function GoalRow({ issue, view, actions }: { issue: Issue; view: CockpitView; actions: CockpitActions }): JSX.Element {
  const ref = `issue:${issue.number}`;
  const page = buildGoalPage(view.state, ref, view.needsYou);
  const track = page === null ? null : buildGoalTrack(page.parts);
  const asks = view.needsYou.filter((n) => n.goalRef === ref).length;
  const furthest = furthestEnvironment(view.state, ref);

  return (
    <button type="button" className="cn-row cn-goal-row" onClick={() => actions.selectGoal(ref)}>
      <span className="cn-grow">
        <b className="cn-name">
          #{issue.number} {issue.title}
        </b>
        <span className="cn-sub">
          {track !== null && track.total > 0 && `${track.total} parts · ${track.merged} merged · `}
          {issue.pickup.status}
          {asks > 0 && ` · ${asks} asking you`}
        </span>
      </span>
      {track !== null && <Track track={track} />}
      {/* Where the work actually got to, on the row rather than a page deeper.
          Only ever drawn for an environment holding the goal *whole* — `partial`
          has no furthest anything, and a chip claiming one would be the boolean
          rollup the reach fold exists to refuse. */}
      {furthest !== null && <i className="cn-chip cn-ok">{furthest}</i>}
      <i className={`cn-chip ${asks > 0 ? 'cn-you' : 'cn-harness'}`}>{asks > 0 ? 'You' : 'Harness'}</i>
    </button>
  );
}

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
    <span className="cn-track">
      {segs.map((tone, i) => (
        <i className={`cn-seg ${tone}`} key={i} />
      ))}
    </span>
  );
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
      <div className="cn-rows">
        {open.length === 0 && <p className="cn-empty">No pull request is open.</p>}
        {open.map((pr) => {
          // The server's verdict, not a second reading of the labels: `unwatched`
          // is the first arm `prAttentionStatus` takes, so on an open PR it *is* the
          // absent tag. Drawn as a spent row for the reason the backlog dims an
          // unwatched goal — the chip alone leaves a row the harness will never
          // touch sitting at the same weight as the ones it is working.
          const unwatched = pr.attention.status === 'unwatched';
          // The goal this PR is delivering, joined the server's own three ways
          // rather than through the plan parts alone: a goal worked whole has no
          // parts at all, which is most finished goals, and the rack drew no goal
          // for any of them.
          const goal = goalOfPr(view.state, pr.number);
          return (
            <div className={`cn-row ${unwatched ? 'cn-spent' : ''}`} key={pr.number}>
              <span className="cn-grow">
                <b className="cn-name">
                  <Ref to={`pr:${pr.number}`} /> {pr.title}
                </b>
                <span className="cn-sub">{pr.branch}</span>
              </span>
              <span className="cn-refs">
                {goal !== null && (
                  <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />
                )}
              </span>
              <CiLadder pr={pr} />
              <CourtChip pr={pr} now={view.now} />
              <AsyncButton
                className="ghost"
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
                {unwatched ? 'watch' : 'unwatch'}
              </AsyncButton>
            </div>
          );
        })}
      </div>
    </section>
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
      <div className="cn-rows">
        {items.length === 0 && <p className="cn-empty">Nothing is queued.</p>}
        {items.map((item) => (
          <QueueRow key={`${item.origin}|${item.rule}`} item={item} view={view} actions={actions} />
        ))}
      </div>
    </section>
  );
}

/**
 * A queued dispatch, as a way to what it is queued against — the origin is a goal
 * ref as often as a pull request, so it goes through `Ref` rather than out to the
 * provider unconditionally, and the reason it quotes carries `#n` mentions of its
 * own.
 */
function QueueRow({
  item,
  view,
  actions,
}: {
  item: QueueItem;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const config = view.state.config;
  return (
    <div className="cn-row">
      <span className="cn-grow">
        <b className="cn-name">
          <Ref to={item.origin} /> {item.title}
          {/* Why this row is where it is. Without it a flagged goal's parts sit at
              the top of the panel with their own rule's reason underneath and
              nothing anywhere connecting the order to the click that caused it. */}
          {item.expedited === true && (
            <i className="cn-chip" title="Its goal is marked a priority, so everything under it is ranked first">
              priority
            </i>
          )}
        </b>
        <span className={`cn-sub cn-wrap ${item.status === 'dispatching' ? '' : 'cn-held'}`}>
          <RefText text={item.reason} />
        </span>
      </span>
      {/* What this row will run on, and the one place it can be changed before it
          runs. The queue is where the judgement is available — an operator
          reading "resolve the conflict on issue/390/watcher" knows it is
          mechanical work, and the row is in front of them; the goal's ticket is
          two clicks away and says nothing about which of its origins is the cheap
          one. The empty option names what the row resolves to without an
          override, so the panel answers "which profile" whether or not anyone has
          touched it. */}
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
    </div>
  );
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
      <div className="cn-rows">
        {rows.length === 0 && <p className="cn-empty">The world has not moved.</p>}
        {rows.map((row) => (
          <div className="cn-row" key={row.key}>
            <span className="cn-grow">
              <b className="cn-name">
                <RefText text={row.summary} />
              </b>
              <span className="cn-sub">
                {row.kind} · {relTime(row.createdAt, view.now)}
              </span>
            </span>
            {/* The goal behind the signal, beside the sentence rather than inside
                it. The summary's own `#412` already links out to the provider, so
                repeating the pull request here would be one ref twice — what a
                signal never offers is the way onto the goal page. */}
            <span className="cn-refs">
              <Ref to={goalBehind(view, row.ref)} />
            </span>
            {row.count > 1 && <span className="cn-num">×{row.count}</span>}
          </div>
        ))}
      </div>
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
