import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, Issue, QueueItem, WorldEvent } from '../types.js';
import { buildGoalPage, buildGoalTrack, type GoalTrack } from '../view/goalPage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { elapsed, fmtUsd, linkify, refLink, relTime } from '../components/util.js';
import { CiLadder, courtTone } from './GoalPage.js';

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

  return (
    <section className="cn-card cn-span2">
      <h3>
        Fleet <i className="cn-n">{view.live.length} out</i>
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
        {view.live.length === 0 && <p className="cn-empty">Nobody is out.</p>}
        {view.live.map((agent) => (
          <AgentRow key={agent.id} agent={agent} view={view} actions={actions} />
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

function AgentRow({ agent, view, actions }: { agent: Agent; view: CockpitView; actions: CockpitActions }): JSX.Element {
  const task = view.taskFor(agent);
  const origin = task?.originRef ?? null;
  const done = agent.endedAt !== null;
  const lamp = view.escalationByAgent.has(agent.id)
    ? 'cn-ask'
    : done
      ? 'cn-off'
      : agent.status === 'waiting'
        ? 'cn-wait'
        : 'cn-run';
  return (
    <button
      type="button"
      className={`cn-row ${done ? 'cn-spent' : ''}`}
      onClick={() => actions.select(agent.id)}
      title="Open this agent's drawer"
    >
      <i className={`cn-lamp ${lamp}`} />
      <span className="cn-grow">
        <b className="cn-name">{task?.title ?? agent.id}</b>
        <span className="cn-sub">
          {origin !== null && `${goalLabel(origin)} · `}
          {agent.note ?? agent.status} · {elapsed(agent.startedAt, agent.endedAt, view.now)}
        </span>
      </span>
      {agent.costUsd !== null && <span className="cn-num">{fmtUsd(agent.costUsd)}</span>}
    </button>
  );
}

/** `issue:212:part:writes` → `#212`, the shortest name the rail also uses for a goal. */
function goalLabel(ref: string): string {
  return ref.replace(/^issue:(\d+).*$/, '#$1');
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
  const { refUrls, config } = view.state;
  const open = view.state.world.pullRequests;
  const closed = view.state.world.closedPullRequests;
  const merged = closed === undefined ? null : closed.filter((pr) => pr.merged).length;
  const goalOf = goalByPr(view);
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
          const excluded = (pr.labels ?? []).includes(ignoreLabel);
          const goal = goalOf.get(pr.number);
          return (
            <div className="cn-row" key={pr.number}>
              <span className="cn-grow">
                <b className="cn-name">
                  {refLink(`#${pr.number}`, refUrls)} {pr.title}
                </b>
                <span className="cn-sub">
                  {goal !== undefined && `${goalLabel(goal)} · `}
                  {pr.branch}
                </span>
              </span>
              <CiLadder pr={pr} />
              <i className={`cn-chip ${courtTone(pr)}`} title={pr.attention.reasons.join(' · ')}>
                {pr.attention.status}
              </i>
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
 * PR number → the goal whose plan opened it, joined through the parts rather than
 * guessed from the branch name. A PR nobody's plan claims is left out of the map
 * and draws its branch instead, which is honest about what is known.
 */
function goalByPr(view: CockpitView): Map<number, string> {
  const planRef = new Map((view.state.plans ?? []).map((p) => [p.id, p.originRef]));
  const out = new Map<number, string>();
  for (const part of view.state.planParts ?? []) {
    const ref = planRef.get(part.planId);
    if (part.prNumber !== null && ref !== undefined) out.set(part.prNumber, ref);
  }
  return out;
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
          <QueueRow key={`${item.origin}|${item.rule}`} item={item} refUrls={view.state.refUrls} />
        ))}
      </div>
    </section>
  );
}

function QueueRow({ item, refUrls }: { item: QueueItem; refUrls: Record<string, string> }): JSX.Element {
  return (
    <div className="cn-row">
      <span className="cn-grow">
        <b className="cn-name">
          {refLink(item.origin, refUrls)} {item.title}
        </b>
        <span className={`cn-sub cn-wrap ${item.status === 'dispatching' ? '' : 'cn-held'}`}>{item.reason}</span>
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
              <b className="cn-name">{linkify(event.summary, view.state.refUrls)}</b>
              <span className="cn-sub">
                {event.kind} · {relTime(event.createdAt, view.now)}
              </span>
            </span>
            {count > 1 && <span className="cn-num">×{count}</span>}
          </div>
        ))}
      </div>
    </section>
  );
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
