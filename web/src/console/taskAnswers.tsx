import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { HumanTask } from '../types.js';
import { buildGoalPage } from '../view/goalPage.js';
import type { GoalPageView } from '../view/goalPage.js';
import { goalIssue } from '../view/goalRefs.js';
import { HumanTaskActions } from '../components/HumanTaskActions.js';
import { renderMarkdown } from '../components/markdown.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { askPrompt } from '../cockpit/desktopLink.js';

// → docs/spec/17-cockpit.md

function noteOwedOnDone(task: HumanTask, view: CockpitView): string | null {
  if (task.kind !== 'close_out' || task.status !== 'open' || task.originRef === null) return null;
  const issue = goalIssue(view.state, task.originRef);
  if (issue?.validation?.state !== 'flagged') return null;
  return 'Validation is not clear on this goal — the checks listed above are outstanding. Closing it out is still yours to do; what it costs is a sentence saying what you are doing about them, or waiving them first.';
}

/** The goal's page for an ask about it — the one the view already built when it is that goal's. */
export function goalPageFor(view: CockpitView, originRef: string | null): GoalPageView | null {
  if (originRef === null) return null;
  if (view.goalPage !== null && `issue:${view.goalPage.issue.number}` === originRef) return view.goalPage;
  return buildGoalPage(view.state, originRef, view.needsYou, null);
}

function closeTicketFor(task: HumanTask, view: CockpitView): boolean {
  if (task.kind !== 'close_out' || task.status !== 'open') return false;
  if (task.originRef === null || !/^issue:\d+$/.test(task.originRef)) return false;
  return view.state.config.canCloseIssue;
}

export function TaskLede({ task, view }: { task: HumanTask; view: CockpitView }): JSX.Element {
  return (
    <>
      <p className="cn-lede">{task.title}</p>
      {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
    </>
  );
}

export function TaskAnswers({
  task,
  view,
  actions,
  extra,
}: {
  task: HumanTask;
  view: CockpitView;
  actions: CockpitActions;
  extra?: ReactNode;
}): JSX.Element {
  return (
    <HumanTaskActions
      task={task}
      look={{ tone: 'secondary' }}
      noteOnDone={noteOwedOnDone(task, view)}
      onDone={(id, note) => actions.completeHumanTask(id, note)}
      onDecline={(id, note) => actions.declineHumanTask(id, note)}
      onCloseTicket={closeTicketFor(task, view) ? (id, note) => actions.closeHumanTaskTicket(id, note) : null}
      extra={extra}
    />
  );
}

/**
 * The answers to an ask that settles itself once the work is done: the one act there is, if any, and
 * a conversation about why it is not done yet in place of a Done or a Decline.
 * → docs/spec/17-cockpit.md#an-ask-that-settles-itself-offers-a-conversation-not-a-dismissal
 */
export function TalkAnswers({
  task,
  view,
  actions,
  issueNumber,
  question,
  label,
}: {
  task: HumanTask;
  view: CockpitView;
  actions: CockpitActions;
  issueNumber: number;
  question: string;
  label: string;
}): JSX.Element {
  return (
    <HumanTaskActions
      task={task}
      look={{ tone: 'secondary' }}
      noteOnDone={noteOwedOnDone(task, view)}
      onDone={null}
      onDecline={null}
      onCloseTicket={closeTicketFor(task, view) ? (id, note) => actions.closeHumanTaskTicket(id, note) : null}
      extra={
        <DesktopLink
          usage="goal.open"
          folder={view.state.config.desktopFolder}
          prompt={`${askPrompt(issueNumber)}${question}`}
          label={label}
          fullSize
          explain="answered from what the harness recorded about this goal — the plan, the pull requests, the checks and where the work has reached."
        />
      }
    />
  );
}
