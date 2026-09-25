import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { HumanTask } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { GOAL_ANCHOR, GOAL_TAB_OF, buildGoalPage, goalIssue } from '../view/goalPage.js';
import { scrollToAnchor } from './jump.js';
import { HumanTaskActions } from '../components/HumanTaskActions.js';
import { renderMarkdown } from '../components/markdown.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { Ref } from '../components/refs.js';
import { ValidationSection } from '../components/ValidationSection.js';
import { Button, ButtonRow } from '../components/button.js';

// → docs/spec/17-cockpit.md

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
    case 'validate':
    case 'close_out':
      return <ChecksAsk task={task} view={view} actions={actions} checksBelow={checksBelow} />;
    case 'supply':
      return <SupplyAsk task={task} view={view} actions={actions} />;
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

function TaskLede({ task, view }: { task: HumanTask; view: CockpitView }): JSX.Element {
  return (
    <>
      <p className="cn-lede">{task.title}</p>
      {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
    </>
  );
}

function TaskAnswers({
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
 * The bench rows that ask for the goal's checks — `validate` — and that say the goal
 * is delivered and its ticket is still open — `close_out` — drawn as the checks
 * themselves.
 *
 * Every other ask on this surface is answered by the ask: a verdict, a pick, a
 * sentence. `validate` is answered somewhere else — somebody runs the checks and
 * records what they saw — so a body that only names them is a page that tells the
 * operator to go and find the work, on the one surface whose whole argument is
 * that the thing to do is in front of you.
 *
 * The decision `close_out` asks for is *what to do about the checks*: the desk's own
 * note on `Done` says so in as many words — closing a goal whose validation is flagged
 * costs a sentence about the outstanding ones, or waiving them first. It said it
 * about a list drawn as prose. So the rows come with it, and both answers the note
 * offers are controls on this page rather than a trip to the goal.
 *
 * The desk's prose stays above the rows. It is its own refreshed statement of what
 * the goal owes — the sheet assembled for an environment, the ticket's link — and
 * it is what the row says everywhere the rows are not in front of the reader.
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
  return (
    <>
      <TaskLede task={task} view={view} />
      <GoalChecks originRef={task.originRef} view={view} actions={actions} checksBelow={checksBelow} />
      <TaskAnswers task={task} view={view} actions={actions} />
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
