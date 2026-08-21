import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { HumanTask } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { EscalationCard } from '../components/EscalationCard.js';
import { HumanTaskActions } from '../components/HumanTaskActions.js';
import { renderMarkdown } from '../components/markdown.js';
import { goalIssue } from '../view/goalPage.js';
import { relTime } from '../components/util.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, holdingLabel } from './QueueRail.js';

/**
 * One open ask, pinned, in the tone and under the glyph its kind wears on the
 * rail — the row and the band it opens have to read as one ask, and hue plus
 * symbol is most of how an operator recognises that they have.
 *
 * The rail's *weight* split (`cn-parked`) is not carried over, and that is the
 * one thing the two surfaces deliberately differ on: weight is a triage aid for a
 * list of asks competing for attention, and the band is a single ask already in
 * front of the operator with its verdict controls under it. There is nothing here
 * to rank it against.
 *
 * The band draws nothing at all when the row's source is gone from the snapshot.
 * A header over an empty box would claim something is waiting while offering no
 * way to answer it.
 *
 * It lives here rather than on the goal page because a goal is not the only place
 * an ask is read: a row whose origin is a pull request has no goal page to sit on
 * ({@link NeedRow.opens}), and it is answered in the ask panel through this same
 * component. One band, two placements — a second wiring is a second set of
 * verdicts to keep in step.
 */
export function NeedsBand({
  row,
  view,
  actions,
}: {
  row: NeedRow;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const body = needBody(row, view, actions);
  if (body === null) return null;
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

/**
 * Why marking this row done costs a sentence, or null when it costs nothing.
 *
 * The route's own guard, mirrored: `POST /api/human-tasks/:id/done` refuses a
 * `close_out` on a goal whose validation plan is flagged unless a note comes with
 * it ([20](../../../docs/spec/20-validation.md#where-it-lands)). Mirrored here for
 * `HumanTaskActions`' Decline reason — the box that answers a rule belongs beside
 * the click, not behind a 400 the operator has to provoke first — and mirrored
 * only in its *condition*: the counts stay the server's, folded once into
 * `issue.validation` and stated in the row's own detail above these buttons.
 *
 * The server stays the authority. A plan flagged between this draw and the click
 * refuses there, and the refusal is drawn where it lands.
 */
function noteOwedOnDone(task: HumanTask, view: CockpitView): string | null {
  if (task.kind !== 'close_out' || task.status !== 'open' || task.originRef === null) return null;
  const issue = goalIssue(view.state, task.originRef);
  if (issue?.validation?.state !== 'flagged') return null;
  return 'Validation is not clear on this goal — the checks listed above are outstanding. Closing it out is still yours to do; what it costs is a sentence saying what you are doing about them, or waiving them first.';
}

/**
 * What answers this ask — the shared component that owns its verdict, wired the
 * way the stamp desk and the bench wire it. `buttonClass` is the one seam a
 * station passes, so the console's buttons and a modal's are one component
 * wearing two faces.
 *
 * Null means the row's source is no longer in the snapshot, which is also how the
 * ask panel closes itself: the answer settles the row, the next snapshot drops
 * it, and the surface that was drawing it has nothing left to draw.
 *
 * @public shared with the ask panel, which draws the body under its own header
 */
export function needBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  // A burn notice answers the same two ways as a bench row — done, or declined
  // with a reason — because that is all it ever asks for: it holds nothing, and
  // the run it names carries on either way. What differs is only where the
  // operator goes next, and the row's own agent id is what says that.
  if (
    row.kind === 'bench' ||
    row.kind === 'close_out' ||
    row.kind === 'burn' ||
    row.kind === 'validate' ||
    row.kind === 'supply'
  ) {
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
            noteOnDone={noteOwedOnDone(task, view)}
            onDone={(id, note) => actions.completeHumanTask(id, note)}
            onDecline={(id, note) => actions.declineHumanTask(id, note)}
          />
        </div>
      </>
    );
  }
  // The goal-profile gate (#342). Its two buttons are the whole of it, and both
  // go through the same write: the pin is re-affirmed and the question settled in
  // one act, so "keep mine" leaves the tag deliberately disagreeing with the
  // assayer rather than re-readable as an unanswered disagreement for ever.
  //
  // Drawn here rather than on the goal page, though the goal page is where it is
  // usually read: the page draws its own rows through this same band, so one arm
  // serves both it and the rail's panel. A second copy on the page is a second
  // set of buttons to keep in step with the write.
  if (row.kind === 'profile') {
    const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
    const assay = issue?.assay;
    if (!issue || !assay?.awaitingProfileAnswer || assay.proposedProfile === null) return null;
    const { config } = view.state;
    const proposed = assay.proposedProfile;
    const pinned = issue.modelPin.profile;
    const standing = pinned ?? config.defaultProfile;
    const described = config.profiles.find((p) => p.name === proposed)?.description;
    return (
      <>
        <p>
          <strong>The goal assay wants this run on “{proposed}”</strong>
          {standing !== null &&
            ` — ${pinned === null ? 'it would otherwise run on' : 'you pinned it to'} “${standing}”`}
          {standing === null && ' — nothing is pinned to it yet'}
        </p>
        <p className="cn-tick">
          {described ?? assay.summary} Nothing is dispatched for this goal until you say which to use — that is one
          click either way, and it is not a rejection.
        </p>
        <div className="cn-acts">
          <AsyncButton
            className="cn-btn cn-primary"
            onClick={() => actions.setIssueProfile(issue.number, proposed)}
            title={`Pin this goal to “${proposed}” and let the funnel move`}
          >
            Use “{proposed}”
          </AsyncButton>
          <AsyncButton
            className="cn-btn"
            onClick={() => actions.setIssueProfile(issue.number, pinned)}
            title={
              pinned === null
                ? 'Leave this goal unpinned, so each rule runs on its own profile'
                : `Keep “${pinned}” and let the funnel move`
            }
          >
            {pinned === null ? 'Leave it unpinned' : `Keep “${pinned}”`}
          </AsyncButton>
        </div>
      </>
    );
  }
  // A usage-limit park (issue #318). The row's id *is* the agent, because there is
  // no escalation under it: nothing was asked, so the only verdict is "the limit has
  // cleared, carry on" — and the transcript, which is where an operator decides
  // whether it is worth carrying on at all.
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
        <div className="cn-acts">
          <AsyncButton
            className="cn-btn cn-primary"
            onClick={() => actions.resumeAgent(agent.id)}
            pendingLabel="Resuming…"
          >
            Resume
          </AsyncButton>
          <button type="button" className="cn-btn" onClick={() => actions.select(agent.id)}>
            Open transcript
          </button>
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
