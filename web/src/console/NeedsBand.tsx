import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { Issue } from '../types.js';
import { AsyncButton, useAsyncAction } from '../components/AsyncButton.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { EscalationCard } from '../components/EscalationCard.js';
import { GOAL_ANCHOR } from '../view/goalPage.js';
import { scrollToAnchor } from './jump.js';
import { Ref } from '../components/refs.js';
import { goalIssue } from '../view/goalRefs.js';
import { buildPrPage } from '../view/prPage.js';
import { oneLine } from '../view/needLines.js';
import { refusedDispatchFor } from '../view/refusedDispatches.js';
import { relTime } from '../components/util.js';
import { discussPrompt } from '../cockpit/desktopLink.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, KIND_VERB, holdingLabel } from './QueueRail.js';
import { Button, ButtonRow } from '../components/button.js';
import { taskBody } from './taskAsks.js';
import { placementBody } from './placementAsks.js';
import { quickAnswer } from '../view/quickAnswer.js';
import { awaitedProfile } from '../view/issueAsks.js';
import type { QuickAnswer } from '../view/quickAnswer.js';

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
    const quick = quickAnswer(row, view.state);
    if (quick !== null) return <QuickLine row={row} quick={quick} view={view} actions={actions} />;
    return (
      <button
        type="button"
        className={`cn-needs-line cn-t-${KIND_TONE[row.kind]}`}
        onClick={() => actions.openPanel({ ask: row.id })}
        title="Open this ask"
      >
        <LineFace row={row} now={view.now} />
        {/* The verb, drawn as the press it is. A faint "Open" beside a pane's own
            filled primary is a row that loses the page to the one control on it
            that nothing is waiting on. It is a span rather than a button because
            the row *is* the button — nesting a second one is invalid.
            → docs/spec/17-cockpit.md#an-ask-is-the-loudest-thing-on-its-page */}
        <span className="cn-needs-do">{row.verb ?? KIND_VERB[row.kind]}</span>
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
        <NeedAge row={row} now={view.now} />
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

function LineFace({ row, now }: { row: NeedRow; now: number }): JSX.Element {
  return (
    <>
      <span className="cn-sym" aria-hidden="true">
        {KIND_SYMBOL[row.kind]}
      </span>
      <span className="cn-needs-kind">{KIND_LABEL[row.kind]}</span>
      <span className="cn-needs-what">{oneLine(row.title)}</span>
      <NeedAge row={row} now={now} />
    </>
  );
}

function applyQuick(quick: QuickAnswer, value: string, actions: CockpitActions): Promise<void> {
  return quick.field === 'profile'
    ? actions.setIssueProfile(quick.issue, value)
    : actions.setIssueAreaPath(quick.issue, value);
}

function QuickLine({
  row,
  quick,
  view,
  actions,
}: {
  row: NeedRow;
  quick: QuickAnswer;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const change = useAsyncAction();
  return (
    <div className={`cn-needs-line cn-needs-quick cn-t-${KIND_TONE[row.kind]}`}>
      <button
        type="button"
        className="cn-needs-open"
        onClick={() => actions.openPanel({ ask: row.id })}
        title="Open this ask"
      >
        <LineFace row={row} now={view.now} />
      </button>
      <AsyncButton
        size="small"
        tone="primary"
        onClick={() => applyQuick(quick, quick.proposed, actions)}
        title={`Use the proposed answer, “${quick.proposed}”`}
      >
        ✓ {quick.proposed}
      </AsyncButton>
      {quick.others.length > 0 && (
        <select
          className="cn-in cn-needs-change"
          value=""
          aria-label="Answer with something else"
          title={change.refusal ?? 'Answer with something else'}
          disabled={change.phase === 'pending'}
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (value !== '') void change.run(() => applyQuick(quick, value, actions));
          }}
        >
          <option value="">Change…</option>
          {quick.others.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function NeedAge({ row, now }: { row: NeedRow; now: number }): JSX.Element {
  return (
    <span className="cn-age">
      {row.raisedAt !== '' && relTime(row.raisedAt, now)}
      {row.holding > 0 && ` · ${holdingLabel(row.holding)}`}
    </span>
  );
}

type BodyOf = (row: NeedRow, view: CockpitView, actions: CockpitActions, checksBelow: boolean) => ReactNode;

const BODY_OF: Partial<Record<NeedRow['kind'], BodyOf>> = {
  watch: taskBody,
  validate: taskBody,
  close_out: taskBody,
  supply: taskBody,
  bench: taskBody,
  burn: taskBody,
  intake: intakeBody,
  profile: profileBody,
  placement: placementBody,
  limit: limitBody,
  assigned: assignedBody,
  assign: assignBody,
  describe: describeBody,
  description_wrong: descriptionFeedbackBody,
  description_note: descriptionFeedbackBody,
  dispatch: dispatchBody,
};

/**
 * What answers this ask — the shared component that owns its verdict. `look` is
 * the one seam a station passes, [`Button`](../components/button.tsx)'s own props.
 *
 * Null means the row's source is no longer in the snapshot, which is also how the
 * ask panel closes itself.
 *
 * @public shared with the ask panel, which draws the body under its own header
 */
export function needBody(row: NeedRow, view: CockpitView, actions: CockpitActions, checksBelow = false): ReactNode {
  return (BODY_OF[row.kind] ?? escalationBody)(row, view, actions, checksBelow);
}

function rowIssue(row: NeedRow, view: CockpitView): Issue | undefined {
  return row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
}

function intakeBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const issue = rowIssue(row, view);
  const appraisal = issue?.appraisal;
  if (!issue || appraisal?.verdict !== 'unclear') return null;
  return (
    <>
      <p>
        <strong>The goal appraisal could not say this is workable</strong> — nothing is dispatched for it until the
        verdict moves.
      </p>
      <p className="cn-tick">“{appraisal.summary}”</p>
      <Lines items={appraisal.missing} className="cn-tick" />
      <p className="cn-tick">
        The hold clears by itself when the goal&rsquo;s own text changes, so answering those on the ticket is the other
        way out and costs no click here. Overriding says the brief is good enough as it stands.
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

function profileBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const issue = rowIssue(row, view);
  const appraisal = issue?.appraisal;
  const proposed = issue === undefined ? null : awaitedProfile(issue);
  if (!issue || !appraisal || proposed === null) return null;
  const { config } = view.state;
  const pinned = issue.modelPin.profile;
  const standing = pinned ?? config.defaultProfile;
  const described = config.profiles.find((p) => p.name === proposed)?.description;
  return (
    <>
      <p>
        <strong>The goal appraisal wants this run on “{proposed}”</strong>
        {standing !== null && ` — ${pinned === null ? 'it would otherwise run on' : 'you pinned it to'} “${standing}”`}
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

function limitBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
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

function assignedBody(row: NeedRow, view: CockpitView): ReactNode {
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
      <Lines items={pr.attention?.reasons ?? []} className="cn-tick cn-ask-why" />
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
      <RefLine to={`pr:${pr.number}`} title="Open the pull request" />
    </>
  );
}

function describeBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
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
      <PrPress
        prNumber={waiting.prNumber}
        label="Describe it"
        refTitle="Read the change you are describing"
        actions={actions}
      />
    </>
  );
}

/**
 * Every person on the shortlist and "Nah" are drawn alike, so declining costs no more than
 * picking. → docs/spec/07-pull-requests.md#asking-who-should-look-at-it
 */
function assignBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const pr = view.state.world.pullRequests.find((p) => `assign:pr:${p.number}` === row.id);
  if (pr?.assignAsk === undefined) return null;
  return (
    <>
      <p className="cn-tick">
        The fleet is done with <Ref to={`pr:${pr.number}`} /> and nobody is on it. Put someone on it in the tracker?
      </p>
      <ButtonRow bar>
        {pr.assignAsk.map((person) => (
          <AsyncButton
            key={person.id}
            size="small"
            onClick={() => actions.assignPr(pr.number, person.id)}
            title={`Assign ${person.name} in the tracker`}
          >
            {person.name}
          </AsyncButton>
        ))}
        <AsyncButton size="small" onClick={() => actions.declineAssignPr(pr.number)} title="Leave it unassigned">
          Nah
        </AsyncButton>
      </ButtonRow>
    </>
  );
}

function descriptionFeedbackBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
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
      <PrPress
        prNumber={feedback.prNumber}
        label="Read what it found"
        refTitle="Open the pull request"
        actions={actions}
      />
    </>
  );
}

function dispatchBody(row: NeedRow, view: CockpitView): ReactNode {
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
        The harness is proposing it again on every pulse and will go on doing so; it is not paused, and nothing about it
        is retried differently. Clearing what the refusal names is the whole of the fix.
        {rule && ` The rule proposing it is “${rule.name}”.`}
      </p>
      {refusal.originRef !== null && <RefLine to={refusal.originRef} title="Open what the refused dispatch is about" />}
    </>
  );
}

function escalationBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
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

function Lines({ items, className }: { items: readonly string[]; className: string }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul className={className}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function RefLine({ to, title }: { to: string; title: string }): JSX.Element {
  return (
    <div className="cn-refs">
      <Ref to={to} title={title} />
    </div>
  );
}

function PrPress({
  prNumber,
  label,
  refTitle,
  actions,
}: {
  prNumber: number;
  label: string;
  refTitle: string;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <>
      <ButtonRow>
        <Button
          tone="primary"
          onClick={() => {
            actions.openPanel(null);
            actions.selectPr(prNumber);
          }}
        >
          {label}
        </Button>
      </ButtonRow>
      <RefLine to={`pr:${prNumber}`} title={refTitle} />
    </>
  );
}

/** How many waiting threads the assigned-pull-request ask draws before it points at the pull request. */
const THREADS_SHOWN = 5;
