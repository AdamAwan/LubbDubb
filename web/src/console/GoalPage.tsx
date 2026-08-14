import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView, PartGroup } from '../view/goalPage.js';
import type { Issue, OpenPullRequest, PlanPart, PullRequest } from '../types.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { renderRichText } from '../components/richText.js';
import { fmtUsd, relTime } from '../components/util.js';
import { Ref } from '../components/refs.js';
import { ValidationSection } from '../components/ValidationSection.js';
import { watchBucket } from '../worldBuckets.js';
import { NeedsBand } from './NeedsBand.js';

/** Where the header's validation chip jumps to. Anchors, not refs — one element. */
const VALIDATION_ANCHOR = 'cn-validation';

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
 * for a bench task — embedded, never redrawn. A second wiring is a second way to
 * answer a proposal with free text on one surface only.
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
      <Validation page={page} actions={actions} refUrls={view.state.refUrls} />
      <div className="cn-gcols">
        <div className="cn-stack">
          <PlanWaves page={page} />
          <Ticket issue={page.issue} refUrls={view.state.refUrls} />
          <PullRequests page={page} view={view} />
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
  // `more_work` is not the opposite of `done` — it is the verdict that puts a
  // goal back in front of the harness once no PR is open, so it needs its own
  // control rather than a second meaning for the finished toggle.
  const moreWork = issue.conclusion.verdict === 'more_work';
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
          {/* Whether the goal's validation plan is settled, beside the other
              verdicts and inside none of them. Absent when there are no checks —
              a goal nobody wrote a plan for is not "clear", and a chip claiming
              it was would be the one lie this whole surface exists to prevent.
              A button rather than the bare chip its neighbours are: the checks are
              now on this page, so the reading has somewhere to go, and a verdict
              you can act on should not be the one chip that does nothing. */}
          {issue.validation !== null && (
            <button
              type="button"
              className={`cn-chip cn-jump ${issue.validation.state === 'clear' ? 'cn-ok' : 'cn-stall'}`}
              onClick={() =>
                document.getElementById(VALIDATION_ANCHOR)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              }
              title={
                issue.validation.state === 'clear'
                  ? `All ${issue.validation.total} validation checks are settled — go to them`
                  : `${issue.validation.failed} failed, ${issue.validation.unrun} never run, ${issue.validation.deferred} deferred — go to them`
              }
            >
              Validation: {issue.validation.passed + issue.validation.waived}/{issue.validation.total}
            </button>
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
          // The route writes both labels on every toggle, so the title names both.
          // Saying only "remove the watch label" understates a click that also
          // tags the goal ignored — and the difference shows up in the backlog,
          // where the goal lands in Ignored rather than back in Unwatched.
          title={
            watched === 'watched'
              ? `Remove "${config.watchLabel}"${config.ignoreLabel ? ` and tag "${config.ignoreLabel}"` : ''} so the harness leaves this goal alone`
              : `Tag this goal "${config.watchLabel}"${config.ignoreLabel ? ` and remove "${config.ignoreLabel}"` : ''} so the harness picks it up`
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
        {issue.state === 'open' && !moreWork && (
          <button
            type="button"
            className="cn-tgl"
            onClick={() => void actions.setIssueConclusion(issue.number, 'more_work')}
            title="Say there is work left here, so the harness picks it up again once no PR is open"
          >
            Work left
          </button>
        )}
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
 * How anyone checks this goal was met — the checks, and what anybody concluded
 * from running each one.
 *
 * **Full width, above the two columns.** Not in either stack: a check draws its
 * steps and what to expect side by side and carries a row of five verbs, and both
 * are cramped in a column. Sitting directly under the header also puts it above
 * the plan, which is the order the page already reads in — what is being asked of
 * you, then the work. Running a check is the one thing on this page that is
 * *owed*, and the bands above it are the only thing that outranks that.
 *
 * The card draws even when the goal has no checks, the rule every card on this
 * page follows: a surface that vanishes when quiet is indistinguishable from one
 * that broke, and "nobody wrote a validation plan" is the reading most worth
 * having.
 *
 * {@link ValidationSection} is *embedded*, never redrawn — the same rule the needs
 * bands follow with `EscalationCard`. It owns the five verbs and their refusals;
 * this passes `cn-btn` so they wear the console's chrome, the seam
 * `HumanTaskActions` already takes.
 */
function Validation({
  page,
  actions,
  refUrls,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  refUrls: Record<string, string>;
}): JSX.Element {
  const { issue, plan, checks } = page;
  const live = checks.filter((c) => c.supersededReason === null);
  const settled = live.filter((c) => c.state === 'passed' || c.state === 'waived').length;

  return (
    <section className="cn-card cn-val" id={VALIDATION_ANCHOR}>
      <h3>
        Validation
        {live.length > 0 && (
          <i className="cn-n">
            {settled}/{live.length} settled
          </i>
        )}
        {/* Where the checks come from, said on the card that manages them: an
            operator who wants the wording changed has to know it is the plan that
            writes it, and this is the only place that connection is drawn. */}
        <span className="cn-more">
          written by the plan
          {plan !== null && (
            <button type="button" className="cn-linkish" onClick={() => actions.viewPlan(plan.id)}>
              amend it there ↗
            </button>
          )}
        </span>
      </h3>
      <div className="cn-vin">
        <ValidationSection
          checks={checks}
          resources={page.checkResources}
          refUrls={refUrls}
          buttonClass="cn-btn"
          onResult={(checkId, result, note) =>
            actions.setValidation(issue.number, checkId, { kind: 'result', result, note })
          }
          onDefer={(checkId, reason) => actions.setValidation(issue.number, checkId, { kind: 'defer', reason })}
          onWaive={(checkId, reason) => actions.setValidation(issue.number, checkId, { kind: 'waive', reason })}
          onReset={(checkId) => actions.setValidation(issue.number, checkId, { kind: 'reset' })}
          onHandover={(checkId, to) => actions.setValidation(issue.number, checkId, { kind: 'handover', to })}
        />
      </div>
    </section>
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
 *
 * **Retired parts are drawn too, in a column of their own.** "The plan has no live
 * parts" is the single-PR arm, and a plan reaches it by having *proposed* a
 * decomposition that was then retired — so the sentence alone leaves the operator
 * told about a plan they cannot read. They sit outside the four groups because
 * they are outside every count on this page: what the plan proposed is not what
 * the goal is made of.
 */
function PlanWaves({ page }: { page: GoalPageView }): JSX.Element {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    parts: page.parts.filter((p) => p.group === group),
  })).filter((g) => g.parts.length > 0);
  const retired = page.retiredParts;

  return (
    <section className="cn-card">
      <h3>
        The plan
        {page.parts.length > 0 && <i className="cn-n">{page.parts.length} parts</i>}
        {page.parts.length === 0 && retired.length > 0 && <i className="cn-n">{retired.length} retired</i>}
        <span className="cn-more">left to right is dispatch order</span>
      </h3>
      <div className="cn-waves">
        {groups.length === 0 && (
          <p className="cn-empty">
            {page.plan === null
              ? 'No plan has been drawn for this goal.'
              : retired.length > 0
                ? 'The plan has no live parts — this goal is worked as one pull request. What it proposed is below.'
                : 'The plan has no live parts.'}
          </p>
        )}
        {groups.map(({ group, parts }) => (
          <div className="cn-col" key={group}>
            <div className="cn-coln">{GROUP_LABEL[group]}</div>
            {parts.map((p) => (
              <Part key={p.part.id} part={p.part} group={p.group} agentId={p.agentId} />
            ))}
          </div>
        ))}
        {retired.length > 0 && (
          <div className="cn-col">
            <div className="cn-coln">Retired</div>
            {retired.map((part) => (
              <Part key={part.id} part={part} group="retired" agentId={null} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Part({
  part,
  group,
  agentId,
}: {
  part: PlanPart;
  /** The four the page groups by, plus the one that is drawn beside them and counted in none of them. */
  group: PartGroup | 'retired';
  agentId: string | null;
}): JSX.Element {
  return (
    <div className={`cn-part cn-${group}`}>
      <b>
        {part.seq} · {part.title}
      </b>
      {group === 'held' && part.blockedReason !== null && <p className="cn-why">{part.blockedReason}</p>}
      {part.scope !== '' && <p>{part.scope}</p>}
      <span className="cn-dep">
        {part.dependsOn.length > 0 ? `depends on ${part.dependsOn.join(', ')}` : 'depends on nothing'}
        {part.prNumber !== null && (
          <>
            {' · '}
            <Ref to={`pr:${part.prNumber}`} label={`PR #${part.prNumber}`} />
          </>
        )}
        {agentId !== null && ` · ${agentId}`}
      </span>
    </div>
  );
}

/**
 * The ticket as it stood at pickup — what a plan, an assay or an ask is judged
 * against.
 *
 * Through `renderRichText`, not `renderMarkdown`: Azure DevOps stores a
 * description as HTML, and markdown-rendering it printed the `<p>` and `<br>` as
 * text. This is the one field on the page the *tracker* wrote rather than an
 * agent, which is why it is the one that sniffs.
 */
function Ticket({ issue, refUrls }: { issue: Issue; refUrls: Record<string, string> }): JSX.Element {
  return (
    <section className="cn-card">
      <h3>
        The ticket <span className="cn-more">as it stood at pickup</span>
      </h3>
      <div className="cn-tick">
        {issue.body.trim() === '' ? <p className="cn-empty">The ticket has no description.</p> : null}
        {renderRichText(issue.body, refUrls)}
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
function PullRequests({ page, view }: { page: GoalPageView; view: CockpitView }): JSX.Element {
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
          // An ignored PR is drawn spent, the same as a closed one below and as an
          // ignored goal in the backlog: nothing will happen on it, and a row at
          // full weight says the opposite.
          <div className={`cn-row ${pr.attention.status === 'ignored' ? 'cn-spent' : ''}`} key={pr.number}>
            <span className="cn-grow">
              <b className="cn-name">
                <Ref to={`pr:${pr.number}`} /> {pr.title}
              </b>
              <span className="cn-sub">{pr.branch}</span>
            </span>
            <CiLadder pr={pr} />
            <CourtChip pr={pr} reminderMs={view.state.config.reviewReminderMs} now={view.now} />
          </div>
        ))}
        {closed.map((pr) => (
          <div className="cn-row cn-spent" key={pr.number}>
            <span className="cn-grow">
              <b className="cn-name">
                <Ref to={`pr:${pr.number}`} /> {pr.title}
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

function courtTone(pr: OpenPullRequest): string {
  return COURT_TONE[pr.attention.status] ?? '';
}

/** A wait in the units it is read in: days past a day, hours below. */
function waitedFor(sinceIso: string, now: number): string {
  const hours = Math.floor(Math.max(0, now - Date.parse(sinceIso)) / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}

/**
 * Whose court a pull request is in, and — on the one arm that means it — how long
 * it has been in somebody else's.
 *
 * Exported for the overview's rack, which draws the same rows: this must read
 * identically on both surfaces, and the same chip written twice is how they come
 * to differ by a tone or a threshold nobody chose.
 *
 * **The age appears only past `reviewReminderMs`.** Every open pull request is
 * waiting on somebody, so an age on all of them says nothing about any; the
 * threshold is what turns it from a decoration into a reading. And it stays a
 * *chip*, never a row in "Needs you": the reviewer here is somebody else, and a
 * queue of other people's obligations is precisely what makes an inbox stop being
 * read. Nothing is dispatched, escalated or filed at the threshold — the harness
 * has no more idea than you do how to make a colleague review faster.
 */
export function CourtChip({
  pr,
  reminderMs,
  now,
}: {
  pr: OpenPullRequest;
  reminderMs: number;
  now: number;
}): JSX.Element {
  const since = pr.attention.reviewWaitingSince;
  const waited = since !== undefined && now - Date.parse(since) >= reminderMs ? waitedFor(since, now) : null;
  return (
    <i
      className={`cn-chip ${courtTone(pr)}`}
      title={
        waited
          ? [...pr.attention.reasons, `waiting since ${new Date(since!).toLocaleString()}`].join(' · ')
          : pr.attention.reasons.join(' · ')
      }
    >
      {pr.attention.status}
      {waited && <span className="cn-chip-age"> · {waited}</span>}
    </i>
  );
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
