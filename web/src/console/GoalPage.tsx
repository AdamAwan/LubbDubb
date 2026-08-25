import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView, PartGroup } from '../view/goalPage.js';
import type {
  Agent,
  EnvironmentGate,
  GoalReachStatus,
  Issue,
  OpenPullRequest,
  PlanPart,
  PullRequest,
  ValidationVerdict,
} from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { ProfilePicker } from '../components/ProfilePicker.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { InstructionModal } from '../components/InstructionModal.js';
import { GateReleaseModal } from '../components/GateReleaseModal.js';
import { EndRunModal } from '../components/EndRunModal.js';
import { renderRichText } from '../components/richText.js';
import { issueTypeTone } from '../issueGroups.js';
import { fmtUsd, relTime } from '../components/util.js';
import { Ref } from '../components/refs.js';
import { askPrompt, desktopDeepLink, localRunPrompt } from '../cockpit/desktopLink.js';
import { ValidationSection } from '../components/ValidationSection.js';
import { watchBucket } from '../worldBuckets.js';
import { stateColour } from '../stateColour.js';
import { WorkRecord } from '../components/WorkRecord.js';
import { NeedsBand } from './NeedsBand.js';

/** Where the header's validation chip jumps to. Anchors, not refs — one element. */
const VALIDATION_ANCHOR = 'cn-validation';

/** The three statuses that mean an agent is still going, as `countLiveAgents` reads them. */
const LIVE_AGENT = new Set<Agent['status']>(['starting', 'running', 'waiting']);

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
 * The goal-profile gate (#342) is one of those bands rather than a section of
 * its own, which is what puts it in the rail as well: it holds every dispatch for
 * this goal and expires on nothing but the answer, so a hold drawn only here was
 * one nobody found until they wondered why the goal had not started.
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
      <Validation
        page={page}
        actions={actions}
        refUrls={view.state.refUrls}
        desktopFolder={view.state.config.desktopFolder}
      />
      <div className="cn-gcols">
        <div className="cn-stack">
          <PlanWaves page={page} actions={actions} />
          <Instructions issue={page.issue} actions={actions} />
          <Ticket issue={page.issue} refUrls={view.state.refUrls} />
          <PullRequests page={page} view={view} />
          <Environments page={page} actions={actions} now={view.now} />
          {/* Embedded exactly as the work tree and the launch desk are: it reaches
              its own route, which `console/` may not, but rendering a component
              that does is not reaching — the import ban is on `api.js` and still
              holds. Last in the column, and below `PullRequests` and
              `Environments` on purpose: both of those are the live reading and
              something the goal still owes, and this is what is left of the same
              work once the snapshot has forgotten it. Nothing here is owed. */}
          <section className="cn-card">
            <WorkRecord goalRef={`issue:${page.issue.number}`} now={view.now} />
          </section>
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
  const watched = watchBucket(issue.labels, config.watchLabel);
  const finished = issue.conclusion.verdict === 'done';
  // `more_work` is not the opposite of `done` — it is the verdict that puts a
  // goal back in front of the harness once no PR is open, so it needs its own
  // control rather than a second meaning for the finished toggle. Here it only
  // marks the button: what the operator writes is the instruction, and the
  // verdict is what makes there be an agent to read it.
  const moreWork = issue.conclusion.verdict === 'more_work';
  const [instructing, setInstructing] = useState(false);
  const [endingRun, setEndingRun] = useState(false);
  // What ending the run costs, or null when it costs nothing: the route refuses a
  // dismissal with no note while the plan is flagged
  // ([20](../../../docs/spec/20-validation.md#where-it-lands)), and the button
  // posting none was a control that could not work — the 400 went to an unhandled
  // rejection, so the click did nothing and said nothing.
  const owed = issue.validation !== null && issue.validation.state === 'flagged' ? issue.validation : null;
  const standing = issue.instructions.length;
  // What ending the run kills, in the same subtree the header's agent count reads
  // — so the confirmation states a number the operator can already see above it.
  const live = page.agents.filter((a) => LIVE_AGENT.has(a.status)).length;
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
          {issue.issueType !== undefined && (
            <i className={`cn-chip cn-type ${issueTypeTone(issue.issueType)}`}>{issue.issueType}</i>
          )}
          <StateChip state={issue.workItemState ?? issue.state} colours={config.stateColours} />
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
        {/* The one control up here that changes nothing. It opens the operator's
            own Claude Code on this goal with `/lubbdubb ask <n>` already in the
            box, so a question about the work — what was done, which pull request,
            is it on hallway yet — is a click from the goal rather than a cockpit
            read joined to a repository read by hand. An anchor rather than a
            button, as the other two deep links are: a deep link is a destination.
            First in the row because it is the read, and everything after it acts.
            The command is in the title as well as the href for `desktopPrompt`'s
            reason — the link reaches only the machine this browser is on, and a
            client that is not installed answers nothing at all, so an operator
            reading the cockpit from another desk is left with the line to type. */}
        <a
          className="cn-tgl"
          href={desktopDeepLink(config.desktopFolder, askPrompt(issue.number))}
          title={`Opens your own Claude Code with "${askPrompt(issue.number).trim()}" ready for your question, answered from what the harness actually recorded about this goal — the plan, the pull requests, what was escalated, what it cost, and where the work has reached.`}
        >
          Ask ↗
        </a>
        <button
          type="button"
          className={`cn-tgl ${watched === 'watched' ? 'cn-watch' : ''}`}
          onClick={() => void actions.setIssueWatched(issue.number, watched !== 'watched')}
          // One label, both ways: un-watching takes the tag off and writes nothing
          // in its place, which is why the goal lands back in Unwatched rather than
          // in a bucket of its own.
          title={
            watched === 'watched'
              ? `Remove "${config.watchLabel}" so the harness leaves this goal alone`
              : `Tag this goal "${config.watchLabel}" so the harness picks it up`
          }
        >
          {watched === 'watched' ? 'Watching' : 'Watch'}
        </button>
        {/* "Work this one first." Beside the watch toggle because it is the next
            thing an operator says after "work this" — and deliberately worded as a
            queue statement rather than an importance one: it changes what the
            fleet reaches for while it is short of slots, and it changes nothing
            about whether the goal is allowed to move. A goal sitting on a cooldown
            or an unapproved plan is still sitting there, flagged. */}
        <button
          type="button"
          className={`cn-tgl ${issue.priority !== null ? 'cn-watch' : ''}`}
          onClick={() => void actions.setGoalPriority(issue.number, issue.priority === null)}
          title={
            issue.priority === null
              ? 'Work this goal first: everything under it — its plan, its parts, its pull requests — takes the next free slots ahead of the rest. It does not lift a cooldown, a part cap or an unapproved plan.'
              : `Marked a priority ${relTime(issue.priority.since, view.now)} — click to hand the queue back to its natural order`
          }
        >
          {issue.priority !== null ? 'Priority' : 'Prioritise'}
        </button>
        {/* Which profile this goal's work runs on (#342). Beside the watch toggle
            because it is the same kind of statement about the same object — "work
            this" and "work this at this depth" — and because an operator who has
            just read a hard ticket is already here. */}
        <ProfilePicker
          profiles={config.profiles}
          value={issue.modelPin.profile}
          defaultProfile={config.defaultProfile}
          inheritLabel="Not pinned"
          onPick={(profile) => void actions.setIssueProfile(issue.number, profile)}
        />
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
        {issue.state === 'open' && (
          <button
            type="button"
            className={`cn-tgl ${moreWork ? 'cn-watch' : ''}`}
            onClick={() => setInstructing(true)}
            title={
              standing === 0
                ? 'Say what you want done next on this goal — your words go to the next agent, and the goal goes back in front of the harness: a "delivered" verdict is retracted, and a plan whose parts have all landed is sent back to a planner for you to approve again'
                : `Add to the ${standing} instruction${standing === 1 ? '' : 's'} already standing on this goal`
            }
          >
            More work{standing > 0 ? ` · ${standing}` : ''}
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
        {/* Destructive, and always confirmed. Ending a run no longer merely clears
            the card: it kills the goal's live agents, cancels its queued jobs and
            settles its standing instructions, none of which can be undone — so the
            one thing the header must not do is fire it on a stray click. The modal
            is where what it costs is stated, and the flagged-plan note is one more
            requirement inside it rather than the reason it opens. */}
        {retained && (
          <button
            type="button"
            className="cn-tgl cn-danger"
            onClick={() => setEndingRun(true)}
            title="End the harness's run at this goal — one way, terminal for the dispatcher, and it stops the agents, jobs and instructions still standing on it. It asks before it does."
          >
            End the run…
          </button>
        )}
      </div>
      {instructing && (
        <InstructionModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          onSubmit={(text) => actions.addInstruction(issue.number, text)}
          onClose={() => setInstructing(false)}
        />
      )}
      {endingRun && (
        <EndRunModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          outstanding={owed === null ? null : outstanding(owed)}
          agents={live}
          instructions={standing}
          onSubmit={(note) => actions.dismissRun(issue.number, note)}
          onClose={() => setEndingRun(false)}
        />
      )}
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
/**
 * What the plan still owes, in the header chip's own words rather than a second
 * wording of them — the counts are the server's fold (`issue.validation`), and
 * two surfaces reading one verdict two ways is the thing that fold exists to
 * prevent.
 */
function outstanding(verdict: ValidationVerdict): string {
  return `Its validation plan is not clear — ${verdict.failed} failed, ${verdict.unrun} never run, ${verdict.deferred} deferred, of ${verdict.total}.`;
}

/**
 * The goal's tracker state, in the colour the operator gave it.
 *
 * The same reading as the backlog's chip and for the same reason: two surfaces
 * drawing one state two colours would be worse than neither being coloured.
 */
function StateChip({ state, colours }: { state: string; colours: Readonly<Record<string, string>> }): JSX.Element {
  const colour = stateColour(colours, state);
  return (
    <i className="cn-chip" style={colour === null ? undefined : { color: colour, borderColor: colour }}>
      {state}
    </i>
  );
}

function Validation({
  page,
  actions,
  refUrls,
  desktopFolder,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  refUrls: Record<string, string>;
  /** `config.desktopFolder` — the checkout the desktop hand-off opens Claude Code on. */
  desktopFolder: string;
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
        {/* The one control on this card that is not about a particular check, and
            it sits here because most checks cannot begin until it has been used:
            it opens the operator's own Claude Code and asks it to get the
            application up. An anchor rather than a button — a deep link is a
            destination — and outside `cn-more` so it reads as an action beside
            that sentence rather than as part of it. Drawn unconditionally: the
            `local-run` prompt always has a body, so there is nothing to check
            first and no configuration state to fall out of step with. */}
        <a
          className="cn-linkish"
          href={desktopDeepLink(desktopFolder, localRunPrompt(issue.number))}
          title={`Opens your own Claude Code with "${localRunPrompt(issue.number)}" ready to send, so this goal’s work is running on the machine in front of you — then it offers you the checks.`}
        >
          run it locally ↗
        </a>
      </h3>
      <div className="cn-vin">
        <ValidationSection
          checks={checks}
          issueNumber={issue.number}
          resources={page.checkResources}
          refUrls={refUrls}
          desktopFolder={desktopFolder}
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
 * **Retired parts are drawn too, in a column of their own.** What an amendment
 * dropped is half of what the plan's record is for: without them a goal whose part
 * list shrank between two readings has simply lost rows, with nothing saying so.
 * They sit outside the four groups because they are outside every count on this
 * page: what the plan proposed is not what the goal is made of.
 *
 * **The header carries the way into the plan sheet.** What this card draws is the
 * shape of the work — titles, groups and dependencies — and the plan is also a
 * diagnosis, an approach, an acceptance checklist per part and the record of the
 * decision that was made on it. Without a control here the only way onto that
 * from a goal was the validation card's aside about amending the checks, which
 * reads as being about checks.
 */
function PlanWaves({ page, actions }: { page: GoalPageView; actions: CockpitActions }): JSX.Element {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    parts: page.parts.filter((p) => p.group === group),
  })).filter((g) => g.parts.length > 0);
  const retired = page.retiredParts;
  const plan = page.plan;

  return (
    <section className="cn-card">
      <h3>
        The plan
        {page.parts.length > 0 && <i className="cn-n">{page.parts.length} parts</i>}
        {page.parts.length === 0 && retired.length > 0 && <i className="cn-n">{retired.length} retired</i>}
        <span className="cn-more">
          left to right is dispatch order
          {/* The way to the whole plan, on the card that draws its summary. The
              waves are titles and dependencies; the diagnosis, the map, each part's
              acceptance and what was decided are the sheet's, and it was reachable
              from here only through the validation card's aside about amending the
              checks — a door nobody looking for the plan would think to try. */}
          {plan !== null && (
            <button
              type="button"
              className="cn-linkish"
              title="The plan sheet — the write-up, the shape, each part in full, and the decision that was made on it"
              onClick={() => actions.viewPlan(plan.id)}
            >
              open the full plan ↗
            </button>
          )}
        </span>
      </h3>
      <div className="cn-waves">
        {groups.length === 0 && (
          <p className="cn-empty">
            {page.plan === null
              ? 'No plan has been drawn for this goal.'
              : retired.length > 0
                ? 'Every part of this plan was retired. What it proposed is below.'
                : 'The plan has no live parts.'}
          </p>
        )}
        {groups.map(({ group, parts }) => (
          <div className="cn-col" key={group}>
            <div className="cn-coln">{GROUP_LABEL[group]}</div>
            {parts.map((p) => (
              <Part key={p.part.id} part={p.part} group={p.group} agentId={p.agentId} actions={actions} />
            ))}
          </div>
        ))}
        {retired.length > 0 && (
          <div className="cn-col">
            <div className="cn-coln">Retired</div>
            {retired.map((part) => (
              <Part key={part.id} part={part} group="retired" agentId={null} actions={actions} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One part of the plan.
 *
 * **The agent on it is drawn as a way there, never as its id.** `agent_ab4sc`
 * beside a part named nothing — agent ids are minted and an agent has no name of
 * its own — and the one thing the operator wanted from it, the run's transcript
 * and its controls, was on a surface the row did not lead to. The row already
 * names the part, so the control is a door rather than a second name, and it sits
 * beside the pull-request reference rather than around it: one click cannot have
 * two destinations, so a `<Ref>` is never nested inside a button.
 */
function Part({
  part,
  group,
  agentId,
  actions,
}: {
  part: PlanPart;
  /** The four the page groups by, plus the one that is drawn beside them and counted in none of them. */
  group: PartGroup | 'retired';
  agentId: string | null;
  actions: CockpitActions;
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
        {agentId !== null && (
          <>
            {' · '}
            <button
              type="button"
              className="cn-openagent"
              title="Open the agent working this part — its transcript, what it has cost, and its controls"
              onClick={() => actions.select(agentId)}
            >
              open the agent ↗
            </button>
          </>
        )}
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
/**
 * What the operator has asked for on this goal and no agent has answered yet.
 *
 * **Above the ticket, and it draws nothing when there is nothing standing.** Both
 * halves are deliberate. An instruction outranks the ticket for as long as it
 * stands — it is the newer statement of the same goal — so reading it after the
 * body it amends is reading them in the wrong order. And a card that were always
 * present would be furniture: the empty-state rule the rest of this page follows
 * ("a surface that vanishes when quiet is indistinguishable from one that broke")
 * is about surfaces that answer a standing question, and "has anyone written on
 * this goal" is answered by the header's own control, which is always drawn and
 * counts them.
 *
 * Withdrawing is offered per row because an instruction is free text sent to an
 * agent: a typo, or a mind changed before anything picked it up, needs a way back
 * that is not "wait for an agent to act on it".
 */
function Instructions({ issue, actions }: { issue: Issue; actions: CockpitActions }): JSX.Element | null {
  if (issue.instructions.length === 0) return null;
  return (
    <section className="cn-card">
      <h3>
        What you’ve asked for <span className="cn-more">standing until an agent concludes this goal</span>
      </h3>
      <div className="cn-rows">
        {issue.instructions.map((instruction) => (
          <div className="cn-row" key={instruction.id}>
            <span className="cn-grow">
              <b className="cn-name">{instruction.text}</b>
              <span className="cn-sub">{instruction.createdAt}</span>
            </span>
            <AsyncButton
              className="cn-tgl"
              onClick={() => actions.withdrawInstruction(issue.number, instruction.id)}
              title="Take this back — it stops being sent to the next agent"
            >
              Withdraw
            </AsyncButton>
          </div>
        ))}
      </div>
    </section>
  );
}

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
          // An unwatched PR is drawn spent, the same as a closed one below and as
          // an unwatched goal in the backlog: nothing will happen on it, and a row
          // at full weight says the opposite.
          <div className={`cn-row ${pr.attention.status === 'unwatched' ? 'cn-spent' : ''}`} key={pr.number}>
            <span className="cn-grow">
              <b className="cn-name">
                <Ref to={`pr:${pr.number}`} /> {pr.title}
              </b>
              <span className="cn-sub">{pr.branch}</span>
            </span>
            <CiLadder pr={pr} />
            <CourtChip pr={pr} now={view.now} />
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

/**
 * Where this goal's landed work has got to, one chip per configured environment.
 *
 * Drawn under the pull requests because it is the sentence after them: these
 * merged, and this is where they went. Absent entirely when no environment is
 * configured — a row of question marks on every deployment that never set one up
 * would be a feature announcing itself as broken.
 *
 * The counts are on every chip that is not whole, including `absent`, because
 * "0/3" and "2/3" are the difference between work that has not started moving and
 * work that is halfway there — and the word alone says neither.
 */
function Environments({
  page,
  actions,
  now,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  now: number;
}): JSX.Element | null {
  const [releasing, setReleasing] = useState(false);
  if (page.environments.length === 0) return null;
  const number = page.issue.number;
  return (
    <section className="cn-card">
      <h3>Environments</h3>
      <div className="cn-rows">
        {page.environments.map((env) => (
          <div className="cn-row" key={env.environment}>
            <span className="cn-grow">
              <b className="cn-name">{env.environment}</b>
              <span className="cn-sub">
                {REACH_SAID[env.status]}
                {/* What arriving here does, on the row that would do it. An
                    operator reading a held goal asks "waiting for what" exactly
                    once, and the answer is configuration they wrote weeks ago. */}
                {env.opens.length > 0 && ` · opens ${env.opens.map((g) => GATE_SAID[g]).join(' and ')}`}
              </span>
            </span>
            {env.status !== 'reached' && (
              <i className="cn-n">
                {env.landed}/{env.total}
              </i>
            )}
            <i className={`cn-chip ${REACH_TONE[env.status]}`}>{env.status}</i>
          </div>
        ))}
      </div>
      {/* The hold, said out loud. Nothing is filed while a gate holds, so without
          this line a delivered goal with an empty bench is indistinguishable from
          a finished one — and the harness would be waiting where nobody could see
          it. The control beside it is the escape for work that is never going to
          reach an environment at all. */}
      {page.gateHold !== null && (
        <div className="cn-criteria">
          <p>{page.gateHold}</p>
          <button className="btn ghost" onClick={() => setReleasing(true)}>
            not waiting on an environment
          </button>
        </div>
      )}
      {page.gateRelease !== null && (
        <div className="cn-criteria">
          <p>
            Not waiting on an environment — “{page.gateRelease.note}”
            <span className="cn-sub"> · {relTime(page.gateRelease.releasedAt, now)}</span>
          </p>
          <button className="btn ghost" onClick={() => void actions.releaseEnvironmentGate(number, false)}>
            wait for one after all
          </button>
        </div>
      )}
      {releasing && page.gateHold !== null && (
        <GateReleaseModal
          issueNumber={number}
          issueTitle={page.issue.title}
          hold={page.gateHold}
          onSubmit={(note) => actions.releaseEnvironmentGate(number, true, note)}
          onClose={() => setReleasing(false)}
        />
      )}
    </section>
  );
}

/** What each gate holds, in the words the card's own rows use for it. */
const GATE_SAID: Record<EnvironmentGate, string> = {
  validate: 'the validation checks',
  close_out: 'the close-out',
};

/**
 * No new colours: every tone here is one the cockpit already draws, so the strip
 * follows a theme switch without the token layer having to learn about it.
 *
 * `partial` takes the attention tone rather than a success one deliberately — half
 * a feature in production is the state on this panel most likely to want somebody,
 * and drawing it green is the mistake the whole tri-state exists to avoid.
 */
const REACH_TONE: Record<GoalReachStatus, string> = {
  reached: 'cn-ok',
  partial: 'cn-you',
  unknown: 'cn-stall',
  absent: '',
};

/**
 * What each verdict means, in the words an operator would use asking about it.
 *
 * **Work, not merges.** The fraction counts a plan's unmerged parts too, so a goal
 * three parts short of done reads `1/4` here — and "all of this goal's merges are
 * here" would be true of a row saying `partial`, which is the sentence disagreeing
 * with the count beside it.
 */
const REACH_SAID: Record<GoalReachStatus, string> = {
  reached: 'all of this goal’s work is here',
  partial: 'some of this goal’s work is here',
  absent: 'none of this goal’s work is here yet',
  unknown: 'nothing here could be confirmed — check the probe, not the deploy',
};

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
 * **The age is drawn from the first pulse a pull request is observed waiting.**
 * There was a `reviewReminderMs` threshold here, on the argument that an age on
 * every open pull request says nothing about any — which is a team's problem. One
 * person's queue is short enough to read, and a threshold only hides how long the
 * short queue has been sitting.
 *
 * It stays a *chip*, never a row in "Needs you": nothing is dispatched, escalated
 * or filed at any age — the harness has no more idea than you do how to make a
 * review happen faster.
 */
export function CourtChip({ pr, now }: { pr: OpenPullRequest; now: number }): JSX.Element {
  const since = pr.attention.reviewWaitingSince;
  const waited = since !== undefined ? waitedFor(since, now) : null;
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
 * What the goal has cost, over every agent under it and every local run of it. The whole card is absent
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
        {/* Named separately because the row above says "Agents" and a local run is
            not one. The total already holds its money. */}
        {spend.localRuns > 0 && (
          <div className="cn-kv">
            <span>Local runs</span>
            <b>{spend.localRuns}</b>
          </div>
        )}
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
