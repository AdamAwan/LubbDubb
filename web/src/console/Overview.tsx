import { useState, type JSX } from 'react';
import type { CockpitView, DeskRun } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, Issue, QueueItem, WorldEvent } from '../types.js';
import { buildGoalPage, buildGoalTrack, goalOfPr, type GoalTrack } from '../view/goalPage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { elapsed, fmtUsd, relTime } from '../components/util.js';
import { Ref, RefText, refLabel } from '../components/refs.js';
import { CiLadder, CourtChip } from './GoalPage.js';

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
      <UpNext view={view} />
      <WorldSignals view={view} />
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
    </section>
  );
}

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
  const { ignoreLabel } = config;

  return (
    <section className="cn-card cn-span2">
      <h3>
        Pull requests <i className="cn-n">{open.length} open</i>
        {merged !== null && <span className="cn-more">{merged} merged</span>}
      </h3>
      <div className="cn-rows">
        {open.length === 0 && <p className="cn-empty">No pull request is open.</p>}
        {open.map((pr) => {
          // The server's verdict, not a second reading of the labels: `ignored` is
          // the first arm `prAttentionStatus` takes, so on an open PR it *is* the
          // tag. Drawn as a spent row for the reason the backlog dims an ignored
          // goal — the chip alone leaves a row the harness will never touch
          // sitting at the same weight as the ones it is working.
          const excluded = pr.attention.status === 'ignored';
          // The goal this PR is delivering, joined the server's own three ways
          // rather than through the plan parts alone: a goal worked whole has no
          // parts at all, which is most finished goals, and the rack drew no goal
          // for any of them.
          const goal = goalOfPr(view.state, pr.number);
          return (
            <div className={`cn-row ${excluded ? 'cn-spent' : ''}`} key={pr.number}>
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
                disabled={ignoreLabel === ''}
                onClick={() => actions.setPrExcluded(pr.number, !excluded)}
                title={
                  ignoreLabel === ''
                    ? 'No ignore label configured — the watch/ignore gate is off'
                    : excluded
                      ? `Remove the "${ignoreLabel}" tag and let the harness work this PR again`
                      : `Tag this PR "${ignoreLabel}" so the harness leaves it alone`
                }
              >
                {excluded ? 'watch' : 'ignore'}
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
function UpNext({ view }: { view: CockpitView }): JSX.Element {
  const items = view.state.upcoming?.items ?? [];
  return (
    <section className="cn-card">
      <h3>
        Up next <i className="cn-n">{items.length} queued</i>
      </h3>
      <div className="cn-rows">
        {items.length === 0 && <p className="cn-empty">Nothing is queued.</p>}
        {items.map((item) => (
          <QueueRow key={`${item.origin}|${item.rule}`} item={item} />
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
function QueueRow({ item }: { item: QueueItem }): JSX.Element {
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
  const rows = groupSignals(view.state.worldEvents).slice(0, 10);
  return (
    <section className="cn-card">
      <h3>
        World signals <i className="cn-n">{rows.length}</i>
      </h3>
      <div className="cn-rows">
        {rows.length === 0 && <p className="cn-empty">The world has not moved.</p>}
        {rows.map(({ key, event, count }) => (
          <div className="cn-row" key={key}>
            <span className="cn-grow">
              <b className="cn-name">
                <RefText text={event.summary} />
              </b>
              <span className="cn-sub">
                {event.kind} · {relTime(event.createdAt, view.now)}
              </span>
            </span>
            {/* The goal behind the signal, beside the sentence rather than inside
                it. The summary's own `#412` already links out to the provider, so
                repeating the pull request here would be one ref twice — what a
                signal never offers is the way onto the goal page. */}
            <span className="cn-refs">
              <Ref to={goalBehind(view, event.ref)} />
            </span>
            {count > 1 && <span className="cn-num">×{count}</span>}
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

interface Signal {
  key: string;
  /** The newest event of its group — the server sends newest first, so it is the first seen. */
  event: WorldEvent;
  count: number;
}

function groupSignals(events: readonly WorldEvent[]): Signal[] {
  const rows = new Map<string, Signal>();
  for (const event of events) {
    const key = `${event.kind}|${event.ref ?? ''}`;
    const seen = rows.get(key);
    if (seen) seen.count += 1;
    else rows.set(key, { key, event, count: 1 });
  }
  return [...rows.values()];
}
