import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { HumanTask } from '../types.js';
import { livePageChecks } from '../view/goalPage.js';
import type { GoalPageView } from '../view/goalPage.js';
import { Ref } from '../components/refs.js';
import { relTime } from '../components/util.js';
import { Tag } from '../components/tag.js';
import { CheckLine } from '../components/validationCheckRows.js';
import { PanelRows } from './PanelRow.js';
import { closedPrRow } from './prRow.js';
import { REACH_TONE } from './goalEnvironments.js';
import { openGoalChecks } from './jump.js';
import { goalPageFor, TalkAnswers, TaskAnswers, TaskLede } from './taskAnswers.js';

// → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work

/**
 * What closing the goal is closing: the goal, where it is, what was checked and what landed. On the
 * goal page's Close pane it is the answers alone — the pane draws the rest directly below.
 */
export function CloseOutAsk({
  task,
  view,
  actions,
  inPane,
}: {
  task: HumanTask;
  view: CockpitView;
  actions: CockpitActions;
  inPane: boolean;
}): JSX.Element {
  const page = goalPageFor(view, task.originRef);
  if (page === null) {
    return (
      <>
        <TaskLede task={task} view={view} />
        <TaskAnswers task={task} view={view} actions={actions} />
      </>
    );
  }
  return (
    <>
      {!inPane && <CloseOutSummary page={page} view={view} actions={actions} />}
      <TalkAnswers
        task={task}
        view={view}
        actions={actions}
        issueNumber={page.issue.number}
        question="is this ready to close?"
        label="Not ready? Talk it through"
      />
    </>
  );
}

function CloseOutSummary({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const checks = livePageChecks(page);
  const prs = page.closedPullRequests.filter((pr) => pr.merged);
  return (
    <dl className="cn-closeout">
      <dt>Goal</dt>
      <dd>
        <Ref to={`issue:${page.issue.number}`} />
        {page.issue.title}
      </dd>
      <dt>On</dt>
      <dd>
        <Reach page={page} view={view} />
      </dd>
      <dt>Checks</dt>
      <dd className="cn-closeout-list">
        {checks.length === 0
          ? 'none'
          : checks.map((check) => (
              <CheckLine
                key={check.id}
                check={check}
                standing={undefined}
                onOpen={() => openGoalChecks(actions)}
                onSelect={undefined}
              />
            ))}
      </dd>
      <dt>Pull requests</dt>
      <dd className="cn-closeout-list">
        {prs.length === 0 ? 'none merged' : <PanelRows rows={prs.map((pr) => closedPrRow(pr, view, actions))} />}
      </dd>
    </dl>
  );
}

/** Every environment's verdict, with how long ago the goal arrived there — the arrival, never the probe. */
function Reach({ page, view }: { page: GoalPageView; view: CockpitView }): JSX.Element {
  const ref = `issue:${page.issue.number}`;
  const arrivedAt = new Map(
    (view.state.environmentArrivals ?? []).filter((a) => a.goalRef === ref).map((a) => [a.environment, a.arrivedAt]),
  );
  if (page.environments.length === 0) return <>no environments declared</>;
  return (
    <>
      {page.environments.map((env) => {
        const at = arrivedAt.get(env.environment);
        return (
          <span key={env.environment} className="cn-closeout-item">
            {env.environment}
            <Tag tone={REACH_TONE[env.status]} fill={REACH_TONE[env.status] !== undefined}>
              {env.status}
            </Tag>
            {at !== undefined && (
              <i className="cn-closeout-age" title={at}>
                {relTime(at, view.now)}
              </i>
            )}
          </span>
        );
      })}
    </>
  );
}
