import { useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView, GoalPartView, PartGroup } from '../view/goalPage.js';
import type { NeedRow } from '../view/needsYou.js';
import type { Issue, OpenPullRequest, PullRequest } from '../types.js';
import { EscalationCard } from '../components/EscalationCard.js';
import { HumanTaskActions } from '../components/HumanTaskActions.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { renderMarkdown } from '../components/markdown.js';
import { fmtUsd, refLink, relTime } from '../components/util.js';
import { watchBucket } from '../worldBuckets.js';
import { KIND_LABEL } from './QueueRail.js';

/**
 * One goal, with what it wants from you pinned above everything it is doing.
 *
 * That order is the design's whole claim: an ask read next to the goal it is
 * about is answerable, and the same ask read in an inbox is a sentence with no
 * subject. So the bands come first and the plan, the ticket and the pull requests
 * come under them — and a goal with nothing to ask draws no band at all rather
 * than an empty one, because a band that is sometimes furniture stops being read
 * as a demand.
 *
 * Every band embeds the *shared* component that owns its refusal rules —
 * `EscalationCard` for a question, a permission or a proposal, `HumanTaskActions`
 * for a bench task — wired exactly as the Factory Floor wires them. A second
 * wiring is a second way to answer a proposal with free text on one surface only.
 *
 * What is deliberately not here: this goal's slice of the decision log. The
 * snapshot ships the last hundred audit rows fleet-wide and a cycle spends one of
 * them every pulse on its own rationale, so filtered to one goal the list is a
 * handful of dispatches at best and empty for any goal not touched in the last
 * few hours. The design says that becomes its own route rather than being
 * half-built, and this takes that arm.
 */
export function GoalPage({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="cn-goal">
      <Header page={page} view={view} actions={actions} />
      {page.needs.map((row) => (
        <NeedsBand key={row.id} row={row} view={view} actions={actions} />
      ))}
      <div className="cn-gcols">
        <div className="cn-stack">
          <PlanWaves page={page} />
          <Ticket issue={page.issue} refUrls={view.state.refUrls} />
          <PullRequests page={page} refUrls={view.state.refUrls} />
        </div>
        <div className="cn-stack">
          <OnThisGoal page={page} view={view} actions={actions} />
          <Spend issue={page.issue} />
          <Tail issue={page.issue} actions={actions} />
        </div>
      </div>
    </div>
  );
}

/**
 * The goal itself, and the verdicts anyone has passed on it. Each chip quotes a
 * reading the server already made — the assay's own word with its summary in the
 * title, the tracker's own workflow state — so nothing here is a second opinion.
 *
 * A null `spend` draws no reading at all. It means nothing was ever measured (a
 * PTY fleet reports no usage), and `$0.00` would report a goal that cost nothing.
 */
function Header({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { issue } = page;
  const { config, refUrls } = view.state;
  const [raisingBug, setRaisingBug] = useState(false);
  const watched = watchBucket(issue.labels, {
    watchLabel: config.watchLabel,
    ignoreLabel: config.ignoreLabel,
    defaultWatched: false,
  });
  const finished = issue.conclusion.verdict === 'done';
  const merged = page.parts.filter((p) => p.group === 'merged').length;
  const url = issue.url ?? refUrls[`#${issue.number}`];
  // Keyed on the run existing and not having been ended, never on anything the
  // page itself is showing: the button is how a run is abandoned, so it has to be
  // reachable for exactly as long as the harness still holds one.
  const retained = issue.run !== undefined && !issue.run.dismissed;

  return (
    <div className="cn-gh">
      <div className="cn-ghwho">
        <h1>
          #{issue.number} · {issue.title}
        </h1>
        <div className="cn-ghmeta">
          {issue.issueType !== undefined && <i className="cn-chip">{issue.issueType}</i>}
          <i className="cn-chip">{issue.workItemState ?? issue.state}</i>
          {issue.assay !== null && (
            <i
              className={`cn-chip ${issue.assay.verdict === 'workable' ? 'cn-ok' : 'cn-stall'}`}
              title={issue.assay.summary}
            >
              Assay: {issue.assay.verdict}
            </i>
          )}
          {issue.conclusion.verdict !== 'undeclared' && (
            <i className="cn-chip" title={issue.conclusion.note}>
              {issue.conclusion.verdict.replace(/_/g, ' ')}
            </i>
          )}
          {issue.run !== undefined && <span>started {relTime(issue.run.startedAt, view.now)}</span>}
          <span>
            {page.agents.length} agent{page.agents.length === 1 ? '' : 's'}
          </span>
          {issue.spend !== null && <span>{fmtUsd(issue.spend.costUsd)}</span>}
          {page.parts.length > 0 && (
            <span>
              {merged} of {page.parts.length} parts merged
            </span>
          )}
        </div>
      </div>
      <div className="cn-ghacts">
        <button
          type="button"
          className={`cn-tgl ${watched === 'watched' ? 'cn-watch' : ''}`}
          onClick={() => void actions.setIssueWatched(issue.number, watched !== 'watched')}
          title={
            watched === 'watched'
              ? `Remove "${config.watchLabel}" so the harness leaves this goal alone`
              : `Tag this goal "${config.watchLabel}" so the harness picks it up`
          }
        >
          {watched === 'watched' ? 'Watching' : 'Watch'}
        </button>
        <button
          type="button"
          className="cn-tgl"
          onClick={() => void actions.setIssueConclusion(issue.number, finished ? null : 'done')}
          title={
            finished
              ? 'Withdraw "finished" — the goal goes back to whatever its agents and its plan say'
              : 'Mark this goal finished, so the harness schedules nothing more for it'
          }
        >
          {finished ? 'Unfinish' : 'Mark done'}
        </button>
        {config.canFileTickets && (
          <button
            type="button"
            className="cn-tgl"
            onClick={() => setRaisingBug(true)}
            title="Report that this does not work as you expect — an agent files it as a bug against this goal"
          >
            Raise a bug
          </button>
        )}
        {url !== undefined && (
          <a className="cn-tgl" href={url} target="_blank" rel="noopener noreferrer">
            Open ticket ↗
          </a>
        )}
        {retained && (
          <button
            type="button"
            className="cn-tgl"
            onClick={() => void actions.dismissRun(issue.number)}
            title="End the harness's run at this goal. One way, and terminal for the dispatcher — the report stays readable."
          >
            End the run
          </button>
        )}
      </div>
      {raisingBug && (
        <RaiseBugModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          onSubmit={(summary, title) => actions.raiseBug(issue.number, summary, title)}
          onClose={() => setRaisingBug(false)}
        />
      )}
    </div>
  );
}

/**
 * One open ask, pinned. Red when an agent is parked on it, amber when the
 * obligation is only the operator's — the rail's own split, carried over so the
 * row and the band it opens read the same.
 *
 * The band draws nothing at all when the row's source is gone from the snapshot.
 * A header over an empty box would claim something is waiting while offering no
 * way to answer it.
 */
function NeedsBand({
  row,
  view,
  actions,
}: {
  row: NeedRow;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const body = bandBody(row, view, actions);
  if (body === null) return null;
  return (
    <div className={`cn-needs ${row.group === 'blocking' ? '' : 'cn-soft'}`}>
      <header>
        Needs you · {KIND_LABEL[row.kind]}
        <span className="cn-age">
          {row.raisedAt !== '' && relTime(row.raisedAt, view.now)}
          {row.holding > 0 && ` · holding ${row.holding} parts`}
        </span>
      </header>
      <div className="cn-in">{body}</div>
    </div>
  );
}

/**
 * What answers this ask — the shared component that owns its verdict, wired the
 * way the stamp desk and the bench wire it. `buttonClass` is the one seam a
 * station passes, so the console's buttons and a modal's are one component
 * wearing two faces.
 */
function bandBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  if (row.kind === 'bench' || row.kind === 'close_out') {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    return (
      <>
        <p>{task.title}</p>
        {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
        <div className="cn-acts">
          <HumanTaskActions
            task={task}
            buttonClass="cn-btn"
            onDone={(id) => actions.completeHumanTask(id)}
            onDecline={(id, note) => actions.declineHumanTask(id, note)}
          />
        </div>
      </>
    );
  }
  const escalation = view.state.escalations.find((e) => e.id === row.id);
  if (!escalation) return null;
  return (
    <EscalationCard
      escalation={escalation}
      proposal={view.proposalFor.get(escalation.id)}
      resumedAt={escalation.agentId ? (view.agentById.get(escalation.agentId)?.resumedAt ?? null) : null}
      now={view.now}
      refUrls={view.state.refUrls}
      onAnswer={(text) => actions.answerEscalation(escalation.id, text)}
      onAnswerQuestions={(answers) => actions.answerQuestions(escalation.id, answers)}
      onDecide={(id, verdict, note) => actions.decideProposal(id, verdict, note)}
      onPermission={(id, allow, note) => actions.decidePermission(id, allow, note)}
      onDismiss={(id, note) => actions.dismissEscalation(id, note)}
      onOpenAgent={(id) => actions.select(id)}
      onComplete={(id) => actions.completeAgent(id)}
      onViewPlan={(id) => actions.viewPlan(id)}
    />
  );
}

const GROUP_ORDER: PartGroup[] = ['merged', 'now', 'held', 'waiting'];
const GROUP_LABEL: Record<PartGroup, string> = {
  merged: 'Merged',
  now: 'Now',
  held: 'Held',
  waiting: 'Not started',
};

/**
 * The plan, left to right in dispatch order. Grouped by the derivation's own four
 * groups rather than by `status` a second time, so what the overview's segment
 * track counts and what this draws cannot disagree.
 *
 * A held part carries the reconciler's `blockedReason` verbatim. It is the one
 * status nothing else in the world explains — a blocked part has no branch, no PR
 * and no agent to read — so a paraphrase here would be the only account there is,
 * and wrong.
 */
function PlanWaves({ page }: { page: GoalPageView }): JSX.Element {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    parts: page.parts.filter((p) => p.group === group),
  })).filter((g) => g.parts.length > 0);

  return (
    <section className="cn-card">
      <h3>
        The plan
        {page.parts.length > 0 && <i className="cn-n">{page.parts.length} parts</i>}
        <span className="cn-more">left to right is dispatch order</span>
      </h3>
      <div className="cn-waves">
        {groups.length === 0 ? (
          <p className="cn-empty">
            {page.plan === null ? 'No plan has been drawn for this goal.' : 'The plan has no live parts.'}
          </p>
        ) : (
          groups.map(({ group, parts }) => (
            <div className="cn-col" key={group}>
              <div className="cn-coln">{GROUP_LABEL[group]}</div>
              {parts.map((p) => (
                <Part key={p.part.id} view={p} />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function Part({ view }: { view: GoalPartView }): JSX.Element {
  const { part } = view;
  return (
    <div className={`cn-part cn-${view.group}`}>
      <b>
        {part.seq} · {part.title}
      </b>
      {view.group === 'held' && part.blockedReason !== null && <p className="cn-why">{part.blockedReason}</p>}
      {part.scope !== '' && <p>{part.scope}</p>}
      <span className="cn-dep">
        {part.dependsOn.length > 0 ? `depends on ${part.dependsOn.join(', ')}` : 'depends on nothing'}
        {part.prNumber !== null && ` · PR #${part.prNumber}`}
        {view.agentId !== null && ` · ${view.agentId}`}
      </span>
    </div>
  );
}

/** The ticket as it stood at pickup — what a plan, an assay or an ask is judged against. */
function Ticket({ issue, refUrls }: { issue: Issue; refUrls: Record<string, string> }): JSX.Element {
  return (
    <section className="cn-card">
      <h3>
        The ticket <span className="cn-more">as it stood at pickup</span>
      </h3>
      <div className="cn-tick">
        {issue.body.trim() === '' ? <p className="cn-empty">The ticket has no description.</p> : null}
        {renderMarkdown(issue.body, refUrls)}
      </div>
    </section>
  );
}

/**
 * This goal's pull requests. Whose court and which check is red are both the
 * server's verdicts — `attention.status` and `ciVerdict` — quoted rather than
 * re-read here: a client-side second opinion about a merge is the drift that
 * outlives the change that introduces it.
 */
function PullRequests({ page, refUrls }: { page: GoalPageView; refUrls: Record<string, string> }): JSX.Element {
  const open = page.openPullRequests;
  const closed = page.closedPullRequests;
  return (
    <section className="cn-card">
      <h3>
        Pull requests
        <i className="cn-n">
          {open.length} open · {closed.length} closed
        </i>
      </h3>
      <div className="cn-rows">
        {open.length === 0 && closed.length === 0 && <p className="cn-empty">No pull request names this goal yet.</p>}
        {open.map((pr) => (
          <div className="cn-row" key={pr.number}>
            <span className="cn-grow">
              <b className="cn-name">
                {refLink(`#${pr.number}`, refUrls)} {pr.title}
              </b>
              <span className="cn-sub">{pr.branch}</span>
            </span>
            <CiLadder pr={pr} />
            <i className={`cn-chip ${courtTone(pr)}`} title={pr.attention.reasons.join(' · ')}>
              {pr.attention.status}
            </i>
          </div>
        ))}
        {closed.map((pr) => (
          <div className="cn-row cn-spent" key={pr.number}>
            <span className="cn-grow">
              <b className="cn-name">
                {refLink(`#${pr.number}`, refUrls)} {pr.title}
              </b>
              <span className="cn-sub">{pr.branch}</span>
            </span>
            <i className={`cn-chip ${pr.merged ? 'cn-ok' : ''}`}>{pr.merged ? 'merged' : 'closed'}</i>
          </div>
        ))}
      </div>
    </section>
  );
}

const COURT_TONE: Record<string, string> = {
  you: 'cn-you',
  harness: 'cn-harness',
  stalled: 'cn-stall',
  done: 'cn-ok',
};

/**
 * Exported for the overview's rack, which draws the same rows: whose court a PR
 * is in must read identically on both surfaces, and two lookups of one map is
 * how they come to differ by a tone nobody chose.
 */
export function courtTone(pr: OpenPullRequest): string {
  return COURT_TONE[pr.attention.status] ?? '';
}

/**
 * One dot per check the CI policy classified, in the policy's own three
 * categories, and the aggregate under its generic name when the provider reported
 * no per-check detail at all. No check name is written here — every one comes off
 * the verdict.
 *
 * Exported for the overview's rack for `courtTone`'s reason: the ladder is a
 * reading of `ciVerdict`, and a second one written beside it would be a second
 * chance to classify a check the policy already classified.
 */
export function CiLadder({ pr }: { pr: PullRequest }): JSX.Element | null {
  const verdict = pr.ciVerdict;
  const dots: { name: string; tone: string }[] = [
    ...(verdict?.dispatch ?? []).map((m) => ({ name: m.name, tone: 'cn-fail' })),
    ...(verdict?.escalate ?? []).map((m) => ({ name: m.name, tone: 'cn-notours' })),
    ...(verdict?.ignored ?? []).map((m) => ({ name: m.name, tone: 'cn-mute' })),
  ];
  if (dots.length === 0) {
    // Missing detail is not a clean bill of health, so the aggregate speaks for
    // itself under the generic name rather than drawing nothing.
    const tone =
      pr.ciStatus === 'passing'
        ? 'cn-pass'
        : pr.ciStatus === 'failing'
          ? 'cn-fail'
          : pr.ciStatus === 'pending'
            ? 'cn-wait'
            : null;
    if (tone === null) return null;
    dots.push({ name: 'quality gates', tone });
  }
  return (
    <span className="cn-ci">
      {dots.map((d) => (
        <i className={`cn-cd ${d.tone}`} key={d.name} title={d.name} />
      ))}
    </span>
  );
}

/** Who is on this goal right now, and what each has cost where that was measured. */
function OnThisGoal({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <section className="cn-card">
      <h3>
        On this goal <i className="cn-n">{page.agents.length}</i>
      </h3>
      <div className="cn-rows">
        {page.agents.length === 0 && <p className="cn-empty">No agent is on this goal.</p>}
        {page.agents.map((agent) => (
          <button type="button" className="cn-row" key={agent.id} onClick={() => actions.select(agent.id)}>
            <i
              className={`cn-lamp ${agent.status === 'waiting' ? 'cn-ask' : agent.endedAt === null ? 'cn-run' : 'cn-off'}`}
            />
            <span className="cn-grow">
              <b className="cn-name">{view.taskFor(agent)?.title ?? agent.id}</b>
              <span className="cn-sub">
                {agent.status} · {relTime(agent.startedAt, view.now)}
                {agent.note !== null && ` · ${agent.note}`}
              </span>
            </span>
            {agent.costUsd !== null && <span className="cn-num">{fmtUsd(agent.costUsd)}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * What the goal has cost, over every agent under it. The whole card is absent
 * when nothing was measured — the rows would all read zero and none of them would
 * be a reading.
 */
function Spend({ issue }: { issue: Issue }): JSX.Element | null {
  const spend = issue.spend;
  if (spend === null) return null;
  return (
    <section className="cn-card">
      <h3>Spend</h3>
      <div className="cn-rows">
        <div className="cn-kv">
          <span>Total</span>
          <b>{fmtUsd(spend.costUsd)}</b>
        </div>
        <div className="cn-kv">
          <span>Agents</span>
          <b>{spend.agents}</b>
        </div>
        <div className="cn-kv">
          <span>Tokens</span>
          <b>
            {spend.inputTokens}→{spend.outputTokens}
          </b>
        </div>
      </div>
    </section>
  );
}

/**
 * What is left after the parts: the goal check, the write-up, and closing the
 * ticket. Each states the verdict its own author wrote, or that nothing has run —
 * "not reached yet" is a fact about the goal worth seeing, not an empty section.
 */
function Tail({ issue, actions }: { issue: Issue; actions: CockpitActions }): JSX.Element {
  const ref = `issue:${issue.number}`;
  const check = issue.delivery?.summary ?? issue.shortfall?.summary ?? null;
  return (
    <section className="cn-card">
      <h3>The tail</h3>
      <div className="cn-rows">
        <div className="cn-row">
          <i className={`cn-lamp ${check === null ? 'cn-off' : issue.delivery ? 'cn-run' : 'cn-wait'}`} />
          <span className="cn-grow">
            <b className="cn-name">Goal check</b>
            <span className="cn-sub">{check ?? 'has not run'}</span>
          </span>
        </div>
        <div className="cn-row">
          <i className={`cn-lamp ${issue.retrospective === null ? 'cn-off' : 'cn-run'}`} />
          <span className="cn-grow">
            <b className="cn-name">Write-up</b>
            <span className="cn-sub">{issue.retrospective?.summary ?? 'not written'}</span>
          </span>
          {issue.retrospective !== null && (
            <button type="button" className="cn-tgl" onClick={() => actions.viewRetro(ref)}>
              Read
            </button>
          )}
        </div>
        <div className="cn-row">
          <i className={`cn-lamp ${issue.state === 'open' ? 'cn-off' : 'cn-run'}`} />
          <span className="cn-grow">
            <b className="cn-name">Close the ticket</b>
            <span className="cn-sub">{issue.state === 'open' ? 'still open' : issue.state}</span>
          </span>
        </div>
        <div className="cn-row">
          <i className={`cn-lamp ${issue.scratchpad === null ? 'cn-off' : 'cn-run'}`} />
          <span className="cn-grow">
            <b className="cn-name">Notes</b>
            <span className="cn-sub">
              {issue.scratchpad === null ? 'nothing written' : `${issue.scratchpad.entries} entries`}
            </span>
          </span>
          {issue.scratchpad !== null && (
            <button type="button" className="cn-tgl" onClick={() => actions.viewScratchpad(ref)}>
              Open
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
