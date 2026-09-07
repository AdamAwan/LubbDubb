import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions, ConsolePanel, ConsoleTab } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { PrPageView } from '../view/prPage.js';
import { TAB_LABEL, TopBar } from './TopBar.js';
import { KIND_LABEL, KIND_SYMBOL, QueueRail, subjectLabel } from './QueueRail.js';
import { needBody } from './NeedsBand.js';
import { GoalPage } from './GoalPage.js';
import { PrPage } from './PrPage.js';

import { Overview, queueRow } from './Overview.js';
import { projectName } from '../view/updateAsks.js';
import { WorldSignals } from './WorldSignals.js';
import { EnvironmentsPanel } from './EnvironmentsPanel.js';
import { PanelRows } from './PanelRow.js';
import { RecoveryPanel } from '../components/RecoveryPanel.js';
import { TicketsPanel } from '../components/TicketsPanel.js';
import { FeatureBoard } from '../components/FeatureBoard.js';
import { ConfigPage } from '../components/ConfigPage.js';
import { RecordPanel } from '../components/RecordPanel.js';
import { PoolStatus } from '../components/PoolStatus.js';
import { LaunchPanel } from '../components/LaunchPanel.js';
import { SetupPanel } from '../components/SetupPanel.js';
import { PetsPanel } from '../components/PetsPanel.js';
import { PetsPage } from '../components/PetsPage.js';
import { Vivarium } from './Vivarium.js';
import { BuildPanel } from '../components/BuildPanel.js';
import { LocalRunPanel } from '../components/LocalRunPanel.js';
import { InsightsPage } from '../components/InsightsPage.js';
import { ReviewPackScreen } from '../components/ReviewPackScreen.js';
import { ObstaclesPage } from '../components/ObstaclesPage.js';
import { SchedulePanel } from '../components/SchedulePanel.js';
import { InjectPanel } from '../components/InjectPanel.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { Modal } from '../components/Modal.js';
import { Button } from '../components/button.js';
import { relTime } from '../components/util.js';
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

  const situation =
    // The top rung, and above `PrGone` on purpose — a pack outlives the pull
    // request's presence in the world. → docs/spec/17-cockpit.md#the-pull-request-page
    view.viewingReviewPack !== null ? (
      <>
        <PackCrumb view={view} actions={actions} />
        <ReviewPackScreen
          key={view.viewingReviewPack}
          prNumber={view.viewingReviewPack}
          goalRef={view.selectedGoal}
          openIdea={view.reviewIdea}
          refUrls={view.state.refUrls}
          onOpenIdea={(id) => actions.openReviewIdea(id)}
        />
      </>
    ) : view.prPage !== null ? (
      <>
        <PrCrumb page={view.prPage} tab={view.tab} actions={actions} />
        <PrPage page={view.prPage} view={view} actions={actions} />
      </>
    ) : view.selectedPr !== null ? (
      <PrGone number={view.selectedPr} goalRef={view.selectedGoal} tab={view.tab} actions={actions} />
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

  const panel = renderPanel(view, actions);

  return (
    <div className="cn">
      <TopBar view={view} actions={actions} />
      {recovery}
      <div className="cn-body">
        <aside className="cn-rail">
          <QueueRail view={view} actions={actions} />
        </aside>
        <main className="cn-sit">{situation}</main>
        {/* Last in the body rather than inside the rail, because document order is
            what decides where it lands when the shell collapses to one column: the
            end of the page, scrolled to after the work, instead of a strip wedged
            between the queue and the work. The wide arrangement is unchanged — the
            sheet places it back on the rail's floor, below the rail's scrolling list,
            so a long queue scrolls behind it. Absent entirely when the snapshot ships
            no vivarium — the feature off, or on and hidden. */}
        {view.state.pets !== null && (
          <Vivarium
            pets={view.state.pets}
            runningAgents={view.state.agents.filter((a) => a.status === 'running').length}
            paused={view.state.control.paused}
            onOpen={() => actions.openPanel('pets')}
            onOpenPage={() => {
              actions.selectGoal(null);
              actions.openTab('pets');
            }}
            onHatch={(id) => actions.hatchEgg(id)}
          />
        )}
      </div>
      {panel}
    </div>
  );
}

function tabBody(tab: ConsoleTab, view: CockpitView, actions: CockpitActions): JSX.Element {
  switch (tab) {
    case 'overview':
      return <Overview view={view} actions={actions} />;
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
        <PetsPage pets={view.state.pets} />
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

/**
 * The way out of a pack: the tab, the goal where the place holds one, and the pull
 * request it is about — that rung drawn from the number alone, because a pack
 * outlives the pull request's presence in the world and a crumb that vanished with
 * it would leave the reader with no way back.
 */
function PackCrumb({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const prNumber = view.viewingReviewPack;
  const goalRef = view.selectedGoal;
  return (
    <Crumb
      trail={[
        tabStep(view.tab, actions),
        ...(view.goalPage !== null && goalRef !== null
          ? [
              {
                label: `#${view.goalPage.issue.number} ${view.goalPage.issue.title}`,
                go: () => {
                  actions.viewReviewPack(null);
                  actions.selectGoal(goalRef);
                },
              },
            ]
          : []),
        ...(prNumber !== null ? [{ label: `PR #${prNumber}`, go: () => actions.viewReviewPack(null) }] : []),
      ]}
      here="Review pack"
    />
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

interface CrumbStep {
  label: string;
  go: () => void;
}

function tabStep(tab: ConsoleTab, actions: CockpitActions): CrumbStep {
  return { label: TAB_LABEL[tab], go: () => actions.selectGoal(null) };
}

function goalLabel(ref: string): string {
  return `#${/^issue:(\d+)$/.exec(ref)?.[1] ?? ref}`;
}

function Crumb({ trail, here }: { trail: readonly CrumbStep[]; here: string }): JSX.Element {
  return (
    <nav className="cn-crumb" aria-label="Breadcrumb">
      {/* The mark that says *out*, once, at the head — not on each rung. On every
          one it reads as a separator competing with the slash; on the last rung it
          would point out of the page you are on. */}
      <span className="cn-crumbback" aria-hidden="true">
        ‹
      </span>
      {trail.map((step) => (
        <span key={step.label} className="cn-crumbstep">
          <button type="button" onClick={step.go}>
            {step.label}
          </button>
          <span className="cn-crumbsep">/</span>
        </span>
      ))}
      <span className="cn-crumbnow">{here}</span>
    </nav>
  );
}

const PANEL_TITLE: Record<Exclude<ConsolePanel, null | { ask: string }>, string> = {
  faults: 'Faults',
  launch: 'Launch',
  build: 'Build',
  pets: 'Vivarium',
  localRun: 'Running locally',
  setup: 'Setup',
  record: 'The record',
  upnext: 'Up next',
  signals: 'World signals',
  environments: 'Environments',
};

function PanelShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Modal face="panel" label={title} onClose={onClose}>
      <header className="cn-panel-head">
        <h2>{title}</h2>
        <Button onClick={onClose}>Close</Button>
      </header>
      {children}
    </Modal>
  );
}

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
      <PanelShell title={`${KIND_SYMBOL[row.kind]} Needs you · ${KIND_LABEL[row.kind]}`} onClose={close}>
        <AskSubject row={row} actions={actions} />
        <div className="cn-pbody">{body}</div>
      </PanelShell>
    );
  }

  return (
    <PanelShell title={PANEL_TITLE[panel]} onClose={close}>
      <div className="cn-pbody">{panelBody(panel, view, actions)}</div>
    </PanelShell>
  );
}

function AskSubject({ row, actions }: { row: NeedRow; actions: CockpitActions }): JSX.Element {
  const subject = subjectLabel(row);
  if (row.goalRef !== null) {
    const ref = row.goalRef;
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
    case 'upnext': {
      const items = view.upNext;
      if (items.length === 0) return <p className="cn-empty">Nothing is queued.</p>;
      return <PanelRows rows={items.map((item) => queueRow(item, view, actions))} />;
    }
    case 'signals':
      return <WorldSignals view={view} />;
    case 'environments':
      return <EnvironmentsPanel view={view} />;
    case 'localRun':
      return (
        <LocalRunPanel
          run={state.localRun}
          configured={state.config.localRunConfigured}
          stopConfigured={state.config.localRunStopConfigured}
          refreshConfigured={state.config.localRunRefreshConfigured}
          goals={state.world.issues}
          targets={state.localRunTargets}
          now={view.now}
          onStart={(issueNumber, ref) => actions.startLocalRun(issueNumber, ref)}
          onStop={() => actions.stopLocalRun()}
          onMessage={(text) => actions.messageLocalRun(text)}
          onRefresh={() => actions.refreshLocalRun()}
          onValidate={(issueNumber, opts) => actions.validateLocally(issueNumber, opts)}
          validation={
            state.localRun === null
              ? null
              : (state.world.issues.find((i) => `issue:${String(i.number)}` === state.localRun?.originRef)
                  ?.localValidation ?? null)
          }
          validationConfigured={state.config.localRunConfigured}
          fetchOutput={() => actions.localRunOutput()}
        />
      );
    case 'setup':
      return <SetupPanel onClose={() => actions.openPanel(null)} />;
    case 'record':
      return <RecordPanel now={view.now} />;
    case 'build':
      return (
        <BuildPanel
          build={state.build}
          project={projectName(state)}
          now={view.now}
          onUpgrade={(action, opts) => actions.upgrade(action, opts)}
          onCheck={() => actions.checkBuild()}
          onPull={() => actions.pullProject()}
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

const FAULT_ROWS = 40;

function FaultLog({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { errors } = view.state;
  return (
    <>
      <div className="cn-acts">
        <ConfirmButton
          ghost
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
