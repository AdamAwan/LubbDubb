import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { HumanTask } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { livePageChecks, obligationEnvironment } from '../view/goalPage.js';
import type { GoalPageView } from '../view/goalPage.js';
import { RunStrip, TenantBanner } from './goalRunners.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { Ref } from '../components/refs.js';
import { planIssueOf } from '../components/util.js';
import { ValidationSection } from '../components/ValidationSection.js';
import { Button, ButtonRow, BareButton } from '../components/button.js';
import { CloseOutAsk } from './closeOutAsk.js';
import { goalPageFor, TalkAnswers, TaskAnswers, TaskLede } from './taskAnswers.js';
import { openGoalChecks } from './jump.js';

// → docs/spec/17-cockpit.md

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

export function taskBody(row: NeedRow, view: CockpitView, actions: CockpitActions, checksBelow: boolean): ReactNode {
  const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
  if (!task) return null;
  switch (row.kind) {
    case 'watch':
      return <WatchFinding task={task} view={view} actions={actions} />;
    case 'close_out':
      return <CloseOutAsk task={task} view={view} actions={actions} inPane={checksBelow} />;
    case 'validate':
      return <ChecksAsk task={task} view={view} actions={actions} checksBelow={checksBelow} />;
    case 'supply':
      return <SupplyAsk task={task} view={view} actions={actions} />;
    case 'unwatched':
      return <UnwatchedAsk task={task} view={view} actions={actions} />;
    default:
      return (
        <BenchAsk
          task={task}
          liftTo={row.kind === 'burn' ? liftTargetFor(task, view) : null}
          view={view}
          actions={actions}
        />
      );
  }
}

function BenchAsk({
  task,
  liftTo,
  view,
  actions,
}: {
  task: HumanTask;
  liftTo: string | null;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const liftAgentId = task.agentId;
  return (
    <>
      <TaskLede task={task} view={view} />
      {liftTo !== null && liftAgentId !== null && (
        <ButtonRow>
          <AsyncButton
            usage="agent.edit"
            tone="primary"
            onClick={() => actions.liftAgentProfile(liftAgentId, liftTo)}
            title={`Stop this run where it stands and hand the same task to “${liftTo}”`}
          >
            Lift to “{liftTo}”
          </AsyncButton>
        </ButtonRow>
      )}
      <TaskAnswers task={task} view={view} actions={actions} />
    </>
  );
}

/**
 * The bench row that asks for the goal's checks — `validate` — drawn as the runners and the checks
 * themselves rather than the desk's sentence naming them: the strip with the OK a waiting page needs,
 * then the rows. `checksBelow` is the goal page, where both are a pane away.
 * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
 */
function ChecksAsk({
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
  if (checksBelow) {
    return (
      <>
        <ChecksBelow originRef={task.originRef} view={view} actions={actions} />
        <TaskAnswers task={task} view={view} actions={actions} />
      </>
    );
  }
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
      <TenantBanner
        page={page}
        showing={obligationEnvironment(page, 'validate', view.sheetEnvironment)}
        actions={actions}
      />
      <RunStrip page={page} view={view} actions={actions} />
      <GoalChecks page={page} view={view} actions={actions} />
      <TalkAnswers
        task={task}
        view={view}
        actions={actions}
        issueNumber={page.issue.number}
        question="what is stopping these checks passing?"
        label="Stuck? Talk it through"
      />
    </>
  );
}

/**
 * The goal page's stand-in for the rows: they are a pane away there, and a second live copy above the
 * tab row is the ask drawing the page it is standing on. So it says how many and offers the way to
 * them, counted off the snapshot rather than building the whole goal page to do it.
 * → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work
 */
function ChecksBelow({
  originRef,
  view,
  actions,
}: {
  originRef: string | null;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const live = (view.state.validationChecks ?? []).filter(
    (c) => c.originRef === originRef && c.supersededReason === null,
  );
  if (originRef === null || live.length === 0) return null;
  return (
    <BareButton usage="validation.expand" className="cn-ask-checks-to" onClick={() => openGoalChecks(actions)}>
      {live.length === 1 ? 'The 1 check this asks about is' : `The ${live.length} checks this asks about are`} under
      Checks, below — go to them
    </BareButton>
  );
}

function GoalChecks({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const number = page.issue.number;
  if (livePageChecks(page).length === 0) return null;
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
      <TaskLede task={task} view={view} />
      {showing.length > 0 && (
        <ul className="cn-ask-supply">
          {showing.map((issue) => (
            <li key={issue.number}>
              <span className="cn-grow">{issue.title}</span>
              <span className="cn-refs">
                <Ref to={`issue:${issue.number}`} title="Open the item on the tracker" />
              </span>
              <AsyncButton
                usage="ticket.accept"
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
      <TaskAnswers task={task} view={view} actions={actions} />
    </>
  );
}

/** How many unwatched items the runway ask draws before it points at the tickets tab. */
const SUPPLY_SHOWN = 8;

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
      <TaskLede task={task} view={view} />
      <TaskAnswers
        task={task}
        view={view}
        actions={actions}
        extra={
          canRaise ? (
            <Button
              usage="ticket.expand"
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

/* The Feature and the stories it names are links, and the row's two answers are buttons: watch the
   lot, or dismiss it until another unseen story appears.
   → docs/spec/06-issue-pickup.md#a-watched-feature-reports-the-children-nothing-can-see */
function UnwatchedAsk({
  task,
  view,
  actions,
}: {
  task: HumanTask;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const number = task.originRef === null ? null : planIssueOf(task.originRef);
  const unseen = view.state.world.issues.filter((i) => i.parent?.number === number && i.pickup.status === 'unwatched');
  return (
    <>
      <TaskLede task={task} view={view} />
      {number !== null && (
        <p className="cn-tick">
          <span className="cn-refs">
            Feature <Ref to={`issue:${number}`} />
            {unseen.length > 0 && <> · not watched: </>}
            {unseen.map((i) => (
              <Ref key={i.number} to={`issue:${i.number}`} />
            ))}
          </span>
        </p>
      )}
      <ButtonRow bar>
        {number !== null && (
          <>
            <Button
              usage={{ counted: 'feature.view' }}
              tone="secondary"
              onClick={() => actions.openFeature(number)}
              title="Open this Feature's card"
            >
              Open feature
            </Button>
            <AsyncButton
              usage="ticket.accept"
              tone="primary"
              onClick={() => actions.setIssueWatched(number, true)}
              title="Put the watch tag on the Feature and every story under it"
            >
              Watch all
            </AsyncButton>
          </>
        )}
        <AsyncButton
          usage={{ counted: 'human-task.accept' }}
          tone="secondary"
          onClick={() => actions.completeHumanTask(task.id, 'Dismissed — the unwatched stories are out of scope.')}
          title="Hide this until another story under the Feature has no watch tag"
        >
          Dismiss
        </AsyncButton>
      </ButtonRow>
    </>
  );
}
