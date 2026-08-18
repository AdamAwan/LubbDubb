import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { EscalationCard } from '../components/EscalationCard.js';
import { HumanTaskActions } from '../components/HumanTaskActions.js';
import { renderMarkdown } from '../components/markdown.js';
import { relTime } from '../components/util.js';
import { KIND_LABEL, holdingLabel } from './QueueRail.js';

/**
 * One open ask, pinned. Red when an agent is parked on it, amber when the
 * obligation is only the operator's — the rail's own split, carried over so the
 * row and the band it opens read the same.
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
    <div className={`cn-needs ${row.group === 'blocking' ? '' : 'cn-soft'}`}>
      <header>
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
  if (row.kind === 'bench' || row.kind === 'close_out' || row.kind === 'burn') {
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
      onViewPlan={(id) => actions.viewPlan(id)}
    />
  );
}
