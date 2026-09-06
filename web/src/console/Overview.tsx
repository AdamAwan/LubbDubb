import { useState, type JSX } from 'react';
import type { CockpitView, DeskRun } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, Issue, OpenPullRequest, QueueItem, ReadyingAction, ReadyingStep, SupplyState } from '../types.js';
import {
  buildGoalPage,
  buildGoalTrack,
  furthestEnvironment,
  goalOfPr,
  standsFor,
  type GoalTrack,
} from '../view/goalPage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { elapsed, fmtUsd, relTime } from '../components/util.js';
import { Ref, refLabel } from '../components/refs.js';
import { StaleChip, waitedFor } from './GoalPage.js';
import { ProfilePicker } from '../components/ProfilePicker.js';
import { GroupHead, PanelRows, type PanelRowModel, type RowGroup } from './PanelRow.js';
import { Who } from '../components/who.js';
import { AgentOnIt } from '../components/AgentOnIt.js';
import { CiMark, CiSlot } from '../components/CiMark.js';
import { CommentsMark } from '../components/CommentsMark.js';
import { PackMark } from '../components/PackMark.js';
import { ReviewMark } from '../components/ReviewMark.js';
import { orphanCount, orphanGoal } from '../view/orphanGoal.js';
import { Tag } from '../components/tag.js';

/**
 * What is shown when no goal is selected: three cards, rows rather than pictures —
 * Fleet, Goals in flight, Pull requests, in DOM/reading order.
 *
 * Up next, World signals, Environments, Build and Project are not separate cards
 * any more: Up next is a band on Fleet, and the rest moved to the bar/panels
 * (`WorldSignals`, `TopBar`'s `Environments`, `BuildPanel`).
 *
 * Two rules run through all three cards: nothing here re-decides what the server
 * decided (a PR's court is `attention.status`, its checks are `ciVerdict`, a
 * queued item's hold is the queue's own sentence, a goal's state is `pickup.status`
 * — every one quoted, none parsed), and an empty card still draws, muted.
 */
export function Overview({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  return (
    <div className="cn-grid">
      <Fleet view={view} actions={actions} />
      <GoalsInFlight view={view} actions={actions} />
      <Rack view={view} actions={actions} />
    </div>
  );
}

/**
 * Who is out, what they are on, and what it has cost so far.
 *
 * The lamp reads red on an agent `escalationByAgent` names, which is stronger
 * than `status === 'waiting'`; the two disagree when an agent is parked with
 * nothing asked of the operator, and the ask wins.
 *
 * Ended shifts are behind a disclosure rather than a second card, counted at
 * zero, muted, so the way in does not move.
 *
 * **The queue is a band on this card**, one dispatch stage behind the readying
 * rows, so "what is out, and what is behind it" reads as one card rather than
 * two that never agreed on what counted as work.
 *
 * **Nothing folds.** The card's rows are a budget the two bands share
 * ({@link FLEET_ROWS}); the queue shows what the agents left of it and the rest
 * is on the `upnext` panel.
 *
 * → docs/spec/17-cockpit.md#the-queue-rides-the-fleet-card
 */
/**
 * How many rows the Fleet card draws, across both of its bands.
 *
 * A **budget**, not a pair of caps: agents spend it first (bounded by the fleet
 * cap), and the queue takes what is left, so the card is the same height
 * whatever the fleet is doing. At a full fleet the queue draws no rows but keeps
 * its band — nothing is queued *next* when nothing is free.
 */
const FLEET_ROWS = 7;

function Fleet({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [showEnded, setShowEnded] = useState(false);
  const ended = view.past;
  const desk = view.deskRuns;
  const readying = view.readying;
  // The queue as it stands now: a candidate this pulse dispatched is in both
  // `state.upcoming` as `dispatching` and in `live` as an agent until the next
  // pulse recomputes the plan. → `CockpitView.upNext`
  const queued = view.upNext;
  // `unapproved` is the queue status that is the operator's move.
  const asking = queued.filter((item) => item.status === 'unapproved').length;
  // The fleet's own count, not the list's: the snapshot's `ended` tail is bounded.
  const endedTotal = view.state.endedAgents;

  const out = [
    ...view.live.map((agent) => agentRow(agent, view, actions)),
    ...readying.map((action) => readyingRow(action, view)),
    ...desk.map((run) => deskRow(run, view)),
    ...(showEnded ? ended.map((agent) => agentRow(agent, view, actions)) : []),
  ];
  // Ended shifts don't count against the budget — they're an explicit expansion
  // that scrolls the card rather than pushing the queue out of it.
  const room = Math.max(0, FLEET_ROWS - (view.live.length + readying.length + desk.length));
  const queueRows = queued.slice(0, room).map((item) => queueRow(item, view, actions));
  // One rail across both calls so the card's columns line up. → `PanelRows`
  const rail = [...out, ...queueRows];

  return (
    <section className="cn-card cn-span2">
      <h3>
        Fleet{' '}
        <i className="cn-n">
          {view.live.length} out
          {/* Beside the count, not folded in: nobody has dispatched these yet and
              they take no slot, so "out" would be the wrong word. */}
          {readying.length > 0 && ` · ${readying.length} being readied`}
          {desk.length > 0 && ` · ${desk.length} at a keyboard`}
        </i>
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
      {view.live.length === 0 && desk.length === 0 && readying.length === 0 && (
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
      {/* The head of the queue, in the same list as the agents — nothing folded,
          nothing moves when opened. Always draws, even empty. */}
      <GroupHead
        group={{
          key: 'upnext',
          label: 'Up next',
          // Pinned to the card's foot — floated up, a quiet fleet would draw the
          // queue halfway up the card with empty panel underneath.
          foot: true,
          // The queue's full size beside its shown rows, and how much is on a
          // person (`unapproved`).
          note: (
            <>
              {queued.length === 0 ? 'nothing queued' : `${queued.length} queued`}
              {asking > 0 && <span className="cn-alarm"> · {asking} on you</span>}
            </>
          ),
          control: (
            <>
              {queued.length > queueRows.length && (
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
      {queueRows.length > 0 && <PanelRows rows={queueRows} rail={rail} />}
      {queued.length === 0 && <p className="cn-empty">Nothing is queued.</p>}
      <RunwayBand view={view} />
    </section>
  );
}

/**
 * What is behind the agents above — the fleet's runway, at the foot of the card.
 *
 * Nothing here re-decides what the server decided: state, wording and every
 * count are quoted from `state.runway`. No control is drawn — the band is a
 * statement, not a shortcut. Always draws, muted when healthy.
 */
function RunwayBand({ view }: { view: CockpitView }): JSX.Element {
  const r = view.state.runway;
  // Paused is not idleness — the fleet is stopped because somebody stopped it.
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

/**
 * The reading itself; with nothing queued there is no duration to state, so it
 * counts idle slots instead. The duration is **fleet time**: hours a person was
 * the next mover are excluded from the median it is built from
 * ([25](../../../docs/spec/25-supply.md#the-lead-time-is-fleet-time)). See
 * {@link runwayTitle} for the fuller account.
 */
function runwayReading(r: CockpitView['state']['runway']): string {
  if (r.runwayMinutes !== null) return fmtRunway(r.runwayMinutes);
  if (r.state === 'unknown') return '—';
  return `${r.idleSlots} idle`;
}

/**
 * What the one-line reading leaves out, on hover: which quantity it is, and the
 * calendar span it came from. Composed from quoted figures only.
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
 * Total over {@link SupplyState} — a state added to the lens fails the typecheck
 * here rather than drawing incorrectly. `unknown` is grey deliberately: absence
 * of a reading, not a mild warning.
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
 * The name is the button; the refs sit beside it (a link inside a button would be
 * a second destination for one click). Two refs, not one: the origin (what was
 * dispatched at) plus the goal resolved separately through {@link goalOfPr},
 * drawn whenever it differs from the origin. A ticketless pull request draws no
 * goal.
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
    refs: <OnWhat origin={origin} view={view} />,
    facts: [
      // A limit park says so in place of the note, which otherwise reads as
      // though the agent were still doing what it last said.
      { label: 'doing', value: limited ? 'Out of account limit' : (agent.note ?? agent.status), alarm: limited },
      { label: 'for', value: elapsed(agent.startedAt, agent.endedAt, view.now) },
      ...(agent.costUsd !== null ? [{ label: 'cost', value: fmtUsd(agent.costUsd) }] : []),
    ],
    ...agentState(agent, view),
    // The way out of the park, beside the name rather than inside it — the row's
    // own click opens the transcript.
    action: limited ? (
      <AsyncButton
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
 * Why a fleet row is not moving, as one word and the sentence behind it. The four
 * states — escalation, limit park, stall park, plain wait — are ranked rather
 * than merged: an escalation wins even when also parked, since a row wears only
 * one word. A running agent wears none.
 */
function agentState(agent: Agent, view: CockpitView): Pick<PanelRowModel, 'why' | 'whyLabel' | 'whyTone'> {
  const escalation = view.escalationByAgent.get(agent.id);
  if (escalation !== undefined) {
    // The ask itself, verbatim — the rail carries the same sentence.
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
  // `done` is the ordinary ending and wears nothing — the list already says so.
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
 * What a dispatch was aimed at: the origin itself, what a `job:<id>` origin
 * stands in for, and the goal behind whichever of those is a pull request some
 * ticket owns. A dispatch with no origin still draws the (empty) `cn-refs` slot
 * so the list stays columned.
 */
function OnWhat({ origin, view }: { origin: string | null; view: CockpitView }): JSX.Element {
  // A `job:<id>` origin is opaque on its own — what it stands in for is drawn
  // beside it. See {@link standsFor}. Every other origin comes back unchanged.
  const stood = standsFor(view.state, origin);
  const pr = stood === null ? null : /^pr:(\d+)/.exec(stood);
  const goal = pr ? goalOfPr(view.state, Number(pr[1])) : null;
  return (
    <>
      {origin !== null && <Ref to={origin} />}
      {/* Position says the relation, not a word between them — each ref's own
          hover carries the sentence. */}
      {stood !== null && stood !== origin && (
        <Ref to={stood} title={`Open the work this job is standing in for — ${refLabel(stood)}`} />
      )}
      {goal !== null && goal !== stood && (
        <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />
      )}
    </>
  );
}

/**
 * What each step of the readying is called on the row, using the spec's own
 * words (`docs/spec/09-execution.md`). Totalled over {@link ReadyingStep}, so a
 * step added to the executor fails the typecheck rather than drawing empty.
 */
const READYING_STEP: Record<ReadyingStep, string> = {
  'picked-up': 'picked up',
  'ci-evidence': 'reading CI output',
  'slot-handover': 'handing a slot over',
  authorizing: 'authorizing',
};

/** The longer half — what the step is waiting on, and why it takes what it takes. */
const READYING_WHY: Record<ReadyingStep, string> = {
  'picked-up': 'The executor has this action in hand and has not reached anything it has to wait for.',
  'ci-evidence': 'Reading the failing check output out of the provider, so the agent is dispatched holding it.',
  'slot-handover':
    'Waiting on the worktree pool. A slot already on this branch comes back at once; one checked out on ' +
    'another branch is wiped with `git clean -ffdx` and checked out cold first, which on a large repository ' +
    'is minutes.',
  authorizing: 'Asking whether this act is already authorized, which is a read against the tracker.',
};

/**
 * An action the executor is working on, in the window before it is an agent.
 * `ActionExecutor.execute` walks a plan serially and each dispatch waits on the
 * worktree pool before spawning, so without this row a multi-appraisal cycle
 * would show "all dispatched" in the queue while the fleet card showed just one
 * agent — nothing wrong, nothing said so.
 *
 * Borrows {@link deskRow}'s grammar (in flight, not an agent): a `div` not a
 * button (no transcript, nothing to kill), a hollow lamp and dashed edge (no
 * dispatch cut this row yet), no cost column. Own tint, distinct from a desk
 * run's violet. Drawn off a record held for one `await`, released in a `finally`
 * — a failed dispatch takes its row with it.
 */
function readyingRow(action: ReadyingAction, view: CockpitView): PanelRowModel {
  return {
    key: action.id,
    lamp: <i className="cn-lamp cn-readying-lamp" />,
    title: action.title,
    refs: action.originRef === null ? null : <Ref to={action.originRef} />,
    facts: [
      ...(action.branch === null ? [] : [{ label: 'branch', value: action.branch }]),
      { label: 'for', value: elapsed(action.startedAt, null, view.now) },
    ],
    whyLabel: READYING_STEP[action.step],
    whyTone: 'quiet',
    why:
      `${READYING_WHY[action.step]} Nothing has been dispatched for this yet: it holds no fleet slot and ` +
      'has no transcript, and it leaves this list once the agent starts, or the dispatch fails.',
    readying: true,
  };
}

/**
 * A validation check somebody is running at their own keyboard. In flight but
 * not an agent: a `div` not a button (no transcript, nothing to kill), a hollow
 * lamp (the harness isn't running this), no cost column, a dashed edge. Drawn
 * off a claim already passed through `claimIsLive`, so it leaves the list the
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
 * `pickup.status`, the dispatcher's own answer, rather than re-inferred from
 * agents, plans and pull requests.
 */
const IN_FLIGHT = new Set(['active', 'has_pr', 'planning', 'delivered']);

/**
 * Every goal with work in flight, each a way into its own page. The row's track
 * is folded by {@link buildGoalTrack} off the same page the click opens, so a
 * segment can't disagree with the plan drawn underneath. The court is read off
 * `needsYou`, the rail's own queue, and said once as the alarmed `asking you`
 * count.
 */
function GoalsInFlight({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [showKept, setShowKept] = useState(false);
  // A retained run rides this list while there's still work on it, even after its
  // ticket left the tracker's open set — `stale` marks it, the only difference
  // from a live row. One with nothing left in flight is a finished run waiting to
  // be dismissed; those go behind the header's disclosure, counted at zero.
  const retained = view.state.retainedRuns ?? [];
  const working = retained.filter((issue) => retainedWorkInFlight(issue, view));
  const kept = retained.filter((issue) => !retainedWorkInFlight(issue, view));
  const goals = [...view.state.world.issues.filter((issue) => IN_FLIGHT.has(issue.pickup.status)), ...working];
  // Beside the count, not folded in: these goals are in flight *and* missing
  // from the backlog. Zero draws nothing.
  const orphans = orphanCount(view.state, goals);

  return (
    // `cn-lamp-mark`: the agent-on-it chip rides this card's lamp column too.
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
          // Below what's being worked: what's only being held on to.
          ...(showKept ? kept.map((issue) => goalRow(issue, view, actions)) : []),
        ]}
      />
    </section>
  );
}

/**
 * Whether a retained run still has work in flight: an agent is on it, the rail
 * is holding an ask about it, or its plan has unfinished parts (read through the
 * same `buildGoalTrack` fold the row draws its track from). Otherwise the closed
 * ticket is a run to dismiss, not a goal in flight.
 */
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
  // No fetched history: the row's track folds over the plan's parts, off live agents.
  const page = buildGoalPage(view.state, ref, view.needsYou, null);
  const track = page === null ? null : buildGoalTrack(page.parts);
  const asks = view.needsYou.filter((n) => n.goalRef === ref).length;
  const onIt = view.agentOnGoal.get(ref);
  const furthest = furthestEnvironment(view.state, ref);
  const orphan = orphanGoal(view.state, issue);

  return {
    key: String(issue.number),
    title: `#${issue.number} ${issue.title}`,
    // The tint catches the eye during a scan; the chip only reads once it has.
    className: `cn-goal-row ${orphan === null ? '' : 'cn-row-orphan'}`,
    open: () => actions.selectGoal(ref),
    openTitle: `Open goal #${issue.number} — its plan, its pull requests and anything it is asking you`,
    // The row *is* the way to this goal, so no ref beside the title.
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
    // Pickup status *is* the row's state, so it wears the state column, in the
    // operator's words rather than the enum's (`has_pr` is dispatcher-internal).
    whyLabel: PICKUP_WORD[issue.pickup.status] ?? issue.pickup.status,
    whyTone: PICKUP_TONE[issue.pickup.status] ?? 'quiet',
    why: issue.pickup.reasons.join(' '),
    reading: track !== null ? <Track track={track} /> : undefined,
    // Off the dispatch's own origin, not the track: `now` counts `in_review` too,
    // and a pull request sitting open is nobody working.
    live: onIt !== undefined,
    // Lamp slot, matching the pull-request rack's placement for the same mark.
    // The track survives an agent working it, unlike a pull request's checks.
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
 * `IssuePickupStatusKind` in the words the page is written in — `has_pr` etc are
 * dispatcher-internal identifiers otherwise. A status with no entry falls
 * through as itself.
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
 * `hold` is the harness stopped waiting on something (no capacity, no watch
 * label, cooldown); `ask` is parked on a person by design; everything else is
 * quiet — the tone is whether the row wants anything, not how far along it is.
 */
const PICKUP_TONE: Record<string, 'ask' | 'hold' | 'quiet'> = {
  escalated: 'ask',
  unwatched: 'hold',
  blocked: 'hold',
  cooldown: 'hold',
  appraisal: 'hold',
};

/**
 * One segment per part, in the goal page's four groups and tones: green landed,
 * blue moving, red stuck, bare not started. A goal with no plan has no segments.
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
 * What the segments mean, in words, on hover — the bar keeps its shape, the
 * hover carries the key. Only the groups this goal actually has, most advanced
 * first.
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
 * The toggle is **disabled rather than absent** with no ignore label configured
 * — the gate being off is worth seeing. The merged count draws only when the
 * snapshot carries a closed list; absent means the retention window is off,
 * which is not the same claim as none merged.
 */
function Rack({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { config } = view.state;
  const open = view.state.world.pullRequests;
  const closed = view.state.world.closedPullRequests;
  const merged = closed === undefined ? null : closed.filter((pr) => pr.merged).length;
  const { watchLabel } = config;
  // Yours first, then the fleet's — only when there is a yours to put first.
  const yours = open.filter(isYours);
  const theirs = open.filter((pr) => !isYours(pr));
  const grouped = yours.length > 0;
  const ordered = grouped ? [...yours, ...theirs] : open;

  return (
    // `cn-lamp-mark` widens the lamp column (this card puts a chip in it);
    // `cn-read-marks` widens the reading column, which holds three marks.
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
        // Court on the glass, under the title (a clause fits there). → `RowWords`
        words="subline"
        rows={ordered.map((pr) => {
          const row = prRow(pr, view, actions, watchLabel);
          if (!grouped) return row;
          return { ...row, group: band(isYours(pr), yours.length, theirs.length), who: <Who name={whoAsked(pr)} /> };
        })}
      />
    </section>
  );
}

/**
 * A pull request somebody handed you, off the server's verdict rather than the
 * court. `attention.status === 'you'` is the wrong predicate — a pending merge
 * or conflict also puts a PR in your court with no colleague asking.
 * `assignedToYou` is the field the queue rail keys on too, so the two surfaces
 * cannot disagree. → [07](docs/spec/07-pull-requests.md#a-pull-request-a-person-put-on-you)
 */
function isYours(pr: OpenPullRequest): boolean {
  return pr.attention.assignedToYou !== undefined;
}

/**
 * Whose mark the row wears: the person who asked, or nobody. Only drawn on a
 * row that is *yours* — on the fleet's own rows it would be the harness's login
 * repeated on every one.
 */
function whoAsked(pr: OpenPullRequest): string | null {
  const author = pr.author?.trim() ?? '';
  return isYours(pr) && author !== '' ? author : null;
}

/**
 * The two bands, with their counts. The band says **what the operator is being
 * asked for**, not whose the rows are — `attention.assignedToYou` means somebody
 * put the operator on the reviewer list, so "Assigned to review" (obligation)
 * replaces the old "Yours" (a false claim of ownership over fleet-written PRs).
 */
function band(mine: boolean, yours: number, theirs: number): RowGroup {
  return mine
    ? { key: 'yours', label: 'Assigned to review', note: `${yours}`, tone: 'ask' }
    : { key: 'fleet', label: 'The fleet’s', note: `${theirs}` };
}

/**
 * One open pull request: its checks, whose court it is in, and the toggle that
 * takes it off the harness's books.
 */
function prRow(pr: OpenPullRequest, view: CockpitView, actions: CockpitActions, watchLabel: string): PanelRowModel {
  // The server's verdict, not a second reading of the labels: `unwatched` is the
  // first arm `prAttentionStatus` takes. Drawn as a spent row so the harness's
  // untouched rows don't sit at the same weight as the ones it's working.
  const unwatched = pr.attention.status === 'unwatched';
  // Joined the server's own three ways, not through plan parts alone — a goal
  // worked whole has no parts.
  const goal = goalOfPr(view.state, pr.number);
  const onIt = view.agentOnBranch.get(pr.branch);
  return {
    key: String(pr.number),
    title: pr.title,
    // The PR's number lives in the refs slot, not the title, matching every other
    // card. Both ways to the PR are one `<Ref>` token. The goal sits beside it as
    // a second token; the relation is said in its own hover.
    refs: (
      <>
        <Ref to={`pr:${pr.number}`} />
        {goal !== null && <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />}
      </>
    ),
    open: () => actions.selectPr(pr.number),
    openTitle: `Open pull request #${pr.number} — its review threads, its checks and the work on its branch`,
    // Nothing under the title on a PR the harness is leaving alone — the struck
    // eye already says why it isn't moving.
    facts: unwatched ? undefined : prFacts(pr, view.now),
    // Court behind the marker, without the word: four of five rows used to read
    // `unwatched`, already said by the struck eye and spent dimming, drowning the
    // one arm (`you`) that's actually somebody's move. So the state stays in a
    // `?` with the server's sentence behind it; what's on the glass is the marks
    // (eye, checks chip, Yours band).
    why: unwatched ? null : pr.attention.reasons.join(' '),
    // Lamp slot: the one mark saying something is happening *right now*, held
    // open at a fixed x by `PanelRow` once any row fills it. Absent column when
    // no agent is out.
    lamp: onIt === undefined ? undefined : <AgentOnIt agentId={onIt.id} note={onIt.note} actions={actions} />,
    // Checks first (an agent on the branch is about to replace them, so the chip
    // reads a commit being superseded), then review, then comments, then pack —
    // the order the conversation about a diff happens in. All four reserve their
    // box on every row so the rack keeps one shape.
    reading: (
      <>
        {onIt === undefined ? <CiMark pr={pr} reserve onOpen={() => actions.selectPr(pr.number)} /> : <CiSlot />}
        {/* The fleet's own reading of the diff; survives an agent taking the
            chip's place since what was already read doesn't change on a move. */}
        <ReviewMark review={pr.review} now={view.now} reserve onOpen={() => actions.selectPr(pr.number)} />
        {/* Whether anybody is waiting on an answer — a verdict, not a fact like
            an age, so it left the sub-line for its own mark. */}
        <CommentsMark comments={pr.unresolvedComments} reserve onOpen={() => actions.selectPr(pr.number)} />
        {/* Whether there is a pack to read — about a document, not the PR itself. */}
        <PackMark pack={pr.pack} reserve onOpen={() => actions.selectPr(pr.number)} />
      </>
    ),
    // Head of the readings, beside the row's other one-glance answers.
    // → `PanelRowModel.toggle`
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
    live: onIt !== undefined,
  };
}

/**
 * What is true of this pull request that the ladder and the court do not say —
 * each a reason it's not merged yet, drawn only where true. `comments` moved
 * out to {@link CommentsMark}: an unanswered thread is a verdict, not a fact.
 */
function prFacts(pr: OpenPullRequest, now: number): PanelRowModel['facts'] {
  const facts: { label: string; value: string; alarm?: boolean }[] = [];
  // Only the real conflict: `behind` updates itself and would alarm on every PR.
  if (pr.mergeableState === 'dirty') facts.push({ label: 'merge', value: 'conflict', alarm: true });
  const since = pr.attention.reviewWaitingSince;
  if (since !== undefined) facts.push({ label: 'waiting', value: waitedFor(since, now) });
  return facts.length === 0 ? undefined : facts;
}

/**
 * The watch switch, as the state it is in rather than the verb for the other
 * one — `watch`/`unwatch` text contradicted itself until read as an
 * instruction. An open eye means watched; struck means not. The verb survives
 * in the hover.
 */
function Eye({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
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
 * A queued dispatch, as a way to what it is queued against — the origin goes
 * through `Ref` since it's a goal ref as often as a PR. Drawn further back than
 * a readying row: same tint (harness work, not a keyboard), but dotted not
 * dashed, one stage behind. Not a button. The state word keeps its own tone
 * (`unapproved` ask, `capped` hold) rather than the row's colour.
 *
 * Exported for `test/panelRows.test.ts`, since the collapsed-by-default band
 * has no rendered markup to scrape.
 */
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
    // `QueueStatus` *is* the row's state, so it wears the state column.
    whyLabel: item.status,
    // `unapproved` is the one held reason that is your move; the rest are the
    // harness stopped (throttle, per-plan cap, an earlier hold, no headroom).
    whyTone: item.status === 'unapproved' ? 'ask' : held ? 'hold' : 'quiet',
    // The queue's own sentence, verbatim, behind the marker rather than on the glass.
    why: item.reason,
    chips:
      // Why this row is where it is — connects a flagged goal's ranking to its cause.
      item.expedited === true ? (
        <Tag title="Its goal is marked a priority, so everything under it is ranked first">priority</Tag>
      ) : undefined,
    // What this row will run on, changeable here before it runs.
    action: (
      <ProfilePicker
        profiles={config.profiles}
        value={item.override ?? null}
        // Only meaningful while nothing is overridden — with one standing,
        // `item.profile` *is* the override.
        defaultProfile={item.override === undefined ? (item.profile ?? null) : null}
        inheritLabel={item.profileSource === 'pin' && item.override === undefined ? 'Pinned' : 'Auto'}
        onPick={(profile) => void actions.setUpNextProfile(item.origin, profile)}
      />
    ),
  };
}
