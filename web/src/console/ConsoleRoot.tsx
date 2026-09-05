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
import { ObstaclesPage } from '../components/ObstaclesPage.js';
import { SchedulePanel } from '../components/SchedulePanel.js';
import { InjectPanel } from '../components/InjectPanel.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { Modal } from '../components/Modal.js';
import { Button } from '../components/button.js';
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
    // A selected pull request outranks the goal, which outranks the nav — the same
    // ladder one rung further in. The crumb it draws leads back to the goal rather
    // than to the tab, because that is where the click came from and where leaving
    // the page lands.
    view.prPage !== null ? (
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
    case 'obstacles':
      // Embedded exactly as Insights and the tickets tab are, and for the same
      // reason: it reaches its own route, which `console/` may not, but rendering a
      // component that does is not reaching. Which row is unfolded and whether the
      // terminal tail is open ride in from `Place`, so a link to either opens on it.
      //
      // **In the nav**, in the slot Knowledge held: `TopBar`'s `TABS` carries it
      // since the operator lifted the URL-only rule it shipped under.
      // → docs/spec/27-obstacles.md#in-the-cockpit
      return <ObstaclesPage open={view.viewingObstacle} ended={view.obstacleEnded} now={view.now} actions={actions} />;
    case 'features':
      // Gated exactly as the vivarium is, and for the same reason: a deployment
      // with no board has no tab to reach this, but a stale URL still can. The
      // predicate is the server's own conjunction (`featureBoardOn`) — the
      // operator's flag and a provider with a hierarchy — so this and the route
      // refuse together rather than the page fetching a 404 and drawing a spinner.
      return view.state.config.featureBoard ? (
        <FeatureBoard view={view} actions={actions} />
      ) : (
        <p className="muted">This deployment has no feature board.</p>
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
 * The trail out of a pull request's page: back to the goal it belongs to, or —
 * on a pull request no ticket owns, which the harness works and which therefore
 * reaches this page — back to the tab. Two arms rather than one because the way
 * back has to be somewhere the operator can actually stand, and "the goal" is not
 * always one.
 */
function PrCrumb({ page, tab, actions }: { page: PrPageView; tab: ConsoleTab; actions: CockpitActions }): JSX.Element {
  const goalRef = page.goalRef;
  return (
    <Crumb
      trail={[
        tabStep(tab, actions),
        // The rung between, and only when there is one. It *selects* the goal
        // rather than merely clearing the pull request: this page is reached by a
        // `<Ref>` from anywhere — the overview's pull-request rack among them —
        // and on that way in the place underneath holds no goal at all, so
        // `selectPr(null)` alone lands on the tab and the rung the operator just
        // clicked is skipped. The ref is the page's own reading of what owns it,
        // which is what the rung is labelled off.
        ...(page.goal !== null && goalRef !== null
          ? [{ label: `#${page.goal.number} ${page.goal.title}`, go: () => actions.selectGoal(goalRef) }]
          : []),
      ]}
      here={`PR #${page.pr.number}`}
    />
  );
}

/**
 * A pull request was selected and the world does not carry it — a stale link, or
 * one that has aged past the closed-PR retention window. Said rather than fallen
 * through to the page underneath, for `GoalGone`'s reason: the address bar naming
 * something the screen does not show is a click that reads as doing nothing. The
 * provider is where the answer actually is, so the reference is the offer.
 */
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
          // The goal is still on the *place* even though the pull request over it
          // is not in the world, so the rung it was reached through is still real
          // and is still drawn — off the ref rather than off a page, since the goal
          // may be gone from the world too and the ref is what the place holds.
          // Dropping it would make a stale link the one case where the trail is
          // shorter than the ladder.
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

/** One rung on the trail: what it is called, and what standing on it again does. */
interface CrumbStep {
  label: string;
  go: () => void;
}

/**
 * The tab the situation area is drawn over — the foot of every trail.
 *
 * `selectGoal(null)` clears the pull request with it, so one call is the whole of
 * the way out from either rung. The tab is never *set* here: it is already a tab
 * that could have led to what is drawn, narrowed by `homeTab` at the moment of
 * selection and again on the way in from the address bar.
 * → `docs/spec/17-cockpit.md#nesting`
 */
function tabStep(tab: ConsoleTab, actions: CockpitActions): CrumbStep {
  return { label: TAB_LABEL[tab], go: () => actions.selectGoal(null) };
}

/**
 * What a goal is called on a trail when all that is to hand is its ref — the
 * number, or the ref itself where it is not one the harness minted. `GoalGone`
 * makes the same fallback for the same reason: a ref drawn as itself is still a
 * rung an operator can stand on, where an empty one is a trail with a hole in it.
 */
function goalLabel(ref: string): string {
  return `#${/^issue:(\d+)$/.exec(ref)?.[1] ?? ref}`;
}

/**
 * The trail out of whatever the situation area drew over the tab.
 *
 * **A trail, and not the one back button it was.** The ladder is three rungs deep
 * — tab, goal, pull request — and a single control labelled with the rung beneath
 * it drew two of them, which left the tab a page was hanging off entirely absent
 * from a pull request's page. That is the half of the failure a reader *sees*; the
 * half they act on is that the one label was `TAB_LABEL[tab]`, and nothing that
 * opens a goal or a pull request moved the nav, so it named wherever the nav
 * happened to be last. A goal opened from the queue rail — which is drawn on every
 * tab — while reading Insights offered *‹ Insights* as the way out of it, and a
 * pull request under it a trail leading back there. No reading on that page
 * contains that goal: the trail led somewhere the operator had not been.
 *
 * Both halves are fixed here and in `homeTab`, and they are one fix rather than
 * two: drawing the whole ladder is what makes a wrong foot visible, and narrowing
 * the foot to a tab that lists work is what makes drawing it worth doing.
 *
 * Every rung but the last is a control, because a trail whose middle is inert is a
 * list of words that looks like navigation.
 */
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

/** What each panel calls itself — the same word as the reading that opens it. */
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

/**
 * The console's full-surface overlay: {@link Modal}'s `panel` face, and the head
 * this console draws on it.
 *
 * Local, and not a `Panel`. It was `console/Panel.tsx` — a second exported
 * component under the name the *frame* has, so which box you got depended on
 * which file the import resolved to. A modal is not a frame: it has a backdrop, it
 * has three ways out, and both of those are {@link Modal}'s. What was left is a
 * header of two elements, used twice, right here — which is a local function, not
 * a shared component. → docs/spec/17-cockpit.md#the-frame
 */
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
    // The whole queue, in the same rows the Fleet card draws the head of — one
    // builder, so the three rows on the card and the thirty in here cannot come
    // to say different things about the same candidate.
    case 'upnext': {
      const items = view.upNext;
      if (items.length === 0) return <p className="cn-empty">Nothing is queued.</p>;
      return <PanelRows rows={items.map((item) => queueRow(item, view, actions))} />;
    }
    // The whole feed, not the ten rows the overview card drew: the cap was a
    // card borrowing a page's room, and this is the surface the rest was always
    // going to need.
    case 'signals':
      return <WorldSignals view={view} />;
    // The rows the overview's Environments card drew, now that the reading that
    // opens them is a chip on the bar rather than a sixth of that page.
    case 'environments':
      return <EnvironmentsPanel view={view} />;
    case 'localRun':
      return (
        <LocalRunPanel
          run={state.localRun}
          configured={state.config.localRunConfigured}
          stopConfigured={state.config.localRunStopConfigured}
          refreshConfigured={state.config.localRunRefreshConfigured}
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
          onMessage={(text) => actions.messageLocalRun(text)}
          onRefresh={() => actions.refreshLocalRun()}
          onValidate={(issueNumber, opts) => actions.validateLocally(issueNumber, opts)}
          // The running goal's own row, found through the same origin the panel
          // draws — the goals list is already here, so nothing extra is shipped for
          // a panel most sessions never open.
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
      // The durable work graph, which was the console's second nav destination
      // until every part of it found a better home. A panel now: an archive is
      // consulted rather than worked on, and this way it is reachable from a goal
      // page too — which the tab, outranked by any selected goal, never was.
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
