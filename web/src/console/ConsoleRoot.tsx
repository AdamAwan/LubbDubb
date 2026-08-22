import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions, ConsolePanel, ConsoleTab } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import { TAB_LABEL, TopBar } from './TopBar.js';
import { KIND_LABEL, KIND_SYMBOL, QueueRail, subjectLabel } from './QueueRail.js';
import { needBody } from './NeedsBand.js';
import { GoalPage } from './GoalPage.js';
import { Overview } from './Overview.js';
import { Panel } from './Panel.js';
import { RecoveryPanel } from '../components/RecoveryPanel.js';
import { TicketsPanel } from '../components/TicketsPanel.js';
import { ConfigPage } from '../components/ConfigPage.js';
import { RecordPanel } from '../components/RecordPanel.js';
import { FindingsPanel } from '../components/FindingsPanel.js';
import { LessonsPanel } from '../components/LessonsPanel.js';
import { KnowledgePanel } from '../components/KnowledgePanel.js';
import { LaunchPanel } from '../components/LaunchPanel.js';
import { SetupPanel } from '../components/SetupPanel.js';
import { PetsPanel } from '../components/PetsPanel.js';
import { PetsPage } from '../components/PetsPage.js';
import { Vivarium } from './Vivarium.js';
import { BuildPanel } from '../components/BuildPanel.js';
import { LocalRunPanel } from '../components/LocalRunPanel.js';
import { InsightsPage } from '../components/InsightsPage.js';
import { SchedulePanel } from '../components/SchedulePanel.js';
import { InjectPanel } from '../components/InjectPanel.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { relTime } from '../components/util.js';
import { Ref } from '../components/refs.js';

/**
 * The console's placement, and what each full-surface panel contains: what a
 * panel *is* and where it sits are separate edits, so every one below is bound to
 * a const and then placed.
 *
 * A dropped socket empties the whole surface. Every reading here is one the
 * harness confirms, and a stale one is drawn in exactly the chrome of a live
 * one — so rather than ask an operator to remember to check a chip, nothing is
 * drawn at all.
 */
export function ConsoleRoot({ view, actions }: { view: CockpitView; actions: CockpitActions }) {
  if (!view.connected) {
    return (
      <div className="cn">
        <TopBar view={view} actions={actions} />
        <div className="cn-offline">
          <h1>Off the air</h1>
          <p>
            The link to the harness dropped. The harness is unaffected; the console returns by itself when it
            reconnects.
          </p>
        </div>
      </div>
    );
  }

  // Outside and above `.cn-body`, not inside it: while a crashed run stands, the
  // heartbeat is held and every goal the rail or situation area would draw is
  // stale for the same reason — this banner is the one thing still true.
  const recovery =
    view.crashed.length > 0 ? (
      <div className="cn-recovery">
        <RecoveryPanel
          crashed={view.crashed}
          now={view.now}
          refUrls={view.state.refUrls}
          onDecide={(id, verdict) => actions.decideRecovery(id, verdict)}
        />
      </div>
    ) : null;

  // A selected goal outranks the nav. Selecting one is what a queue row does, and
  // it does not move the nav — so with a tab winning, clicking an ask would land
  // on a triage list, or on the record, instead of on the ask.
  const situation =
    view.goalPage !== null ? (
      <>
        <Crumb goal={view.goalPage.issue} tab={view.tab} actions={actions} />
        <GoalPage page={view.goalPage} view={view} actions={actions} />
      </>
    ) : view.selectedGoal !== null ? (
      <GoalGone ref_={view.selectedGoal} tab={view.tab} actions={actions} />
    ) : (
      tabBody(view.tab, view, actions)
    );

  const panel = renderPanel(view, actions);

  return (
    <div className="cn">
      <TopBar view={view} actions={actions} />
      {recovery}
      <div className="cn-body">
        <aside className="cn-rail">
          <QueueRail view={view} actions={actions} />
          {/* Below the rail's scrolling list rather than inside it: a queue longer
              than the rail scrolls behind the enclosure instead of pushing it off
              the bottom, so the corner is always in frame and covers nothing.
              Absent entirely when the snapshot ships no vivarium — the feature off,
              or on and hidden. */}
          {view.state.pets !== null && (
            <Vivarium
              pets={view.state.pets}
              runningAgents={view.state.agents.filter((a) => a.status === 'running').length}
              paused={view.state.control.paused}
              onOpen={() => actions.openPanel('pets')}
              onHatch={(id) => actions.hatchEgg(id)}
            />
          )}
        </aside>
        <main className="cn-sit">{situation}</main>
      </div>
      {panel}
    </div>
  );
}

/** What the situation area draws for a tab, when no goal outranks it. */
function tabBody(tab: ConsoleTab, view: CockpitView, actions: CockpitActions): JSX.Element {
  switch (tab) {
    case 'overview':
      return <Overview view={view} actions={actions} />;
    case 'insights':
      // Embedded exactly as the tickets tab is, and for the same reason: it
      // reaches its own routes, which `console/` may not, but rendering a
      // component that does is not reaching — the import ban is on `api.js` and
      // still holds. The window and the open reading are handed in from `Place`
      // rather than held inside it, so a link to one carries both.
      return <InsightsPage view={view.insightsView} window={view.insightsWindow} actions={actions} />;
    case 'tickets':
      // Embedded exactly as Insights is, and for the same reason: it reaches its
      // own route, which `console/` may not, but rendering a component that does
      // is not reaching — the import ban is on `api.js` and still holds.
      return (
        <TicketsPanel
          query={{
            watch: view.ticketWatch,
            tracking: view.ticketTracking,
            state: view.ticketState,
            feature: view.ticketFeature,
            group: view.ticketGroup,
            order: view.ticketOrder,
            view: view.ticketView,
            columns: view.ticketColumns,
          }}
          onQuery={(next) =>
            actions.setTicketQuery({
              ...(next.watch !== undefined ? { ticketWatch: next.watch } : {}),
              ...(next.tracking !== undefined ? { ticketTracking: next.tracking } : {}),
              ...(next.state !== undefined ? { ticketState: next.state } : {}),
              ...(next.feature !== undefined ? { ticketFeature: next.feature } : {}),
              ...(next.group !== undefined ? { ticketGroup: next.group } : {}),
              ...(next.order !== undefined ? { ticketOrder: next.order } : {}),
              ...(next.view !== undefined ? { ticketView: next.view } : {}),
              ...(next.columns !== undefined ? { ticketColumns: next.columns } : {}),
            })
          }
          view={view}
          actions={actions}
          now={view.now}
        />
      );
    case 'pets':
      // A deployment drawing no vivarium has no tab to reach this, but a stale URL
      // still can — and an empty page is a better answer than a page describing a
      // subsystem that is not on the cockpit. "Hidden" covers both reasons the
      // snapshot ships null, and the cockpit is not told which one it was.
      return view.state.pets === null ? (
        <p className="muted">Pets are hidden on this deployment.</p>
      ) : (
        <PetsPage pets={view.state.pets} />
      );
    case 'config':
      // Embedded exactly as the tickets tab and the work tree are: it reaches its
      // own routes, which `console/` may not, but rendering a component that does
      // is not reaching — the import ban is on `api.js` and still holds.
      return <ConfigPage view={view} actions={actions} />;
  }
}

/**
 * The trail back out of a goal — the tab you left, and the goal you are on.
 *
 * It is here rather than in the bar's nav for two reasons that are the same
 * reason: a title has no length limit, so in the bar it reflows the readings
 * every time a goal opens; and it names what the *situation area* is showing, so
 * it belongs at the head of the situation area. `selectGoal(null)` alone is the
 * whole of the way back — the tab was never cleared, so there is nothing to
 * restore, and naming it is what makes the trail a trail rather than a label.
 */
/**
 * A goal was selected and the world does not carry it.
 *
 * `buildGoalPage` answers null here deliberately — a page of empty sections cannot be
 * told apart from a goal that exists with nothing on it. But falling through to the
 * tab body was the other half of that decision left unmade: the address bar said
 * `goal=issue:412` while the screen showed the list, so the click read as a control
 * that does nothing. Every **frozen** ticket is in exactly this position, because the
 * mirror keeps what the tracker has stopped returning and the snapshot does not — so
 * on the Tickets tab it is the common case, not the corner.
 *
 * The tracker is where the answer actually is, so the reference is the offer, drawn
 * with `<Ref>` like every other one.
 */
function GoalGone({ ref_, tab, actions }: { ref_: string; tab: ConsoleTab; actions: CockpitActions }): JSX.Element {
  const number = /^issue:(\d+)$/.exec(ref_)?.[1] ?? null;
  return (
    <>
      <nav className="cn-crumb">
        <button type="button" onClick={() => actions.selectGoal(null)}>
          ‹ {TAB_LABEL[tab]}
        </button>
        <span className="cn-crumbsep">/</span>
        <span className="cn-crumbnow">{number === null ? ref_ : `#${number}`}</span>
      </nav>
      <section className="cn-gone">
        <h2>{number === null ? ref_ : `#${number}`} is not in the current world</h2>
        <p>
          The harness has a record of this item, but the last scan did not return it — so there is no plan, no run and
          no verdict to draw. That is what a closed, reassigned or untagged ticket looks like from here.
        </p>
        <span className="cn-refs">
          <Ref to={ref_} />
        </span>
      </section>
    </>
  );
}

function Crumb({
  goal,
  tab,
  actions,
}: {
  goal: { number: number; title: string };
  tab: ConsoleTab;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <nav className="cn-crumb">
      <button type="button" onClick={() => actions.selectGoal(null)}>
        ‹ {TAB_LABEL[tab]}
      </button>
      <span className="cn-crumbsep">/</span>
      <span className="cn-crumbnow">
        #{goal.number} {goal.title}
      </span>
    </nav>
  );
}

/** What each panel calls itself — the same word as the reading that opens it. */
const PANEL_TITLE: Record<Exclude<ConsolePanel, null | { ask: string }>, string> = {
  findings: 'Findings',
  lessons: 'Lessons',
  knowledge: 'Knowledge',
  faults: 'Faults',
  launch: 'Launch',
  build: 'Build',
  pets: 'Vivarium',
  localRun: 'Running locally',
  setup: 'Setup',
  record: 'The record',
};

/**
 * Whichever panel is in front, or nothing.
 *
 * The **ask** panel is the destination for a queue row with no goal page to be
 * answered on ({@link NeedRow.opens}), and it closes itself: answering settles
 * the row, the next snapshot drops it from `needsYou`, and a panel with no row
 * left draws nothing. That is why the row is looked up here rather than held —
 * a panel that outlived its ask would offer a second verdict on a settled one.
 */
function renderPanel(view: CockpitView, actions: CockpitActions): JSX.Element | null {
  const panel = view.consolePanel;
  if (panel === null) return null;
  const close = () => actions.openPanel(null);

  if (typeof panel === 'object') {
    const row = view.needsYou.find((r) => r.id === panel.ask);
    if (!row) return null;
    const body = needBody(row, view, actions);
    if (body === null) return null;
    return (
      <Panel title={`${KIND_SYMBOL[row.kind]} Needs you · ${KIND_LABEL[row.kind]}`} onClose={close}>
        <AskSubject row={row} actions={actions} />
        <div className="cn-pbody">{body}</div>
      </Panel>
    );
  }

  return (
    <Panel title={PANEL_TITLE[panel]} onClose={close}>
      <div className="cn-pbody">{panelBody(panel, view, actions)}</div>
    </Panel>
  );
}

/**
 * What the ask in the panel is about, stated above it and always as a way there.
 *
 * The panel is the one surface with no context drawn around it, so the subject
 * has to be on the panel itself. Three readings, and the third is the one worth
 * the component: a goal, which is a way back onto its page; a pull request no
 * ticket owns, linked out to the provider; and **neither**, said in those words.
 * An ask that names nothing is not a bug in the console — the harness raises them
 * on ticketless pull requests and on bench work nobody filed — but leaving the
 * line blank makes it read as one, and an operator who cannot tell "no goal" from
 * "the goal did not load" answers blind.
 */
function AskSubject({ row, actions }: { row: NeedRow; actions: CockpitActions }): JSX.Element {
  const subject = subjectLabel(row);
  if (row.goalRef !== null) {
    const ref = row.goalRef;
    // Closing first: the goal page draws this same ask in its band, so a panel
    // left standing over it would be the same verdict offered twice.
    const read = () => {
      actions.openPanel(null);
      actions.selectGoal(ref);
    };
    return (
      <p className="cn-psub">
        On goal{' '}
        <button type="button" className="cn-goto" onClick={read}>
          {subject} — read it in context →
        </button>
      </p>
    );
  }
  const pr = /^pr:(\d+)/.exec(row.originRef ?? '');
  return (
    <p className="cn-psub cn-noGoal">
      No linked goal ·{' '}
      {pr ? (
        <>
          raised on <Ref to={`pr:${pr[1]}`} />, a pull request no ticket owns
        </>
      ) : (
        'this ask stands on its own — nothing in the tracker is waiting on it'
      )}
    </p>
  );
}

function panelBody(
  panel: Exclude<ConsolePanel, null | { ask: string }>,
  view: CockpitView,
  actions: CockpitActions,
): ReactNode {
  const { state } = view;
  switch (panel) {
    case 'findings':
      return (
        <FindingsPanel
          findings={state.findings}
          now={view.now}
          refUrls={state.refUrls}
          canFileTickets={state.config.canFileTickets}
          onPromote={(id) => actions.promoteFinding(id)}
          onFile={(id) => actions.fileFinding(id)}
          onDismiss={(id) => actions.dismissFinding(id)}
        />
      );
    case 'lessons':
      return (
        <LessonsPanel
          lessons={state.lessons}
          now={view.now}
          refUrls={state.refUrls}
          onPropose={(text, originRef) => actions.proposeLesson(text, originRef)}
          onPromote={(id) => actions.promoteLesson(id)}
          onRetire={(id) => actions.retireLesson(id)}
        />
      );
    case 'knowledge':
      return (
        <KnowledgePanel
          facts={state.knowledge}
          graduations={state.knowledgeGraduations}
          delivery={state.knowledgeDelivery}
          now={view.now}
          refUrls={state.refUrls}
          viewingFact={view.viewingFact}
          onReach={(id, reach) => actions.setFactReach(id, reach)}
          onCommit={(id, commitment) => actions.commitFact(id, commitment)}
          onSettleGraduation={(id, outcome) => actions.settleGraduation(id, outcome)}
          onDetail={(id) => actions.factDetail(id)}
          onResolveContradiction={(id, ruling) => actions.resolveContradiction(id, ruling)}
          onViewFact={(id) => actions.viewFact(id)}
        />
      );
    case 'pets':
      return state.pets === null ? null : (
        <PetsPanel
          pets={state.pets}
          now={view.now}
          onFeed={(id, beats) => actions.feedPet(id, beats)}
          onRename={(id, name) => actions.renamePet(id, name)}
          onPlace={(id, placed) => actions.placePet(id, placed)}
          onBlend={(id) => actions.blendPet(id)}
          onHatch={(id) => actions.hatchEgg(id)}
        />
      );
    case 'faults':
      return <FaultLog view={view} actions={actions} />;
    case 'localRun':
      return (
        <LocalRunPanel
          run={state.localRun}
          configured={state.config.localRunConfigured}
          stopConfigured={state.config.localRunStopConfigured}
          // The goals the cockpit already has, watched ones first: what is startable
          // is what is being worked on, and a list of every issue the tracker has
          // ever held would bury it.
          goals={state.world.issues}
          // Where each of those goals would actually run, and what has happened
          // there — derived server-side, because which branch is the tip of a stack
          // is the runner's decision and not a second one taken here.
          targets={state.localRunTargets}
          now={view.now}
          onStart={(issueNumber, ref) => actions.startLocalRun(issueNumber, ref)}
          onStop={() => actions.stopLocalRun()}
          fetchOutput={() => actions.localRunOutput()}
        />
      );
    case 'setup':
      return <SetupPanel onClose={() => actions.openPanel(null)} />;
    case 'record':
      // The durable work graph, which was the console's second nav destination
      // until every part of it found a better home. A panel now: an archive is
      // consulted rather than worked on, and this way it is reachable from a goal
      // page too — which the tab, outranked by any selected goal, never was.
      return <RecordPanel now={view.now} />;
    case 'build':
      return (
        <BuildPanel
          build={state.build}
          now={view.now}
          onUpgrade={(action, opts) => actions.upgrade(action, opts)}
          onCheck={() => actions.checkBuild()}
        />
      );
    case 'launch':
      return (
        <>
          <LaunchPanel
            jobs={state.jobs}
            attachments={state.attachments}
            attachmentUrls={state.attachmentUrls}
            onChanged={() => void actions.refresh()}
          />
          <SchedulePanel schedules={state.schedules} onChanged={() => void actions.refresh()} />
          {/* Injection fakes a world change, which only the static demo has any
              use for: a real run against a fake provider is still a real run, and
              a panel that lies to the harness there is a way to lie to yourself
              about what it is reacting to. `view.demo` is the whole gate — there
              is no server route behind it for a second predicate to disagree
              with. */}
          {view.demo && <InjectPanel onInjected={() => void actions.refresh()} world={state.world} />}
        </>
      );
  }
}

/** How many faults the log draws. This is the surface you went looking for, so it is not cropped to a column. */
const FAULT_ROWS = 40;

/**
 * The fault log. Nothing in the harness reads these back, so it blocks nothing
 * and is never red — amber is the whole of its claim on your attention.
 *
 * The clear is two-step and sits **above** the rows, and it is drawn at zero rows
 * as well. A clear costs nothing the harness decides on, but it costs the only
 * copy and for every cockpit rather than this one, so one misclick between
 * "leave" and "delete the only copy" is too few — and the only route to it must
 * not depend on there being rows, or the control moves under the operator exactly
 * as the log fills.
 */
function FaultLog({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { errors } = view.state;
  return (
    <>
      <div className="cn-acts">
        <ConfirmButton
          className="ghost"
          label="Clear"
          confirmLabel="Delete every recorded fault?"
          title={`Delete all ${errors.length} recorded faults — this cannot be undone, for any cockpit`}
          onConfirm={() => actions.clearErrors()}
        />
      </div>
      <div className="cn-rows">
        {errors.length === 0 && <p className="cn-empty">No fault has been recorded.</p>}
        {errors.slice(0, FAULT_ROWS).map((err) => (
          <div className="cn-row" key={err.id}>
            <i className="cn-lamp cn-wait" />
            <span className="cn-grow">
              <b className="cn-name">{err.source}</b>
              <span className="cn-sub cn-wrap">{err.message}</span>
              {err.detail !== null && <span className="cn-sub cn-wrap">{err.detail}</span>}
            </span>
            <span className="cn-num">{relTime(err.createdAt, view.now)}</span>
          </div>
        ))}
        {errors.length > FAULT_ROWS && <p className="cn-empty">…{errors.length - FAULT_ROWS} older</p>}
      </div>
    </>
  );
}
