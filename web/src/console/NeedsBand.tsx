import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
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
