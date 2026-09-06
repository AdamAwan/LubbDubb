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

// → docs/spec/17-cockpit.md

export function Overview({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  return (
    <div className="cn-grid">
      <Fleet view={view} actions={actions} />
      <GoalsInFlight view={view} actions={actions} />
      <Rack view={view} actions={actions} />
    </div>
  );
}

const FLEET_ROWS = 7;

function Fleet({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [showEnded, setShowEnded] = useState(false);
  const ended = view.past;
  const desk = view.deskRuns;
  const readying = view.readying;
  const queued = view.upNext;
  const asking = queued.filter((item) => item.status === 'unapproved').length;
  const endedTotal = view.state.endedAgents;

  const out = [
    ...view.live.map((agent) => agentRow(agent, view, actions)),
    ...readying.map((action) => readyingRow(action, view)),
    ...desk.map((run) => deskRow(run, view)),
    ...(showEnded ? ended.map((agent) => agentRow(agent, view, actions)) : []),
  ];
  const room = Math.max(0, FLEET_ROWS - (view.live.length + readying.length + desk.length));
  const queueRows = queued.slice(0, room).map((item) => queueRow(item, view, actions));
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
          foot: true,
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
      { label: 'doing', value: limited ? 'Out of account limit' : (agent.note ?? agent.status), alarm: limited },
      { label: 'for', value: elapsed(agent.startedAt, agent.endedAt, view.now) },
      ...(agent.costUsd !== null ? [{ label: 'cost', value: fmtUsd(agent.costUsd) }] : []),
    ],
    ...agentState(agent, view),
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

function agentState(agent: Agent, view: CockpitView): Pick<PanelRowModel, 'why' | 'whyLabel' | 'whyTone'> {
  const escalation = view.escalationByAgent.get(agent.id);
  if (escalation !== undefined) {
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
  if (ENDED_BADLY[agent.status] !== undefined) {
    return { whyLabel: ENDED_BADLY[agent.status], whyTone: 'quiet', why: agent.waitingReason };
  }
  return {};
}

const ENDED_BADLY: Partial<Record<Agent['status'], string>> = {
  failed: 'failed',
  crashed: 'crashed',
  killed: 'killed',
  interrupted: 'stopped',
};

function OnWhat({ origin, view }: { origin: string | null; view: CockpitView }): JSX.Element {
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

const READYING_STEP: Record<ReadyingStep, string> = {
  'picked-up': 'picked up',
  'ci-evidence': 'reading CI output',
  'slot-handover': 'handing a slot over',
  authorizing: 'authorizing',
};

const READYING_WHY: Record<ReadyingStep, string> = {
  'picked-up': 'The executor has this action in hand and has not reached anything it has to wait for.',
  'ci-evidence': 'Reading the failing check output out of the provider, so the agent is dispatched holding it.',
  'slot-handover':
    'Waiting on the worktree pool. A slot already on this branch comes back at once; one checked out on ' +
    'another branch is wiped with `git clean -ffdx` and checked out cold first, which on a large repository ' +
    'is minutes.',
  authorizing: 'Asking whether this act is already authorized, which is a read against the tracker.',
};

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

const IN_FLIGHT = new Set(['active', 'has_pr', 'planning', 'delivered']);

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

const PICKUP_WORD: Record<string, string> = {
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
  const { config } = view.state;
  const open = view.state.world.pullRequests;
  const closed = view.state.world.closedPullRequests;
  const merged = closed === undefined ? null : closed.filter((pr) => pr.merged).length;
  const { watchLabel } = config;
  const yours = open.filter(isYours);
  const theirs = open.filter((pr) => !isYours(pr));
  const grouped = yours.length > 0;
  const ordered = grouped ? [...yours, ...theirs] : open;

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
          const row = prRow(pr, view, actions, watchLabel);
          if (!grouped) return row;
          return { ...row, group: band(isYours(pr), yours.length, theirs.length), who: <Who name={whoAsked(pr)} /> };
        })}
      />
    </section>
  );
}

function isYours(pr: OpenPullRequest): boolean {
  return pr.attention.assignedToYou !== undefined;
}

function whoAsked(pr: OpenPullRequest): string | null {
  const author = pr.author?.trim() ?? '';
  return isYours(pr) && author !== '' ? author : null;
}

function band(mine: boolean, yours: number, theirs: number): RowGroup {
  return mine
    ? { key: 'yours', label: 'Assigned to review', note: `${yours}`, tone: 'ask' }
    : { key: 'fleet', label: 'The fleet’s', note: `${theirs}` };
}

function prRow(pr: OpenPullRequest, view: CockpitView, actions: CockpitActions, watchLabel: string): PanelRowModel {
  const unwatched = pr.attention.status === 'unwatched';
  const goal = goalOfPr(view.state, pr.number);
  const onIt = view.agentOnBranch.get(pr.branch);
  return {
    key: String(pr.number),
    title: pr.title,
    refs: (
      <>
        <Ref to={`pr:${pr.number}`} />
        {goal !== null && <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />}
      </>
    ),
    open: () => actions.selectPr(pr.number),
    openTitle: `Open pull request #${pr.number} — its review threads, its checks and the work on its branch`,
    facts: unwatched ? undefined : prFacts(pr, view.now),
    why: unwatched ? null : pr.attention.reasons.join(' '),
    lamp: onIt === undefined ? undefined : <AgentOnIt agentId={onIt.id} note={onIt.note} actions={actions} />,
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

function prFacts(pr: OpenPullRequest, now: number): PanelRowModel['facts'] {
  const facts: { label: string; value: string; alarm?: boolean }[] = [];
  if (pr.mergeableState === 'dirty') facts.push({ label: 'merge', value: 'conflict', alarm: true });
  const since = pr.attention.reviewWaitingSince;
  if (since !== undefined) facts.push({ label: 'waiting', value: waitedFor(since, now) });
  return facts.length === 0 ? undefined : facts;
}

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
