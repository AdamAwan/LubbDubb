import { useState, type JSX } from 'react';
import type { CockpitView, DeskRun } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type {
  Agent,
  EnvironmentHealthReading,
  GoalArrival,
  Issue,
  OpenPullRequest,
  QueueItem,
  ReadyingAction,
  ReadyingStep,
  SupplyState,
  WorldEvent,
} from '../types.js';
import { buildGoalPage, buildGoalTrack, furthestEnvironment, goalOfPr, type GoalTrack } from '../view/goalPage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Icon } from '../components/icons.js';
import { elapsed, fmtUsd, relTime } from '../components/util.js';
import { Ref, RefText, refLabel } from '../components/refs.js';
import { CiLadder, StaleChip, waitedFor } from './GoalPage.js';
import { ProfilePicker } from '../components/ProfilePicker.js';
import { PanelRows, type PanelRowModel, type RowGroup } from './PanelRow.js';
import { Who } from '../components/who.js';
import { AgentOnIt } from '../components/AgentOnIt.js';
import { ReviewMark } from '../components/ReviewMark.js';
import { orphanCount, orphanGoal } from '../view/orphanGoal.js';

/**
 * What is shown when no goal is selected: eight cards, rows rather than pictures.
 *
 * Document order is reading order — Fleet, Goals in flight, Pull requests, Up
 * next, World signals, Environments, Build, Project — and no card carries a CSS
 * `order`, so the DOM and the page agree at every width. The arrangement across
 * tracks is `.cn-grid`'s business alone.
 *
 * The last two are a pair and are last because neither is about the fleet's
 * work: everything above them is what the fleet did, Build is the process the
 * fleet runs inside, and Project is the repository it is pointed at — two
 * different checkouts, read on one timer.
 *
 * Two rules run through all eight. **Nothing here re-decides what the server
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
      <WorldSignals view={view} />
      <Environments view={view} />
      <Build view={view} actions={actions} />
      <Project view={view} actions={actions} />
    </div>
  );
}

/**
 * The harness's own build: what is waiting for it, who wrote it, and how to take
 * it.
 *
 * **The only card here that is not about the fleet's work**, which is why it is
 * last and why it is a card at all. Being behind is a *standing condition* — true
 * continuously, for weeks if nobody looks — and the rail is for asks that settle
 * when they are answered. A row that cannot be discharged is the furniture that
 * teaches an operator to skim the whole queue, so the standing lives on a surface
 * you visit and the rail keeps only the states where a decision is actually
 * pending. → docs/spec/21-self-update.md
 *
 * The changelog is the whole reason this beats the gauge it replaces: "10 behind"
 * answers how far, and never why you would want it. The commits arrive with the
 * reading at no extra cost ({@link BuildStanding.commits}) and are capped at ten
 * there, so the card says when it is showing a window rather than the history —
 * a cap that does not admit to being one reads as the whole truth on exactly the
 * deployment furthest behind.
 *
 * Empty still draws, muted, like every other card: a build that is current is a
 * line saying so, not an absence.
 */
function Build({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const build = view.state.build;
  const standing = build.standing;
  const commits = standing.commits.slice(0, CHANGELOG_ROWS);
  const shown = commits.length;
  const waiting = build.intent.state === 'draining' || build.intent.state === 'ready';
  return (
    <section className="cn-card cn-span2">
      <h3>
        Build <i className="cn-n">{standing.behind === 0 ? 'current' : `${standing.behind} behind`}</i>
        <CheckNow actions={actions} />
        {/* When the reading was taken, in the header's own right-hand slot — the
            same place Fleet keeps its ended-shift count. Every number on these two
            cards is "as of" this one, and a card carrying a stale answer without
            saying how stale is the gauge's old failure with more words. */}
        <i className="cn-more">{checkedStamp(standing, view.now)}</i>
      </h3>
      <p className="cn-empty">{buildLine(build)}</p>
      {shown > 0 && <PanelRows rows={commits.map((commit) => commitRow(commit, view.now))} />}
      {standing.behind > shown && (
        <p className="cn-empty">…and {standing.behind - shown} more, listed on the build panel.</p>
      )}
      {/* Why there are no buttons, whenever there is something to take and it
          cannot be. The panel words every refusal in full; this is the one line
          that stops the card reading as a changelog nobody can act on — and since
          one of the refusals is now the *project* checkout being dirty, the reason
          is not even on this card's own subject. */}
      {standing.behind > 0 && !build.upgradable && build.blocked !== null && (
        <p className="cn-empty">{build.blocked}</p>
      )}
      {/* The refusals — a dirty install, a build ahead of its upstream, a reading
          nobody could take — are the *panel's* to word: they are the answer to
          "why is the button off", and the button is not here to be off. This card
          draws controls when there is something to take and none when there is
          not. */}
      {build.upgradable && (
        <div className="cn-acts">
          {/* The controls follow the *intent*, not the standing: a drain already
              in progress is cancelled or applied, and offering to queue a second
              one is a button whose own state says it has nothing to do. */}
          {waiting ? (
            <>
              <AsyncButton className="cn-btn cn-primary" onClick={() => actions.upgrade('apply')}>
                Apply now
              </AsyncButton>
              <AsyncButton className="cn-btn" onClick={() => actions.upgrade('cancel')}>
                Cancel
              </AsyncButton>
            </>
          ) : (
            <AsyncButton className="cn-btn cn-primary" onClick={() => actions.upgrade('drain')}>
              Queue upgrade
            </AsyncButton>
          )}
          {/* Last, and **secondary**: interrupting is not lossy — every agent is
              reaped, recorded and restored on the way back up — so the danger tone
              put an alarm colour on an ordinary decision, beside the safe path it
              is only a variant of. Weight separates the two here, never hue. */}
          <AsyncButton className="cn-btn" onClick={() => actions.upgrade('apply', { interrupt: true })}>
            Force upgrade
          </AsyncButton>
        </div>
      )}
    </section>
  );
}

/**
 * The **worked** repository: what has landed on the branch the fleet integrates
 * onto that this clone has not got, and whether the checkout is clean.
 *
 * Beside Build and read on the same timer by the same reader, because they are
 * two answers to one question an operator asks once. What makes it worth its own
 * card rather than a second line on Build's is that the two are different
 * repositories — `repoRoot` and the install directory coincide only when the
 * harness is dogfooding itself ([21](../../../docs/spec/21-self-update.md)).
 *
 * It answers the one thing the six cards above it cannot: **what changed in the
 * project that the fleet did not do.** Every other card on this page is the
 * fleet's own work — its goals, its pull requests, its landings. A colleague's
 * hotfix landing on `main` appears on none of them.
 *
 * **The git status is on the glass, not behind a marker**, because it is not
 * merely informative here: an upgrade is refused over uncommitted changes in
 * *either* checkout, so this line is half of the answer to why the Build card
 * beside it has no buttons.
 *
 * No controls. There is nothing the cockpit should do to the operator's own
 * checkout, and a card that only reports is the honest shape for one.
 */
function Project({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const standing = view.state.build.project;
  const commits = standing?.commits.slice(0, CHANGELOG_ROWS) ?? [];
  return (
    <section className="cn-card cn-span2">
      <h3>
        Project <i className="cn-n">{projectCount(standing)}</i>
        <CheckNow actions={actions} />
        <i className="cn-more">{checkedStamp(standing, view.now)}</i>
      </h3>
      <p className="cn-empty">{projectLine(view, standing)}</p>
      {commits.length > 0 && <PanelRows rows={commits.map((commit) => commitRow(commit, view.now))} />}
      {standing !== null && standing.behind > commits.length && (
        <p className="cn-empty">…and {standing.behind - commits.length} more.</p>
      )}
      {/* The one control the cockpit offers on a repository it does not own, and
          the reason it is here rather than left to a terminal: the project layer
          of the config arrives by exactly this pull, so a clone days behind is a
          harness running a policy the team has already changed.
          → docs/spec/02-configuration.md#the-project-layer

          Drawn only when the server says it would work. Every refusal — a dirty
          checkout, a branch that is not the integration branch, a clone carrying
          its own commits — is the *reason* in its place, because "why is the
          button gone" is the only question a missing control ever raises. */}
      {view.state.build.projectPull.can ? (
        <div className="cn-acts">
          <AsyncButton className="cn-btn cn-primary" onClick={() => actions.pullProject()}>
            Pull
          </AsyncButton>
        </div>
      ) : (
        standing !== null &&
        standing.behind > 0 &&
        view.state.build.projectPull.blocked !== null && (
          <p className="cn-empty">{view.state.build.projectPull.blocked}</p>
        )
      )}
    </section>
  );
}

/**
 * Take the reading again, as a glyph in the card header beside the count it
 * refreshes.
 *
 * **In the header rather than in the controls row**, because it is not a
 * decision: the row below holds the two acts that change something — queue the
 * upgrade, pull the project — and a third button that only re-reads made them
 * three of a kind. Beside the count is also where it says what it does without a
 * word, since the count and the stamp are exactly what it moves.
 *
 * **One act on both cards, not two.** `check(true)` takes the build's reading and
 * the project's in a single pass, so either glyph refreshes both — the same act
 * reached from two places, on {@link needBody}'s terms, rather than two controls
 * that could ever disagree about when the harness last looked.
 */
function CheckNow({ actions }: { actions: CockpitActions }): JSX.Element {
  return (
    <AsyncButton
      className="cn-disc"
      aria-label="Check for updates now"
      title="Check for updates now"
      pendingLabel={<span className="spinner" aria-hidden />}
      onClick={() => actions.checkBuild()}
    >
      <Icon name="refresh" size={12} />
    </AsyncButton>
  );
}

/**
 * When the reading was taken, for a card header's right-hand slot.
 *
 * One helper for both cards because they are one reading taken in one pass: two
 * stamps that could ever disagree would say the harness had checked twice, which
 * it never does. → docs/spec/21-self-update.md#the-project-reading
 */
function checkedStamp(standing: BuildStandingReading | null, now: number): string {
  if (standing === null) return 'not watched';
  return `checked ${relTime(standing.checkedAt, now)}`;
}

/** The chip: how far behind, or the one word that stands in for a count there is none of. */
function projectCount(standing: BuildStandingReading | null): string {
  if (standing === null || standing.unavailable !== null) return 'unknown';
  return standing.behind === 0 ? 'current' : `${standing.behind} behind`;
}

/**
 * What the checkout is and how it stands, in one sentence.
 *
 * The repository is named from `desktopFolder`'s last segment — the path is
 * already on the wire for the deep link, and a card about a checkout that does not
 * say *which* checkout is a card an operator has to guess at. A path that ends in
 * a separator, or is empty, falls back to the plain noun rather than to an empty
 * pair of quotes.
 */
function projectLine(view: CockpitView, standing: BuildStandingReading | null): string {
  const name = projectName(view.state.config.desktopFolder);
  if (standing === null) return `${name} is not being watched — no reading of the project checkout is configured.`;
  if (standing.unavailable !== null) return standing.unavailable;
  const on = standing.branch === null ? '' : ` on ${standing.branch}`;
  // Said in the words of what it costs, never as the bare adjective: `dirty` is a
  // git term for a state whose consequence here is that the harness will not
  // upgrade, and the consequence is the half worth reading.
  const status = standing.dirty
    ? 'uncommitted changes to tracked files, which hold the upgrade beside this'
    : 'the checkout is clean';
  const waiting =
    standing.behind === 0
      ? 'up to date with its remote'
      : `${standing.behind} commit${standing.behind === 1 ? '' : 's'} waiting`;
  return `${name}${on} — ${waiting}, ${status}.`;
}

/** The last segment of a path, under either separator, or the plain noun. */
function projectName(folder: string): string {
  const parts = folder
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '');
  return parts[parts.length - 1] ?? 'The project';
}

/**
 * How much of the changelog the card carries.
 *
 * Five rather than the reading's own ten: this is a card on a page of seven, and
 * the newest handful is what answers "is there anything in this for me". The rest
 * are a click away on the panel, and the line saying how many says so.
 */
const CHANGELOG_ROWS = 5;

/**
 * The one sentence under the heading: what is running, and what the fleet is
 * doing about it.
 *
 * `live` is in it whenever a drain would have to wait, because it is the fact
 * that decides which button — queueing with three agents out is a wind-down that
 * may take hours, and the same click with an empty fleet is immediate.
 */
function buildLine(build: CockpitView['state']['build']): string {
  const { standing } = build;
  if (standing.unavailable !== null) return standing.unavailable;
  const head = standing.head === null ? 'This build' : `Running ${standing.head.slice(0, 7)}`;
  const on = standing.branch === null ? ' (detached)' : ` on ${standing.branch}`;
  if (build.intent.state === 'draining') return `${head}${on} — draining for the upgrade, ${build.live} still running.`;
  if (build.intent.state === 'ready') return `${head}${on} — nothing is live, and the upgrade is ready to apply.`;
  if (standing.behind === 0) return `${head}${on}, up to date with upstream.`;
  const live = build.live === 0 ? 'nothing is live' : `${build.live} live`;
  return `${head}${on}, and ${live}.`;
}

/**
 * One waiting commit, as a row.
 *
 * `refs` is null and that is the decision, not an omission: the reading carries a
 * short sha and no URL, and the install's remote is not the repository the
 * cockpit's refs point at. A commit here has nowhere in the cockpit to go.
 *
 * The author is a fact rather than a {@link PanelRowModel.who} mark, because the
 * mark is for people the harness knows — a reviewer, an assignee — and these are
 * whoever wrote LubbDubb, who are nobody in this deployment's world.
 */
function commitRow(commit: BuildStandingCommit, now: number): PanelRowModel {
  return {
    key: commit.sha,
    title: commit.subject,
    refs: null,
    facts: [
      { label: 'commit', value: commit.sha },
      { label: 'by', value: commit.author },
      { label: 'written', value: relTime(commit.authoredAt, now) },
    ],
  };
}

/**
 * The shape of one commit on the wire, read off the reading rather than imported:
 * `UpstreamCommit` is internal to `src/selfUpdate/buildStanding.ts`, and the
 * cockpit's one server import is `src/wire.ts`.
 */
type BuildStandingCommit = CockpitView['state']['build']['standing']['commits'][number];

/** The same, for a whole reading — the build's own, or the project's beside it. */
type BuildStandingReading = CockpitView['state']['build']['standing'];

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
  const readying = view.readying;
  // The count is the fleet's own, not the list's: the snapshot carries a bounded
  // tail of ended agents, so a number read off `ended` would settle at the cap and
  // report it forever on a deployment that had run twenty thousand shifts.
  const endedTotal = view.state.endedAgents;

  return (
    <section className="cn-card cn-span2">
      <h3>
        Fleet{' '}
        <i className="cn-n">
          {view.live.length} out
          {/* Stated beside the count rather than added to it: nobody dispatched
              these and they take no slot, so "out" would be the wrong word and
              a bigger number would be the wrong reading. */}
          {/* Beside the count for the same reason and a second one: these are on
              their way to being out, so folding them in would make the number
              jump twice for one dispatch. */}
          {readying.length > 0 && ` · ${readying.length} being readied`}
          {desk.length > 0 && ` · ${desk.length} at a keyboard`}
        </i>
        <button
          type="button"
          className={`cn-more ${endedTotal === 0 ? 'cn-quiet' : ''}`}
          onClick={() => setShowEnded(!showEnded)}
          title="Shifts that have ended — the agents no longer running"
        >
          {endedTotal} shift{endedTotal === 1 ? '' : 's'} ended {showEnded ? '⌄' : '›'}
        </button>
      </h3>
      {view.live.length === 0 && desk.length === 0 && readying.length === 0 && (
        <p className="cn-empty">Nobody is out.</p>
      )}
      {showEnded && ended.length === 0 && <p className="cn-empty">No shift has ended.</p>}
      {/* Said rather than left to be noticed: the list is the recent tail and the
          count above is all of them, so a disclosure that opened on 200 rows under
          a heading reading 4,000 would be lying by omission. A goal's own older
          runs are on its page, which fetches them. */}
      {showEnded && endedTotal > ended.length && (
        <p className="cn-empty">
          The {ended.length} most recent, of {endedTotal}. Older runs are on the goal they were dispatched for.
        </p>
      )}
      <PanelRows
        rows={[
          ...view.live.map((agent) => agentRow(agent, view, actions)),
          // Then what it is about to send. Between the two lists rather than at
          // the foot, because that is the order the harness answers "what is
          // happening" in — what it sent out, what it is sending, and then what it
          // did not send at all.
          ...readying.map((action) => readyingRow(action, view)),
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
      {origin !== null && <Ref to={origin} />}
      {/* The relation is the pair's position, not a word between them: on a rail
          this narrow the word cost more room than the two refs it joined, and the
          refs group overran the reading slot beside it. Each ref keeps its own
          hover, which is where the relation is said. */}
      {goal !== null && <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />}
    </>
  );
}

/**
 * What each step of the readying is called on the row.
 *
 * The words are the spec's, not new ones: `docs/spec/09-execution.md` calls the
 * slow one *handing a slot over*, so that is what the cockpit says it is doing.
 * Totalled over {@link ReadyingStep}, so a step added to the executor fails the
 * typecheck rather than drawing as an empty chip.
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
 *
 * **Why the card has to say this at all.** `ActionExecutor.execute` walks a plan
 * strictly serially, and each dispatch waits on the worktree pool before it
 * spawns. A cycle that planned three appraisals with full headroom started them
 * two minutes apart, and for those four minutes the Up next queue said all three
 * had been dispatched while this card showed one agent. Nothing was wrong and
 * nothing said so — which reads, correctly and unhelpfully, as a fleet that picked
 * up one of three.
 *
 * It borrows {@link deskRow}'s grammar wholesale, because it is making the same
 * distinction — in flight, and *not an agent* — and a second vocabulary for one
 * idea is how a card stops being readable:
 *
 * - **A `div`, not a button.** There is no transcript to open, nothing to kill and
 *   nothing to inject into: there is no process yet. A row wearing an agent's
 *   affordances with none of them working is worse than one that never offered them.
 * - **A hollow lamp and a dashed edge.** No dispatch cut this row — it is what a
 *   dispatch is being made out of.
 * - **No cost column.** Nothing has been spent; a `$0.00` would read as a cheap
 *   agent rather than as no agent.
 *
 * Its own tint rather than the desk run's violet, because the two rows differ in
 * exactly the thing an operator is reading them for: a desk run is somebody at a
 * keyboard and takes no fleet slot ever, while this is the harness itself, on its
 * way to taking one.
 *
 * The hover carries the two facts a glance cannot: that it holds no slot the cap
 * counts *yet*, and that it leaves the list on its own — the row is drawn off a
 * record the executor holds for the length of one `await`, released in a
 * `finally`, so a dispatch that fails takes its row with it.
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
      'has no transcript, and it leaves this list the moment the agent starts — or, if the dispatch fails, ' +
      'with the failure.',
    readying: true,
  };
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
  const [showKept, setShowKept] = useState(false);
  // A retained run rides the same list *while there is still work on it*, marked
  // rather than dropped: a goal whose ticket left the tracker's open set —
  // resolved, closed, or its watch tag gone — may still have parts to run, an
  // agent on it and money going onto it, and a list that lost the row the moment
  // the tracker did was how a goal with all of that went unfindable except by
  // address. `stale` is the marking, and it is the only difference between those
  // rows and the live ones.
  //
  // A retained run with *nothing* left in flight is a different reading, and it
  // was the one drowning this card: a finished run on a closed ticket is not a
  // goal in flight, it is a record waiting to be dismissed, and every deployment
  // accumulates them forever. They go behind the header's disclosure — reachable
  // in one click, out of the way of the goals the fleet is actually working, and
  // counted at zero so the way in never moves.
  const retained = view.state.retainedRuns ?? [];
  const working = retained.filter((issue) => retainedWorkInFlight(issue, view));
  const kept = retained.filter((issue) => !retainedWorkInFlight(issue, view));
  const goals = [...view.state.world.issues.filter((issue) => IN_FLIGHT.has(issue.pickup.status)), ...working];
  // Beside the count and not folded into it, for the fleet card's reason: these
  // goals are in flight *and* missing from the backlog, so a single larger number
  // would be the wrong reading of both. Zero draws nothing — the ordinary case on
  // every deployment, and a muted "0 with no Feature" on every card would teach an
  // operator to stop reading the header.
  const orphans = orphanCount(view.state, goals);

  return (
    // `cn-lamp-mark` for the same reason the pull-request rack carries it: the
    // agent-on-it chip rides this card's lamp column too.
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
          // Below the goals in flight, for the fleet card's order: what the harness
          // is working, then what it is only holding on to.
          ...(showKept ? kept.map((issue) => goalRow(issue, view, actions)) : []),
        ]}
      />
    </section>
  );
}

/**
 * Whether a retained run still has work in flight — the gate that keeps this card
 * a list of goals being worked rather than a pile of closed tickets.
 *
 * Three ways it can be true, and they are the three ways any goal is somebody's
 * business now: an agent is on it, the rail is holding an ask about it, or its
 * plan has parts that are not finished. The parts are read through the same
 * `buildGoalTrack` fold the row draws its track from, so what puts the row in the
 * list and what the row then says about itself cannot disagree.
 *
 * A merged-out plan, or no plan at all, means the closed ticket is exactly what it
 * looks like: a run to dismiss, not a goal in flight.
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
  // No fetched history: the row draws the track, which is a fold over the plan's
  // parts, and every agent it needs is a live one.
  const page = buildGoalPage(view.state, ref, view.needsYou, null);
  const track = page === null ? null : buildGoalTrack(page.parts);
  const asks = view.needsYou.filter((n) => n.goalRef === ref).length;
  const onIt = view.agentOnGoal.get(ref);
  const furthest = furthestEnvironment(view.state, ref);
  const orphan = orphanGoal(view.state, issue);

  return {
    key: String(issue.number),
    title: `#${issue.number} ${issue.title}`,
    // The tint is the half of the warning the chip cannot carry. A chip is read
    // once the eye is already on the row; a tinted ground is what makes the row
    // one of the two an operator stops at while scanning past four.
    className: `cn-goal-row ${orphan === null ? '' : 'cn-row-orphan'}`,
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
    // Somebody's hands on this goal as you read it, off the dispatch's own origin
    // rather than off the track: `now` counts `in_review` too, and a pull request
    // sitting open is nobody working.
    live: onIt !== undefined,
    // At the head of the row, in the lamp slot, exactly as the pull-request rack
    // draws it — the two racks sit one above the other and a mark that means the
    // same thing on both has to be in the same place on both. It rode the chips
    // group before, which put it at a different distance along every row depending
    // on whether the environment and the orphan chip beside it had anything to say.
    //
    // A goal's track survives it, unlike a pull request's checks: the track is how
    // far the plan got, which an agent working does not make untrue.
    lamp: onIt === undefined ? undefined : <AgentOnIt agentId={onIt.id} note={onIt.note} actions={actions} />,
    chips: (
      <>
        {/* Where the work actually got to, on the row rather than a page deeper.
            Only ever drawn for an environment holding the goal *whole* — `partial`
            has no furthest anything, and a chip claiming one would be the boolean
            rollup the reach fold exists to refuse. */}
        {furthest !== null && <i className="cn-chip cn-ok">{furthest}</i>}
        {/* A retained run: the tracker's copy is stale, the harness's record is not. */}
        {issue.stale !== undefined && <StaleChip stale={issue.stale} now={view.now} />}
        {/* Not a `<Ref>` and not a button: the row's title already opens this goal,
            and a second destination inside a row that is itself a control is the
            one thing the link rule forbids outright. The way to fix it is the band
            on the page the row opens. */}
        {orphan !== null && (
          <i className="cn-chip cn-orphan-chip" title="This goal hangs off no Feature — open it to place it">
            ▲ no Feature
          </i>
        )}
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
  // Yours first, then the fleet's — and only where there is a *yours* to put
  // first. With nothing assigned, a band over the whole list is a heading that
  // separates nothing and a column of identical hollow marks beside it, so the
  // card takes back exactly the shape it had before the split existed.
  const yours = open.filter(isYours);
  const theirs = open.filter((pr) => !isYours(pr));
  const grouped = yours.length > 0;
  const ordered = grouped ? [...yours, ...theirs] : open;
  // Whether the review's column exists on this card at all — see `ReviewMark`'s
  // `reserve`. An unwatched pull request has no reading and must not bend it.
  const anyReview = open.some((pr) => pr.review !== undefined);

  return (
    // `cn-lamp-mark` widens the lamp column: the rack's lamp is an 8px dot
    // everywhere else, and this card puts a chip in it — see `console.css`.
    <section className="cn-card cn-span2 cn-lamp-mark">
      <h3>
        Pull requests <i className="cn-n">{open.length} open</i>
        {merged !== null && <span className="cn-more">{merged} merged</span>}
      </h3>
      {open.length === 0 && <p className="cn-empty">No pull request is open.</p>}
      <PanelRows
        rows={ordered.map((pr) => {
          const row = prRow(pr, view, actions, watchLabel, anyReview);
          if (!grouped) return row;
          return { ...row, group: band(isYours(pr), yours.length, theirs.length), who: <Who name={whoAsked(pr)} /> };
        })}
      />
    </section>
  );
}

/**
 * A pull request somebody handed you, off the server's verdict rather than off
 * the court.
 *
 * `attention.status === 'you'` is the wrong predicate and reads almost right: a
 * pending merge proposal and a conflict put a pull request in your court too,
 * and neither is a colleague asking. `assignedToYou` is set on exactly the arm
 * where an assignment *is* the court — which is the same field the queue rail
 * keys on, so the two surfaces cannot come to disagree about whose it is.
 * → [07](docs/spec/07-pull-requests.md#a-pull-request-a-person-put-on-you)
 */
function isYours(pr: OpenPullRequest): boolean {
  return pr.attention.assignedToYou !== undefined;
}

/**
 * Whose mark the row wears: the person who asked, or nobody.
 *
 * The author is only drawn on a row that is *yours*. On the fleet's own rows it
 * would be the harness's login on every one of them — one repeated name, in a
 * column whose whole job is to tell rows apart.
 */
function whoAsked(pr: OpenPullRequest): string | null {
  const author = pr.author?.trim() ?? '';
  return isYours(pr) && author !== '' ? author : null;
}

/**
 * The two bands, with their counts. The counts are the reading the heading adds:
 * "is anything mine" is answered by the band existing, and "how much" by the
 * number, without the operator counting rows.
 */
function band(mine: boolean, yours: number, theirs: number): RowGroup {
  return mine
    ? { key: 'yours', label: 'Yours', note: `${yours}`, tone: 'ask' }
    : { key: 'fleet', label: 'The fleet’s', note: `${theirs}` };
}

/**
 * One open pull request: its checks, whose court it is in, and the toggle that
 * takes it off the harness's books.
 */
function prRow(
  pr: OpenPullRequest,
  view: CockpitView,
  actions: CockpitActions,
  watchLabel: string,
  anyReview: boolean,
): PanelRowModel {
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
    //
    // Both ways to the pull request are one token now (`<Ref>` draws the arm), not
    // two tokens carrying the same number: the row raises two questions — what the
    // harness makes of this, and what the diff says — but they are two doors onto
    // one thing, and drawn apart they read as a repeat.
    //
    // The goal sits beside it as a second token rather than behind a word: the
    // pair is always drawn in that order — the pull request, then what it
    // delivers — and on a half-width card the word between them was the slot's
    // widest thing, pushing the group over the reading column beside it. The
    // relation is said in the goal ref's own hover.
    refs: (
      <>
        <Ref to={`pr:${pr.number}`} />
        {goal !== null && <Ref to={goal} title={`Open the goal this pull request is delivering — ${refLabel(goal)}`} />}
      </>
    ),
    // The name is the way onto the pull request's page — its review threads, its
    // checks and the work on its branch — which the rack named and offered no way
    // to until the page existed. Every other card that names a thing with a page
    // opens it from the title, and this is that.
    open: () => actions.selectPr(pr.number),
    openTitle: `Open pull request #${pr.number} — its review threads, its checks and the work on its branch`,
    facts: prFacts(pr, view.now),
    // Whose court it is in, which is the one question the card is for — the
    // server's word, with the server's own reasoning behind it. It was drawn
    // twice before, as a `?` holding the reasons and as a chip holding the same
    // reasons in a `title`, one column apart: two hovers, one sentence, and a
    // state column that said nothing.
    whyLabel: pr.attention.status,
    whyTone: COURT_TONE[pr.attention.status] ?? 'quiet',
    why: pr.attention.reasons.join(' '),
    // **In the lamp slot, at the head of the row.** It stood in the reading slot,
    // third of three glyphs, which put it a different distance along the card on
    // every row depending on what the two beside it had to draw — the one mark on
    // this rack that says *something is happening to this right now* was the one an
    // eye could not find twice in the same place. The lamp column is what that
    // grammar is for: `PanelRow` holds it open on every row once any row fills it,
    // so the mark is either there or visibly not, always at the same x.
    //
    // The column is absent altogether while no agent is out, so a quiet rack pays
    // no gutter for it.
    lamp: onIt === undefined ? undefined : <AgentOnIt agentId={onIt.id} note={onIt.note} actions={actions} />,
    // What is happening to this pull request *now* beats what its checks last
    // said: an agent on the branch is about to change them, so the ladder is a
    // reading of a commit that is being replaced. Only while one is actually on
    // it — every other row keeps its checks.
    reading: (
      <>
        {/* The fleet's own reading of the diff, beside whatever the row's checks
            are saying — it survives an agent taking the ladder's place, because
            what was already read does not change when a branch moves. */}
        <ReviewMark review={pr.review} now={view.now} reserve={anyReview} />
        {onIt === undefined ? <CiLadder pr={pr} /> : null}
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
 *
 * **A wide card, because its rows are wide rows.** A queue row carries a state
 * word, a control and a refs group beside a title that is a sentence — that is a
 * full-width row's worth of slots, and at a quarter of the page it left the title
 * 80px and clipped three of four. Rails that give way ({@link PanelRows}) share the
 * shortfall out; they cannot conjure room a card does not have.
 */
function UpNext({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const items = view.state.upcoming?.items ?? [];
  return (
    <section className="cn-card cn-span2">
      <h3>
        Up next <i className="cn-n">{items.length} queued</i>
      </h3>
      {items.length === 0 && <p className="cn-empty">Nothing is queued.</p>}
      <PanelRows rows={items.map((item) => queueRow(item, view, actions))} />
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
    facts: [{ label: 'rule', value: item.rule }],
    // `QueueStatus` *is* the row's state — dispatching, or one of the named
    // reasons it is not — so it wears the state column rather than sitting as a
    // fact beside a bare `?`. Same duplication the rack and the goals card had:
    // the word and the sentence that expands it were a column apart, and the one
    // with the width said nothing until hovered.
    whyLabel: item.status,
    // `unapproved` is the one held reason that is *your* move — a decomposition
    // nobody has accepted waits on a person, not on the harness. The rest are the
    // harness stopped: a throttle to sit out, a per-plan cap, an earlier rule
    // holding the issue, no headroom.
    whyTone: item.status === 'unapproved' ? 'ask' : held ? 'hold' : 'quiet',
    // The queue's own sentence, verbatim and unre-worded — the direct answer to
    // "are we working on the right thing". Behind the marker rather than on the
    // glass: it is a paragraph on the rows that are held, and the word that says
    // *which* rows those are is now the marker's own label.
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
 * Whether each environment is **well** right now — one row per environment whose
 * operator gave it a health check.
 *
 * On the overview rather than on a goal page, because health is a fact about the
 * environment and not about any goal: drawn per goal it would be the same sentence
 * repeated on every card, and the one place it is actually read — "is anything
 * broken out there" — has no goal selected.
 *
 * **The one card here that draws nothing when it is empty**, which is the
 * deliberate exception to this page's other rule: an environment surface on a
 * deployment that configured none is a row of question marks announcing a feature
 * as broken, and that rule is older than this card
 * (`docs/spec/24-environments.md#in-the-cockpit`). An environment that *is*
 * configured and has not answered yet draws its row and says so.
 *
 * Nothing here re-decides anything. The tier is the check's own word, the reasons
 * are its own sentences drawn verbatim, and `unknown` is drawn as its own reading
 * rather than folded into either of the two that mean something.
 */
function Environments({ view }: { view: CockpitView }): JSX.Element | null {
  const readings = view.state.environmentHealth ?? [];
  if (readings.length === 0) return null;
  const ill = readings.filter((r) => r.state !== 'healthy').length;
  return (
    <section className="cn-card cn-span2">
      <h3>
        Environments <i className="cn-n">{ill === 0 ? readings.length : `${ill}/${readings.length}`}</i>
      </h3>
      <PanelRows rows={readings.map((reading) => healthRow(reading, view.now))} />
    </section>
  );
}

/**
 * One environment's health, as a row.
 *
 * The reasons go behind the marker rather than on the glass, where every other
 * card's long sentence goes: a check naming six services would otherwise be the
 * one row on this page three lines tall. What stays visible is the half a glance
 * needs — the word, and how long it has been that word.
 */
function healthRow(reading: EnvironmentHealthReading, now: number): PanelRowModel {
  const said = HEALTH_SAID[reading.state];
  return {
    key: reading.environment,
    title: reading.environment,
    // Nowhere to go: an environment is a command in a config file, not a thing
    // with a page. Said in the model rather than left out, which is the field's
    // whole purpose.
    refs: null,
    chips: <i className={`cn-chip ${healthTone(reading)}`}>{reading.tier ?? reading.state}</i>,
    // The check's own sentences, verbatim and joined — or the harness's account of
    // why it has none, which is a different thing and never dressed as one.
    why: reading.reasons.length > 0 ? reading.reasons.join(' · ') : reading.detail,
    whyLabel: said,
    whyTone: reading.state === 'healthy' ? 'quiet' : reading.state === 'unknown' ? 'hold' : healthAsk(reading),
    facts: [
      { label: 'since', value: relTime(reading.changedAt, now) },
      { label: 'read', value: relTime(reading.observedAt, now) },
    ],
  };
}

/** What each state is called on the row, in the words an operator would use. */
const HEALTH_SAID: Record<EnvironmentHealthReading['state'], string> = {
  healthy: 'well',
  unhealthy: 'not well',
  unknown: 'no answer',
};

/**
 * No new colours: every tone is one the cockpit already draws, so the card follows
 * a theme switch without the token layer having to learn about it.
 *
 * `unknown` takes the same amber as `orange` and is told apart by the word beside
 * it, which is the honest pairing — a check that could not answer is a thing to
 * look at, and drawing it green or red would be claiming an answer it did not give.
 * An **untiered** `unhealthy` takes red: a severity nobody stated is not a reason
 * to draw an outage quietly.
 */
function healthTone(reading: EnvironmentHealthReading): string {
  if (reading.state === 'healthy') return 'cn-ok';
  if (reading.state === 'unknown') return 'cn-stall';
  return reading.tier === 'orange' ? 'cn-stall' : 'cn-you';
}

/** An orange is the harness holding its nerve; a red — or an untiered one — is your move. */
function healthAsk(reading: EnvironmentHealthReading): 'ask' | 'hold' {
  return reading.tier === 'orange' ? 'hold' : 'ask';
}

/**
 * The world's changes, one row per `(kind, ref)` with a count — three review
 * comments on one pull request are one signal, not three unrelated rows. The
 * server's order (newest first) is kept: re-sorting by count would move the row
 * an operator is watching the moment it moves again.
 *
 * Wide for its neighbour's sake rather than its own — two slots do not need the
 * room. Left narrow it was the one card off the overview's grid, sitting a quarter
 * wide under a page of half-width ones, which reads as a card that failed to lay
 * out rather than as one with little to say.
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
    <section className="cn-card cn-span2">
      <h3>
        World signals <i className="cn-n">{rows.length}</i>
      </h3>
      {rows.length === 0 && <p className="cn-empty">The world has not moved.</p>}
      <PanelRows
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
