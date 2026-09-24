import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { HumanTask, Issue } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { EscalationCard } from '../components/EscalationCard.js';
import { GOAL_ANCHOR, GOAL_TAB_OF } from '../view/goalPage.js';
import { scrollToAnchor } from './jump.js';
import { HumanTaskActions } from '../components/HumanTaskActions.js';
import { renderMarkdown } from '../components/markdown.js';
import { ParentPicker } from '../components/ParentPicker.js';
import { proposedParentTitle } from '../view/orphanGoal.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { Ref } from '../components/refs.js';
import { ValidationSection } from '../components/ValidationSection.js';
import { buildGoalPage, goalIssue } from '../view/goalPage.js';
import { buildPrPage } from '../view/prPage.js';
import { oneLine, refusedDispatchFor } from '../view/needsYou.js';
import { relTime } from '../components/util.js';
import { discussPrompt } from '../cockpit/desktopLink.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, KIND_VERB, holdingLabel } from './QueueRail.js';
import { Button, ButtonRow } from '../components/button.js';

// → docs/spec/17-cockpit.md

export function NeedsBand({
  row,
  view,
  actions,
  checksBelow = false,
  line = false,
}: {
  row: NeedRow;
  view: CockpitView;
  actions: CockpitActions;
  /** This band is drawn on the goal page, whose Checks pane holds the same rows. */
  checksBelow?: boolean;
  /**
   * Draw the ask as one row rather than the whole thing, pressing it open in the
   * ask panel. It is what the goal page gives every ask it carries: a band
   * between the navigation and the pane it selects leaves the two reading as
   * unrelated surfaces, and three hundred pixels of band is what put the pane's
   * own content below the fold.
   * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
   */
  line?: boolean;
}): JSX.Element | null {
  const body = needBody(row, view, actions, checksBelow);
  if (body === null) return null;
  if (line) {
    return (
      <button
        type="button"
        className={`cn-needs-line cn-t-${KIND_TONE[row.kind]}`}
        onClick={() => actions.openPanel({ ask: row.id })}
        title="Open this ask"
      >
        <span className="cn-sym" aria-hidden="true">
          {KIND_SYMBOL[row.kind]}
        </span>
        <span className="cn-needs-kind">{KIND_LABEL[row.kind]}</span>
        <span className="cn-needs-what">{oneLine(row.title)}</span>
        <span className="cn-age">
          {row.raisedAt !== '' && relTime(row.raisedAt, view.now)}
          {row.holding > 0 && ` · ${holdingLabel(row.holding)}`}
        </span>
        {/* The verb, drawn as the press it is. A faint "Open" beside a pane's own
            filled primary is a row that loses the page to the one control on it
            that nothing is waiting on. It is a span rather than a button because
            the row *is* the button — nesting a second one is invalid.
            → docs/spec/17-cockpit.md#an-ask-is-the-loudest-thing-on-its-page */}
        <span className="cn-needs-do">{KIND_VERB[row.kind]}</span>
      </button>
    );
  }
  return (
    <div className={`cn-needs cn-t-${KIND_TONE[row.kind]}`}>
      <header>
        <span className="cn-sym" aria-hidden="true">
          {KIND_SYMBOL[row.kind]}
        </span>
        Needs you · {KIND_LABEL[row.kind]}
        <span className="cn-age">
          {row.raisedAt !== '' && relTime(row.raisedAt, view.now)}
          {row.holding > 0 && ` · ${holdingLabel(row.holding)}`}
        </span>
        {/* The same ask, alone and in front — for a goal carrying several, or a
            page scrolled past this one. It is the panel the rail opens for an ask
            with no goal page, drawn from the same `needBody`, so there is one
            implementation of the ask and two ways to reach it rather than two
            asks. */}
        <button type="button" className="cn-open" onClick={() => actions.openPanel({ ask: row.id })}>
          Open
        </button>
      </header>
      <div className="cn-in">{body}</div>
    </div>
  );
}

function noteOwedOnDone(task: HumanTask, view: CockpitView): string | null {
  if (task.kind !== 'close_out' || task.status !== 'open' || task.originRef === null) return null;
  const issue = goalIssue(view.state, task.originRef);
  if (issue?.validation?.state !== 'flagged') return null;
  return 'Validation is not clear on this goal — the checks listed above are outstanding. Closing it out is still yours to do; what it costs is a sentence saying what you are doing about them, or waiving them first.';
}

function closeTicketFor(task: HumanTask, view: CockpitView): boolean {
  if (task.kind !== 'close_out' || task.status !== 'open') return false;
  if (task.originRef === null || !/^issue:\d+$/.test(task.originRef)) return false;
  return view.state.config.canCloseIssue;
}

/**
 * What answers this ask — the shared component that owns its verdict. `look` is
 * the one seam a station passes, [`Button`](../components/button.tsx)'s own props.
 *
 * Null means the row's source is no longer in the snapshot, which is also how the
 * ask panel closes itself.
 *
 * @public shared with the ask panel, which draws the body under its own header
 */
const LIVE_AGENT: readonly string[] = ['starting', 'running', 'waiting'];

/**
 * The rung above the one a flagged run is on, or null where there is none to
 * offer — no profiles configured, an unpinned run, the deepest profile already,
 * or a run that has since ended.
 */
function liftTargetFor(task: HumanTask, view: CockpitView): string | null {
  if (task.agentId === null) return null;
  const agent = view.state.agents.find((a) => a.id === task.agentId);
  if (agent === undefined || !LIVE_AGENT.includes(agent.status)) return null;
  const profile = view.state.tasks.find((t) => t.id === agent.taskId)?.profile ?? null;
  if (profile === null) return null;
  const ladder = view.state.config.profiles.map((p) => p.name);
  const at = ladder.indexOf(profile);
  return at < 0 || at + 1 >= ladder.length ? null : (ladder[at + 1] ?? null);
}

export function needBody(row: NeedRow, view: CockpitView, actions: CockpitActions, checksBelow = false): ReactNode {
  if (row.kind === 'watch') {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    return <WatchFinding task={task} view={view} actions={actions} />;
  }
  if (row.kind === 'validate') {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    return <ValidateAsk task={task} view={view} actions={actions} checksBelow={checksBelow} />;
  }
  if (row.kind === 'close_out') {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    return <CloseOutAsk task={task} view={view} actions={actions} checksBelow={checksBelow} />;
  }
  if (row.kind === 'supply') {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    return <SupplyAsk task={task} view={view} actions={actions} />;
  }
  if (row.kind === 'bench' || row.kind === 'burn') {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    const liftTo = row.kind === 'burn' ? liftTargetFor(task, view) : null;
    const liftAgentId = task.agentId;
    return (
      <>
        <p className="cn-lede">{task.title}</p>
        {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
        {liftTo !== null && liftAgentId !== null && (
          <ButtonRow>
            <AsyncButton
              tone="primary"
              onClick={() => actions.liftAgentProfile(liftAgentId, liftTo)}
              title={`Stop this run where it stands and hand the same task to “${liftTo}”`}
            >
              Lift to “{liftTo}”
            </AsyncButton>
          </ButtonRow>
        )}
        <HumanTaskActions
          task={task}
          look={{ tone: 'secondary' }}
          noteOnDone={noteOwedOnDone(task, view)}
          onDone={(id, note) => actions.completeHumanTask(id, note)}
          onDecline={(id, note) => actions.declineHumanTask(id, note)}
          onCloseTicket={closeTicketFor(task, view) ? (id, note) => actions.closeHumanTaskTicket(id, note) : null}
        />
      </>
    );
  }
  if (row.kind === 'intake') {
    const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
    const appraisal = issue?.appraisal;
    if (!issue || appraisal?.verdict !== 'unclear') return null;
    return (
      <>
        <p>
          <strong>The goal appraisal could not say this is workable</strong> — nothing is dispatched for it until the
          verdict moves.
        </p>
        <p className="cn-tick">“{appraisal.summary}”</p>
        {appraisal.missing.length > 0 && (
          <ul className="cn-tick">
            {appraisal.missing.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        )}
        <p className="cn-tick">
          The hold clears by itself when the goal&rsquo;s own text changes, so answering those on the ticket is the
          other way out and costs no click here. Overriding says the brief is good enough as it stands.
        </p>
        <ButtonRow bar>
          <AsyncButton
            tone="primary"
            onClick={() => actions.setIssueAppraisal(issue.number, 'workable')}
            title="Work it anyway — the harness stops holding pickup and runs a cycle now"
          >
            Override → workable
          </AsyncButton>
          <DesktopLink
            folder={view.state.config.desktopFolder}
            prompt={discussPrompt(issue.number)}
            explain="so the gaps are talked through with a session that can rewrite the ticket — the hold stands until the goal's text changes or you override it here."
          />
        </ButtonRow>
      </>
    );
  }
  if (row.kind === 'profile') {
    const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
    const appraisal = issue?.appraisal;
    if (!issue || !appraisal?.awaitingProfileAnswer || appraisal.proposedProfile === null) return null;
    const { config } = view.state;
    const proposed = appraisal.proposedProfile;
    const pinned = issue.modelPin.profile;
    const standing = pinned ?? config.defaultProfile;
    const described = config.profiles.find((p) => p.name === proposed)?.description;
    return (
      <>
        <p>
          <strong>The goal appraisal wants this run on “{proposed}”</strong>
          {standing !== null &&
            ` — ${pinned === null ? 'it would otherwise run on' : 'you pinned it to'} “${standing}”`}
          {standing === null && ' — nothing is pinned to it yet'}
        </p>
        <p className="cn-tick">
          {described ?? appraisal.summary} Nothing is dispatched for this goal until you say which to use — that is one
          click either way, and it is not a rejection.
        </p>
        <ButtonRow bar>
          <AsyncButton
            tone="primary"
            onClick={() => actions.setIssueProfile(issue.number, proposed)}
            title={`Pin this goal to “${proposed}” and let the funnel move`}
          >
            Use “{proposed}”
          </AsyncButton>
          <AsyncButton
            onClick={() => actions.setIssueProfile(issue.number, pinned)}
            title={
              pinned === null
                ? 'Leave this goal unpinned, so each rule runs on its own profile'
                : `Keep “${pinned}” and let the funnel move`
            }
          >
            {pinned === null ? 'Leave it unpinned' : `Keep “${pinned}”`}
          </AsyncButton>
        </ButtonRow>
      </>
    );
  }
  if (row.kind === 'placement') {
    const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
    const ask = (issue?.appraisal?.placement ?? []).find((p) => `placement:${p.field}:${row.goalRef}` === row.id);
    if (!issue || !ask) return null;
    return ask.field === 'parent' ? (
      <ParentAsk issue={issue} proposed={ask.proposedParent} view={view} actions={actions} />
    ) : (
      <AreaPathAsk issue={issue} proposed={ask.proposedAreaPath} view={view} actions={actions} />
    );
  }
  if (row.kind === 'limit') {
    const agent = row.agentId ? view.agentById.get(row.agentId) : undefined;
    if (!agent || !view.limitParked.has(agent.id)) return null;
    return (
      <>
        <p>{agent.waitingReason ?? 'This account has no usage allowance left right now.'}</p>
        <p className="cn-tick">
          Nothing failed and nothing is lost: the branch, the worktree and the conversation are as the agent left them.
          Resuming re-opens that conversation where it stopped.
        </p>
        <ButtonRow bar>
          <AsyncButton tone="primary" onClick={() => actions.resumeAgent(agent.id)} pendingLabel="Resuming…">
            Resume
          </AsyncButton>
          <Button onClick={() => actions.select(agent.id)}>Open transcript</Button>
        </ButtonRow>
      </>
    );
  }
  if (row.kind === 'assigned') {
    const number = Number(/^assigned:pr:(\d+)$/.exec(row.id)?.[1]);
    const pr = view.state.world.pullRequests.find((p) => p.number === number);
    if (!pr) return null;
    /* The threads waiting on a reply, because that is what somebody assigning a
       pull request to you is usually asking for, and a count of them is the one
       fact that says how much of an evening this is. Drawn through `buildPrPage`,
       the pull request page's own reading, so the two cannot disagree about which
       thread is still open.
       → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work */
    const page = buildPrPage(view.state, pr.number);
    const waiting = (page?.threads ?? []).filter((t) => t.state === 'open' || t.state === 'reopened');
    return (
      <>
        <p>
          <strong>{pr.title}</strong>
        </p>
        {/* One reason per line, not joined: they are separate facts about why this
            is in front of you — who put it there, what the harness is not doing
            about it — and a `·` between them reads as one sentence nobody wrote. */}
        {(pr.attention?.reasons ?? []).length > 0 && (
          <ul className="cn-tick cn-ask-why">
            {(pr.attention?.reasons ?? []).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        {waiting.length > 0 && (
          <ul className="cn-ask-threads">
            {waiting.slice(0, THREADS_SHOWN).map((thread) => (
              <li key={thread.id}>
                <b>{thread.author}</b>
                <span className="cn-grow">{oneLine(thread.body)}</span>
                {thread.path !== undefined && <i className="cn-n">{thread.path}</i>}
              </li>
            ))}
            {waiting.length > THREADS_SHOWN && (
              <li className="cn-ask-supply-rest">{waiting.length - THREADS_SHOWN} more waiting on the pull request.</li>
            )}
          </ul>
        )}
        <p className="cn-tick">
          Nothing in the harness will act on this. It is here because somebody put it on you where the fleet cannot see
          it, and it stops being drawn the moment they take it off you again.
        </p>
        <div className="cn-refs">
          <Ref to={`pr:${pr.number}`} title="Open the pull request" />
        </div>
      </>
    );
  }
  if (row.kind === 'describe') {
    const waiting = (view.state.undescribedParts ?? []).find((p) => `describe:${p.originRef}` === row.id);
    if (waiting === undefined) return null;
    const part = (view.state.planParts ?? []).find((p) => waiting.originRef.endsWith(`:part:${p.slug}`));
    return (
      <>
        {part !== undefined && (
          <p>
            <strong>{part.title}</strong>
          </p>
        )}
        <p className="cn-tick">
          The pull request is open and carries the agent&rsquo;s evidence and the reference, and nothing else. Nothing
          fills the gap and nothing is held up by it — the reviewer simply meets a change with nobody&rsquo;s account of
          it above the coordinates.
        </p>
        <p className="cn-tick">
          Read the change first, then write it in your own words on the pull request&rsquo;s own page — what you write
          goes to the top of its body.
        </p>
        {/* The act, not just the situation, and it lands on the page the field is on.
            → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written */}
        <ButtonRow>
          <Button
            tone="primary"
            onClick={() => {
              actions.openPanel(null);
              actions.selectPr(waiting.prNumber);
            }}
          >
            Describe it
          </Button>
        </ButtonRow>
        <div className="cn-refs">
          <Ref to={`pr:${waiting.prNumber}`} title="Read the change you are describing" />
        </div>
      </>
    );
  }
  if (row.kind === 'description_wrong' || row.kind === 'description_note') {
    const feedback = (view.state.descriptionFeedback ?? []).find((f) => `description:${f.versionId}` === row.id);
    if (feedback === undefined) return null;
    return (
      <>
        <p className="cn-tick">
          {row.kind === 'description_wrong'
            ? 'An agent read your description against the diff and found it saying something the change does not do. Worth fixing before a reviewer meets it.'
            : 'An agent read your description against the diff. Nothing in it is wrong, but the change does something a reviewer may want told. Yours to take or leave.'}
        </p>
        {/* → docs/spec/07-pull-requests.md#what-the-check-raises */}
        <ButtonRow>
          <Button
            tone="primary"
            onClick={() => {
              actions.openPanel(null);
              actions.selectPr(feedback.prNumber);
            }}
          >
            Read what it found
          </Button>
        </ButtonRow>
        <div className="cn-refs">
          <Ref to={`pr:${feedback.prNumber}`} title="Open the pull request" />
        </div>
      </>
    );
  }
  if (row.kind === 'dispatch') {
    const refusal = refusedDispatchFor(view.state, row.id);
    if (!refusal) return null;
    const rule = refusal.rule === null ? undefined : view.state.dispatchRules[refusal.rule];
    return (
      <>
        <p>
          <strong>
            Nothing has dispatched for this since {relTime(refusal.since, view.now)} — {refusal.pulses} pulses, each
            refused.
          </strong>
        </p>
        <p className="cn-tick">{refusal.detail}</p>
        <p className="cn-tick">
          The harness is proposing it again on every pulse and will go on doing so; it is not paused, and nothing about
          it is retried differently. Clearing what the refusal names is the whole of the fix.
          {rule && ` The rule proposing it is “${rule.name}”.`}
        </p>
        {refusal.originRef !== null && (
          <div className="cn-refs">
            <Ref to={refusal.originRef} title="Open what the refused dispatch is about" />
          </div>
        )}
      </>
    );
  }
  const escalation = view.state.escalations.find((e) => e.id === row.id);
  if (!escalation) return null;
  /* `PlanView.revealed` is the server's fact about whether the plan behind this ask
     is on the wire at all, and the card holds no plans of its own. Without it the
     card draws four answers the routes refuse. → docs/spec/17-cockpit.md#the-reveal-gate */
  const planId = typeof escalation.context.planId === 'string' ? escalation.context.planId : null;
  const withheld = planId !== null && (view.state.plans ?? []).some((p) => p.id === planId && !p.revealed);
  const goalRef = row.goalRef;
  return (
    <EscalationCard
      escalation={escalation}
      withheld={withheld}
      {...(goalRef === null
        ? {}
        : {
            /* Both halves, and the second is not decoration: pressed from the goal
               page the ask is already on, the navigation is a no-op and the card
               reads as a control that does nothing — the gate is further down the
               same page. → docs/spec/17-cockpit.md#the-reveal-gate */
            onReveal: () => {
              actions.openGoalPrediction(goalRef);
              scrollToAnchor(GOAL_ANCHOR.plan);
            },
          })}
      proposal={view.proposalFor.get(escalation.id)}
      resumedAt={escalation.agentId ? (view.agentById.get(escalation.agentId)?.resumedAt ?? null) : null}
      now={view.now}
      refUrls={view.state.refUrls}
      desktopFolder={view.state.config.desktopFolder}
      onAnswer={(text) => actions.answerEscalation(escalation.id, text)}
      onAnswerQuestions={(answers) => actions.answerQuestions(escalation.id, answers)}
      onDecide={(id, verdict, note, acknowledged, answers, declined) =>
        actions.decideProposal(id, verdict, note, acknowledged, answers, declined)
      }
      onBackOut={(id, verdict, note) => actions.backOutProposal(id, verdict, note)}
      onOverrule={(issueNumber, proposalId, text) => actions.overruleShortfall(issueNumber, proposalId, text)}
      onPermission={(id, allow, note) => actions.decidePermission(id, allow, note)}
      onDismiss={(id, note) => actions.dismissEscalation(id, note)}
      onOpenAgent={(id) => actions.select(id)}
      onComplete={(id) => actions.completeAgent(id)}
      stallExpiresAt={escalation.agentId ? (view.stallExpiryByAgent.get(escalation.agentId) ?? null) : null}
      onExtend={(id) => actions.extendStall(id)}
      onViewPlan={(id) => actions.viewPlan(id)}
    />
  );
}

/**
 * The bench row that asks for the goal's checks, drawn as the checks themselves.
 *
 * Every other ask on this surface is answered by the ask: a verdict, a pick, a
 * sentence. This one is answered somewhere else — somebody runs the checks and
 * records what they saw — so a body that only names them is a page that tells the
 * operator to go and find the work, on the one surface whose whole argument is
 * that the thing to do is in front of you.
 *
 * The desk's prose stays above the rows. It is its own refreshed statement of what
 * the goal owes — the sheet assembled for an environment, the ticket's link — and
 * it is what the row says everywhere the rows are not in front of the reader.
 * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
 */
function ValidateAsk({
  task,
  view,
  actions,
  checksBelow,
}: {
  task: HumanTask;
  view: CockpitView;
  actions: CockpitActions;
  checksBelow: boolean;
}): JSX.Element {
  return (
    <>
      <p className="cn-lede">{task.title}</p>
      {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
      <GoalChecks originRef={task.originRef} view={view} actions={actions} checksBelow={checksBelow} />
      <HumanTaskActions
        task={task}
        look={{ tone: 'secondary' }}
        noteOnDone={null}
        onDone={(id, note) => actions.completeHumanTask(id, note)}
        onDecline={(id, note) => actions.declineHumanTask(id, note)}
        onCloseTicket={null}
      />
    </>
  );
}

/**
 * The ask that says the goal is delivered and its ticket is still open.
 *
 * The decision it asks for is *what to do about the checks*: the desk's own note
 * on `Done` says so in as many words — closing a goal whose validation is flagged
 * costs a sentence about the outstanding ones, or waiving them first. It said it
 * about a list drawn as prose. So the rows come with it, and both answers the note
 * offers are controls on this page rather than a trip to the goal.
 * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
 */
function CloseOutAsk({
  task,
  view,
  actions,
  checksBelow,
}: {
  task: HumanTask;
  view: CockpitView;
  actions: CockpitActions;
  checksBelow: boolean;
}): JSX.Element {
  return (
    <>
      <p className="cn-lede">{task.title}</p>
      {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
      <GoalChecks originRef={task.originRef} view={view} actions={actions} checksBelow={checksBelow} />
      <HumanTaskActions
        task={task}
        look={{ tone: 'secondary' }}
        noteOnDone={noteOwedOnDone(task, view)}
        onDone={(id, note) => actions.completeHumanTask(id, note)}
        onDecline={(id, note) => actions.declineHumanTask(id, note)}
        onCloseTicket={closeTicketFor(task, view) ? (id, note) => actions.closeHumanTaskTicket(id, note) : null}
      />
    </>
  );
}

/**
 * A goal's validation checks, drawn inside the ask that is about them, from the
 * same {@link ValidationSection} the goal page manages them with — the steps, the
 * resources and the four readings — with every check still owed already open.
 *
 * Two asks share it because the same rows answer both questions. `validate` asks
 * for the readings; `close_out` asks what closing the goal does about the ones
 * nobody took. A body that only names them is an ask that tells the operator to go
 * and find the work, which on "One ask at a time" is the whole surface arguing
 * against itself.
 *
 * Nothing where the snapshot holds no live check for the goal: a row filed against
 * a goal whose checks this cockpit cannot see is still a row somebody has to
 * settle, and the desk's prose above is what it says then.
 *
 * **Except on the goal page**, which `checksBelow` says this band is on. The rule is
 * about reaching the work from where the ask is read, and on the rail or in the panel
 * that means drawing it; there it means the opposite, because the rows are a pane
 * away already. Two live copies of one control, one of them above the tab row and
 * pushing it off the screen, is the ask drawing the page it is standing on. So there
 * the band says how many and offers the way to them — and counts off the snapshot
 * rather than building the whole goal page to do it.
 * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
 */
function GoalChecks({
  originRef,
  view,
  actions,
  checksBelow,
}: {
  originRef: string | null;
  view: CockpitView;
  actions: CockpitActions;
  checksBelow: boolean;
}): JSX.Element | null {
  const number = Number(/^issue:(\d+)$/.exec(originRef ?? '')?.[1]);
  if (originRef === null || !Number.isFinite(number)) return null;
  if (checksBelow) {
    const live = (view.state.validationChecks ?? []).filter(
      (c) => c.originRef === originRef && c.supersededReason === null,
    );
    if (live.length === 0) return null;
    return (
      <button
        type="button"
        className="cn-ask-checks-to"
        onClick={() => {
          /* All three, in the order `buildJump` does them: the pane, then the card's
             own fold, then the scroll two frames later. A jump that skipped the fold
             would land on a heading and read as a control that did nothing.
             → docs/spec/17-cockpit.md#folding-what-is-not-relevant-yet */
          actions.openGoalTab(GOAL_TAB_OF.validation);
          actions.openGoalSection('validation', true);
          scrollToAnchor(GOAL_ANCHOR.validation);
        }}
      >
        {live.length === 1 ? 'The 1 check this asks about is' : `The ${live.length} checks this asks about are`} under
        Checks, below — go to them
      </button>
    );
  }
  const page = buildGoalPage(view.state, originRef, view.needsYou, null);
  const live = (page?.checks ?? []).filter((c) => c.supersededReason === null);
  if (page === null || live.length === 0) return null;
  return (
    <div className="cn-ask-checks">
      <ValidationSection
        checks={page.checks}
        plan={page.checkPlan}
        issueNumber={number}
        resources={page.checkResources}
        refUrls={view.state.refUrls}
        desktopFolder={view.state.config.desktopFolder}
        look={{ tone: 'secondary' }}
        onResult={(checkId, result, note) => actions.setValidation(number, checkId, { kind: 'result', result, note })}
        onWaive={(checkId, reason) => actions.setValidation(number, checkId, { kind: 'waive', reason })}
        onReset={(checkId) => actions.setValidation(number, checkId, { kind: 'reset' })}
        onHandover={(checkId, to) => actions.setValidation(number, checkId, { kind: 'handover', to })}
      />
    </div>
  );
}

/**
 * The runway ask: the fleet has slots and nothing eligible to put in them.
 *
 * What it asks for is that somebody put work in play, and the prose said how much
 * — "N open issues nobody has watched" — without saying *which*, which leaves the
 * only ask on this surface whose answer is a trip to another tab and a search.
 * So the issues themselves are drawn, each with the watch control the tickets
 * board uses, and the ask is answered where it is read.
 *
 * **The list is the server's own verdict, never a label read here.** An issue is
 * unwatched because `issue.pickup.status` says so — the same status the runway
 * reading counts, off the same pickup context — and not because the cockpit went
 * looking for the watch label: the label alone ignores `ownWorkOnly` and the
 * precedence a paused or delivered goal takes, so a list derived that way would
 * name issues the count behind it never counted.
 * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
 */
function SupplyAsk({
  task,
  view,
  actions,
}: {
  task: HumanTask;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const unwatched = view.state.world.issues.filter((i) => i.pickup.status === 'unwatched');
  const showing = unwatched.slice(0, SUPPLY_SHOWN);
  return (
    <>
      <p className="cn-lede">{task.title}</p>
      {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
      {showing.length > 0 && (
        <ul className="cn-ask-supply">
          {showing.map((issue) => (
            <li key={issue.number}>
              <span className="cn-grow">{issue.title}</span>
              <span className="cn-refs">
                <Ref to={`issue:${issue.number}`} title="Open the item on the tracker" />
              </span>
              <AsyncButton
                tone="secondary"
                onClick={() => actions.setIssueWatched(issue.number, true)}
                title="Put this in play — the harness picks it up on the next pulse"
              >
                Watch
              </AsyncButton>
            </li>
          ))}
          {unwatched.length > showing.length && (
            <li className="cn-ask-supply-rest">
              {unwatched.length - showing.length} more on the tickets tab, where they can be sorted and filtered.
            </li>
          )}
        </ul>
      )}
      <HumanTaskActions
        task={task}
        look={{ tone: 'secondary' }}
        noteOnDone={null}
        onDone={(id, note) => actions.completeHumanTask(id, note)}
        onDecline={(id, note) => actions.declineHumanTask(id, note)}
        onCloseTicket={null}
      />
    </>
  );
}

/** How many unwatched items the runway ask draws before it points at the tickets tab. */
const SUPPLY_SHOWN = 8;

/** How many waiting threads the assigned-pull-request ask draws before it points at the pull request. */
const THREADS_SHOWN = 5;

function WatchFinding({
  task,
  view,
  actions,
}: {
  task: HumanTask;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const [raising, setRaising] = useState(false);
  const number = Number(/^issue:(\d+)$/.exec(task.originRef ?? '')?.[1]);
  const issue = Number.isFinite(number) ? view.state.world.issues.find((i) => i.number === number) : undefined;
  const canRaise = issue !== undefined && view.state.config.canFileTickets;
  return (
    <>
      <p className="cn-lede">{task.title}</p>
      {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
      <HumanTaskActions
        task={task}
        look={{ tone: 'secondary' }}
        noteOnDone={null}
        onDone={(id, note) => actions.completeHumanTask(id, note)}
        onDecline={(id, note) => actions.declineHumanTask(id, note)}
        onCloseTicket={null}
        extra={
          canRaise ? (
            <Button
              tone="secondary"
              onClick={() => setRaising(true)}
              title="Raise a bug from this reading — the numbers ride as your own report, and the bug is related back to this goal"
            >
              Raise a bug…
            </Button>
          ) : null
        }
      />
      {raising && issue && (
        <RaiseBugModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          initialSummary={task.detail ?? task.title}
          onSubmit={(summary, title) => actions.raiseBug(issue.number, summary, title)}
          onClose={() => setRaising(false)}
        />
      )}
    </>
  );
}

function ParentAsk({
  issue,
  proposed,
  view,
  actions,
}: {
  issue: Issue;
  proposed: number | null;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const containerTitle = proposedParentTitle(view.state, proposed);
  return (
    <>
      {proposed === null ? (
        <p>
          <strong>This goal rolls up to nothing.</strong> Nothing has been suggested for it.
        </p>
      ) : (
        <p>
          <strong>This goal rolls up to nothing.</strong> The appraisal suggests{' '}
          {containerTitle === null ? `work item #${proposed}` : `“${containerTitle}”`}.
          <span className="cn-refs">
            <Ref to={`issue:${proposed}`} title="Open the suggested parent and check it before you accept it" />
          </span>
        </p>
      )}
      <p className="cn-tick">
        Nothing is held up by this: the work is dispatched, done and merged either way. What is missing is the item’s
        place on the backlog — unparented, it rolls up to nothing and whoever plans the work cannot see it.
      </p>
      <ParentPicker issue={issue} proposed={proposed} view={view} actions={actions} />
    </>
  );
}

function AreaPathAsk({
  issue,
  proposed,
  view,
  actions,
}: {
  issue: Issue;
  proposed: string | null;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const [chosen, setChosen] = useState<string>('');
  if (proposed === null) return null;
  const options = view.state.config.areaPaths.filter((p) => p !== proposed);
  return (
    <>
      <p>
        <strong>This goal is on no team’s board.</strong> The appraisal suggests the area “{proposed}”.
      </p>
      <p className="cn-tick">
        It is still on the project root, which is where an item nobody has filed sits. Nothing is held up — the work
        happens either way — but until it is filed it is on nobody’s board.
      </p>
      <ButtonRow bar>
        <AsyncButton
          tone="primary"
          onClick={() => actions.setIssueAreaPath(issue.number, proposed)}
          title={`File this goal under “${proposed}”`}
        >
          Use “{proposed}”
        </AsyncButton>
        {options.length > 0 && (
          <>
            <select
              className="cn-in"
              value={chosen}
              aria-label="A different area path"
              onChange={(e) => setChosen(e.currentTarget.value)}
            >
              <option value="">Choose another…</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <AsyncButton
              disabled={chosen === ''}
              onClick={() => actions.setIssueAreaPath(issue.number, chosen)}
              title="File this goal under the area you picked"
            >
              Use that one
            </AsyncButton>
          </>
        )}
        <AsyncButton
          onClick={() => actions.setIssueAreaPath(issue.number, null)}
          title="This goal wants no area path — stop asking"
        >
          Not applicable
        </AsyncButton>
      </ButtonRow>
    </>
  );
}
