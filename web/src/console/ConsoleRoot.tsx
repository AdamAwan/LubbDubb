import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions, ConsoleTab } from '../cockpit/actions.js';
import type { PrPageView } from '../view/prPage.js';
import { TAB_LABEL, TopBar } from './TopBar.js';
import { QueueRail } from './QueueRail.js';
import { GoalPage } from './GoalPage.js';
import { PrPage } from './PrPage.js';
import { renderPanel } from './ConsoleRootPanels.js';

import { Overview } from './Overview.js';
import { FocusOverview } from './overviews/FocusOverview.js';
import { RecoveryPanel } from '../components/RecoveryPanel.js';
import { TicketsPanel } from '../components/TicketsPanel.js';
import { FeatureBoard, FeaturePage } from '../components/FeatureBoard.js';
import { Crumb, type CrumbStep } from './Crumb.js';
import { isContainerType } from '../issueGroups.js';
import { ConfigPage } from '../components/ConfigPage.js';
import { PoolStatus } from '../components/PoolStatus.js';
import { PetsPage } from '../components/PetsPage.js';
import { Vivarium, openPets } from './Vivarium.js';
import { InsightsPage } from '../components/InsightsPage.js';
import { ObstaclesPage } from '../components/ObstaclesPage.js';
import { Ref } from '../components/refs.js';

// → docs/spec/17-cockpit.md

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

  const panel = renderPanel(view, actions);

  return (
    <div className="cn">
      <TopBar view={view} actions={actions} />
      {recoveryBand(view, actions)}
      {/* The next shape *is* the rail's top ask, at full width and carrying its own
          controls, so drawing the rail beside it is the same queue twice — and the
          copy on the rail is the one with no room for the reason. Only while the
          overview is the surface: a goal page reached from it still wants the queue
          where it has always been.
          → docs/spec/17-cockpit.md#the-overview */}
      <div className={`cn-body ${railless(view) ? 'cn-body-railless' : ''}`}>
        {!railless(view) && (
          <aside className="cn-rail">
            <QueueRail view={view} actions={actions} />
          </aside>
        )}
        <main className="cn-sit">{situationOf(view, actions)}</main>
        {/* Last in the body rather than inside the rail, because document order is
            what decides where it lands when the shell collapses to one column: the
            end of the page, scrolled to after the work, instead of a strip wedged
            between the queue and the work. The wide arrangement is unchanged — the
            sheet places it back on the rail's floor, below the rail's scrolling list,
            so a long queue scrolls behind it. Absent entirely when the snapshot ships
            no vivarium — the feature off, or on and hidden, and absent on the shape
            that draws the creatures itself: the focus shape puts them on the floor
            of its own card without the banner, and both at once is the vivarium
            twice. → {@link PetFloor} */}
        {view.state.pets !== null && !railless(view) && (
          <Vivarium
            pets={view.state.pets}
            runningAgents={view.state.agents.filter((a) => a.status === 'running').length}
            paused={view.state.control.paused}
            onOpen={() => openPets(actions)}
            onHatch={(id) => actions.hatchEgg(id)}
          />
        )}
      </div>
      {panel}
    </div>
  );
}

function situationOf(view: CockpitView, actions: CockpitActions): JSX.Element {
  return view.prPage !== null ? (
    <>
      <PrCrumb page={view.prPage} tab={view.tab} actions={actions} />
      <PrPage page={view.prPage} view={view} actions={actions} />
    </>
  ) : view.selectedPr !== null ? (
    <PrGone number={view.selectedPr} goalRef={view.selectedGoal} tab={view.tab} actions={actions} />
  ) : view.goalPage !== null &&
    view.state.config.featureBoard &&
    isContainerType(view.goalPage.issue, view.state.config.containerTypes) ? (
    /* A container is never worked, so its goal page has nothing to draw — its page
       is the Feature's. → docs/spec/17-cockpit.md#the-feature-page */
    <FeaturePage number={view.goalPage.issue.number} back={tabStep(view.tab, actions)} view={view} actions={actions} />
  ) : view.goalPage !== null ? (
    <>
      <Crumb
        trail={[tabStep(view.tab, actions)]}
        here={`#${view.goalPage.issue.number} ${view.goalPage.issue.title}`}
      />
      <GoalPage page={view.goalPage} view={view} actions={actions} />
    </>
  ) : view.selectedGoal !== null ? (
    <GoalGone ref_={view.selectedGoal} tab={view.tab} actions={actions} />
  ) : (
    tabBody(view.tab, view, actions)
  );
}

function recoveryBand(view: CockpitView, actions: CockpitActions): JSX.Element | null {
  return view.crashed.length > 0 ? (
    <div className="cn-recovery">
      <RecoveryPanel
        crashed={view.crashed}
        now={view.now}
        refUrls={view.state.refUrls}
        onDecide={(id, verdict) => actions.decideRecovery(id, verdict)}
      />
    </div>
  ) : null;
}

/** Whether the overview's shape has absorbed the queue rail. */
function railless(view: CockpitView): boolean {
  if (view.tab !== 'overview' || view.selectedGoal !== null || view.selectedPr !== null) return false;
  return view.overviewShape === 'focus';
}

function tabBody(tab: ConsoleTab, view: CockpitView, actions: CockpitActions): JSX.Element {
  switch (tab) {
    case 'overview':
      switch (view.overviewShape) {
        case 'focus':
          return <FocusOverview view={view} actions={actions} />;
        default:
          return <Overview view={view} actions={actions} />;
      }
    case 'insights':
      return (
        <>
          {/* This fleet's own side of the cross-fleet pool, above the readings it is
              about: what has been published, when the pool was last read, and which
              fleets have been heard from. It sat above the claim store's page until
              that page went, and Insights is where it belongs anyway — it is a
              reading about what this fleet publishes and reads, on the tab that
              answers what the fleet is costing and reaching. It draws nothing at all
              when no pool is configured; an empty panel there would say something is
              broken. → docs/spec/28-cross-fleet-pool.md#in-the-cockpit */}
          <PoolStatus now={view.now} />
          <InsightsPage
            view={view.insightsView}
            scope={view.insightsScope}
            window={view.insightsWindow}
            poolProject={view.poolProject}
            actions={actions}
          />
        </>
      );
    case 'tickets':
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
    case 'obstacles':
      return <ObstaclesPage open={view.viewingObstacle} ended={view.obstacleEnded} now={view.now} actions={actions} />;
    case 'features':
      return view.state.config.featureBoard ? (
        <FeatureBoard view={view} actions={actions} />
      ) : (
        <p className="muted">This deployment has no feature board.</p>
      );
    case 'pets':
      return view.state.pets === null ? (
        <p className="muted">Pets are hidden on this deployment.</p>
      ) : (
        <PetsPage pets={view.state.pets} now={view.now} blended={view.petsBlended} actions={actions} />
      );
    case 'config':
      return <ConfigPage view={view} actions={actions} />;
  }
}

function GoalGone({ ref_, tab, actions }: { ref_: string; tab: ConsoleTab; actions: CockpitActions }): JSX.Element {
  const number = /^issue:(\d+)$/.exec(ref_)?.[1] ?? null;
  return (
    <>
      <Crumb trail={[tabStep(tab, actions)]} here={number === null ? ref_ : `#${number}`} />
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

function PrCrumb({ page, tab, actions }: { page: PrPageView; tab: ConsoleTab; actions: CockpitActions }): JSX.Element {
  const goalRef = page.goalRef;
  return (
    <Crumb
      trail={[
        tabStep(tab, actions),
        ...(page.goal !== null && goalRef !== null
          ? [{ label: `#${page.goal.number} ${page.goal.title}`, go: () => actions.selectGoal(goalRef) }]
          : []),
      ]}
      here={`PR #${page.pr.number}`}
    />
  );
}

function PrGone({
  number,
  goalRef,
  tab,
  actions,
}: {
  number: number;
  goalRef: string | null;
  tab: ConsoleTab;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <>
      <Crumb
        trail={[
          tabStep(tab, actions),
          ...(goalRef !== null ? [{ label: goalLabel(goalRef), go: () => actions.selectPr(null) }] : []),
        ]}
        here={`PR #${number}`}
      />
      <section className="cn-gone">
        <h2>PR #{number} is not in the current world</h2>
        <p>
          The last scan did not return this pull request — so there is no review, no check and no verdict to draw. That
          is what a pull request closed longer ago than the retention window looks like from here.
        </p>
        <span className="cn-refs">
          <Ref to={`pr:${number}`} />
        </span>
      </section>
    </>
  );
}

function tabStep(tab: ConsoleTab, actions: CockpitActions): CrumbStep {
  return { label: TAB_LABEL[tab], go: () => actions.selectGoal(null) };
}

function goalLabel(ref: string): string {
  return `#${/^issue:(\d+)$/.exec(ref)?.[1] ?? ref}`;
}
