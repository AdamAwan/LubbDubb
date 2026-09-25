import { useRef, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type {
  GoalPageView,
  GoalSection,
  GoalTab,
  GoalLanding,
  GoalTabOpening,
  ObligationTab,
} from '../view/goalPage.js';
import type { NeedRow } from '../view/needsYou.js';
import {
  buildGoalNav,
  obligationEnvironment,
  planUnderWay,
  splitGoalAsks,
  GOAL_ANCHOR,
  goalLanding,
  goalPaneOf,
  goalPanes,
} from '../view/goalPage.js';
import { GoalCriteria } from '../components/GoalCriteria.js';
import { PartDescriptionsProvider } from '../components/partDescriptions.js';
import { IntakeSitting } from '../components/IntakeSitting.js';
import { PredictionReview } from '../components/PredictionReview.js';
import { Tag } from '../components/tag.js';
import { localRunPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { ValidationSection } from '../components/ValidationSection.js';
import { checkStandings, type CheckStanding } from '../view/validatePane.js';
import { GoalReachMatrix } from '../components/GoalReachMatrix.js';
import { HeadRow } from '../components/panel.js';
import { NeedsBand } from './NeedsBand.js';
import { OrphanBand } from './OrphanBand.js';
import { Button } from '../components/button.js';
import { logUsage } from '../cockpit/usage.js';
import { TabbedPanel, type PanelTab } from './TabbedPanel.js';
import { buildFolds, Disclosure, type Fold } from './goalFold.js';
import { Header } from './goalHeader.js';
import { LocalValidation, RemoteValidation, RunStrip, Signals } from './goalRunners.js';
import { PlanWaves } from './goalPlan.js';
import { Environments, REACH_TONE, WatchWindow } from './goalEnvironments.js';
import { Instructions, Reference, Sequence, Spend, Tail, Ticket } from './goalCards.js';

// → docs/spec/17-cockpit.md

export function GoalPage({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const folds = buildFolds(page, view, actions);
  /* The landing is latched to the visit, never re-read from the live snapshot:
     the rule answers once, on arrival at this goal, and the answer is held until
     the operator picks a pane or leaves. The operator's pick beats it and is the
     only thing read once made.
     → docs/spec/17-cockpit.md#which-pane-opens */
  const opening = useGoalLanding(`issue:${page.issue.number}`, page);
  /* A `?pane=` from a deployment that draws that pane, or a bookmark from before it stopped
     doing so, would otherwise select a tab the row does not carry and leave the panel empty.
     → docs/spec/17-cockpit.md#the-panes */
  const picked = view.goalTab !== null && goalPanes(page).includes(view.goalTab) ? view.goalTab : null;
  const tab = picked ?? opening.tab;
  /* Which asks the open pane owns, and which stay rows above the navigation.
     → docs/spec/17-cockpit.md#an-ask-is-the-loudest-thing-on-its-page */
  const asks = splitGoalAsks(page, view.state.escalations, tab);
  return (
    <div className="cn-goal">
      <Header page={page} view={view} actions={actions} />
      {/* Every ask this goal carries, a row each, above the navigation. A row is
          all one press: the whole of an ask lives in the ask panel already, so
          what belongs here is that there is one and which stage it is about —
          and a row costs the page one line, where a band cost it three hundred.
          → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work */}
      <AskLines rows={asks.lines} view={view} actions={actions} />
      {/* The stages are the tabs, and the tabs are cut out of the panel they
          select: one object, so the row cannot read as a strip that merely sits
          above the pane. → docs/spec/17-cockpit.md#the-panes */}
      <TabbedPanel
        tabs={goalTabs(page, tab, picked, opening)}
        selected={tab}
        onSelect={(id) => {
          if (id !== tab) logUsage('goal.expand');
          actions.openGoalTab(id as GoalTab);
        }}
        label="This goal"
      >
        {/* The pane's own asks, in full and first: this is the pane the ask is
            about, and one line of small print above the navigation is not what a
            filled primary button inside the pane is competing with.
            → docs/spec/17-cockpit.md#an-ask-is-the-loudest-thing-on-its-page */}
        {asks.inPane.length > 0 && (
          <div className="cn-paneasks">
            {asks.inPane.map((row) => (
              <NeedsBand key={row.id} row={row} view={view} actions={actions} checksBelow={row.kind === 'validate'} />
            ))}
          </div>
        )}
        {tab === 'ask' && <TicketPane page={page} view={view} actions={actions} folds={folds} />}
        {tab === 'plan' && <WorkPane page={page} view={view} actions={actions} folds={folds} />}
        {tab === 'validate' && <ValidatePane page={page} view={view} actions={actions} folds={folds} />}
        {tab === 'close' && <ClosePane page={page} view={view} actions={actions} folds={folds} />}
        {tab === 'watch' && <WatchPane page={page} view={view} actions={actions} folds={folds} />}
      </TabbedPanel>
      {/* Below the panel, because what it asks is about the goal's place on the
          board rather than about any stage of the work — and because the ask
          itself is already announced as a row at the top. */}
      <OrphanBand issue={page.issue} view={view} actions={actions} />
    </div>
  );
}

/** One row per ask, in the order the rail ranked them. */
function AskLines({
  rows,
  view,
  actions,
}: {
  rows: readonly NeedRow[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="cn-asklines">
      {rows.map((row) => (
        <NeedsBand key={row.id} row={row} view={view} actions={actions} line />
      ))}
    </div>
  );
}

/**
 * Carries the landing between renders. The decision is `goalLanding`'s — this
 * only holds its answer, which is what keeps the rule out of a render's reach.
 * → docs/spec/17-cockpit.md#which-pane-opens
 */
function useGoalLanding(ref: string, page: GoalPageView): GoalTabOpening {
  const held = useRef<GoalLanding | null>(null);
  held.current = goalLanding(held.current, ref, page);
  return held.current.opening;
}

/**
 * The goal's stages as tabs. A stage carries a reading and a meter as well as a
 * name, because the row is where the goal *is* as much as where you can go — and
 * a dot where an ask is waiting in that pane, which is the whole of what a band
 * above the navigation used to say.
 */
function goalTabs(page: GoalPageView, tab: GoalTab, chosen: GoalTab | null, opening: GoalTabOpening): PanelTab[] {
  return buildGoalNav(page).map((entry) => ({
    id: entry.tab,
    tone: `cn-t-${entry.tone}`,
    meter: entry.done,
    reading: entry.reading,
    title:
      entry.tab === tab && chosen === null
        ? `Opened here because ${opening.why}`
        : `${entry.label}: ${entry.reading} — go to it`,
    label: (
      <>
        {entry.label}
        {/* The environment that carries this obligation, on the control that is it. A tab
            that said only "Validate" would be an obligation with nowhere to be discharged,
            and which environment owes what is configuration the operator wrote weeks ago.
            Two of them and the pane itself carries a picker.
            → docs/spec/17-cockpit.md#the-panes */}
        {entry.on.length > 0 && (
          <i className="cn-tabp-on" title={`Carried by ${entry.on.join(' and ')}`}>
            {entry.on.length === 1 ? entry.on[0] : `${String(entry.on.length)} environments`}
          </i>
        )}
        {entry.needsYou && <i className="cn-tabp-dot" title="Something here needs you" />}
      </>
    ),
  }));
}

function TicketPane({
  page,
  view,
  actions,
  folds,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  folds: Record<GoalSection, Fold>;
}): JSX.Element {
  return (
    <>
      <Ticket issue={page.issue} refUrls={view.state.refUrls} />
      <div className="cn-gcols">
        <div className="cn-stack">
          <Instructions issue={page.issue} actions={actions} />
        </div>
        <div className="cn-stack">
          <Sequence page={page} fold={folds.sequence} />
        </div>
      </div>
    </>
  );
}

function WorkPane({
  page,
  view,
  actions,
  folds,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  folds: Record<GoalSection, Fold>;
}): JSX.Element {
  /* One read for the whole board rather than one per card, and a component cannot
     read a context it renders itself, which is why the body is its own.
     → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written */
  return (
    <PartDescriptionsProvider issueNumber={page.issue.number}>
      <WorkPaneBody page={page} view={view} actions={actions} folds={folds} />
    </PartDescriptionsProvider>
  );
}

function WorkPaneBody({
  page,
  view,
  actions,
  folds,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  folds: Record<GoalSection, Fold>;
}): JSX.Element {
  const underWay = planUnderWay(page);
  const gatedPlan = page.plan !== null && !page.plan.revealed;
  /* Planning waits on the operator here, so the sitting is drawn first and the criteria
     card is not: it asks the same question, and asked twice the operator answers one.
     → docs/spec/17-cockpit.md#the-reveal-gate */
  const sitting = page.plan === null && page.issue.pickup.status === 'sitting';
  return (
    <>
      {sitting && (
        <section className="cn-card">
          <h3>Before planning</h3>
          <IntakeSitting
            issueNumber={page.issue.number}
            aligning={page.issue.pickup.reasons.some((r) => r.startsWith('checking your criteria'))}
            onClosed={() => actions.refresh()}
          />
        </section>
      )}
      <PlanWaves page={page} view={view} actions={actions} fold={folds.prediction} />
      {/* Below the plan rather than above it: what "done" means is read against the
          shape the fleet proposed, and the card draws nothing at all where the
          criteria routes are not mounted. A part with a task behind it is what
          makes the next version drift, which is the one thing the form has to know
          before the operator starts typing. Not while the plan is at its gate: the
          gate asks the same question, and asked twice the operator answers one.
          → docs/spec/17-cockpit.md#goal-criteria-and-drift */}
      {!gatedPlan && !sitting && (
        <GoalCriteria
          issueNumber={page.issue.number}
          workStarted={[...page.parts.map((p) => p.part), ...page.retiredParts].some((part) => part.taskId !== null)}
          hasChecks={page.checks.length > 0}
          open={folds.criteria.open}
          settled={folds.criteria.settled}
          onToggle={folds.criteria.onToggle}
          now={view.now}
        />
      )}
      {/* Last on the pane, once the plan is approved and the work is under way: it is
          a record of a moment that has passed, and everything above it — the parts,
          the description in front, what "done" means, the pull requests — is the work
          itself. At the plan's gate it is the opposite way round and the plan card
          draws it above the parts.
          → docs/spec/17-cockpit.md#where-the-prediction-is-drawn */}
      {underWay && (
        <PredictionReview
          issueNumber={page.issue.number}
          revealed={page.plan?.revealed ?? false}
          outcomeAsked={page.needs.some((need) => need.kind === 'outcome')}
          plan={page.plan}
          parts={page.parts.map((p) => p.part)}
          open={folds.prediction.open}
          settled={folds.prediction.settled}
          onToggle={folds.prediction.onToggle}
          now={view.now}
        />
      )}
    </>
  );
}

/**
 * What this goal owes in the way of checks, in two kinds of panel. **Checks** is the only list of
 * checks there is, banded by where each one's answer is coming from. Below it, one panel per
 * runner — the machine in front of the operator, then each environment the goal has a sheet for —
 * and each of those draws *runs*: a press, and what the last few carried. A runner panel never
 * re-lists the checks, which is what made three cards read as three sets of tests.
 * → docs/spec/17-cockpit.md#the-validate-pane, docs/spec/36-remote-validation.md
 */
function ValidatePane({
  page,
  view,
  actions,
  folds,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  folds: Record<GoalSection, Fold>;
}): JSX.Element {
  const showing = obligationEnvironment(page, 'validate', view.sheetEnvironment);
  /* Boxes write the selection of the environment the pane is showing — the same one the panel
     below draws, which is what makes the box and the rows under it one answer. */
  const standings = checkStandings(page.checks, page.remoteSheets, showing);
  return (
    <>
      <ObligationPicker page={page} tab="validate" showing={showing} actions={actions} />
      {/* Before the list, because the question an operator arrives with is whether a run would
          answer some of it. The standings are computed once, here, and handed to both halves: the
          bands and the strip's count of what is still unanswered are one reading, and two of them
          would be free to disagree. → docs/spec/17-cockpit.md#the-validate-pane */}
      <RunStrip page={page} view={view} actions={actions} />
      <Validation
        page={page}
        standings={standings}
        actions={actions}
        refUrls={view.state.refUrls}
        desktopFolder={view.state.config.desktopFolder}
        fold={folds.validation}
      />
      {/* The runners, below the list they answer. Each one is a panel of its own runs — the press
          and what the last few carried — because a run is the unit of work here: one environment,
          one tenant, one dev environment, so a press takes a set of checks and a second press
          queues behind it. → docs/spec/17-cockpit.md#the-validate-pane */}
      <LocalValidation page={page} view={view} actions={actions} fold={folds.localValidation} />
      {/* A sheet is assembled for an arrival and answers rows of the set above it, so it is
          drawn with the set rather than with the arrival. → docs/spec/36-remote-validation.md */}
      <RemoteValidation
        page={page}
        view={{ ...view, sheetEnvironment: showing }}
        actions={actions}
        fold={folds.remoteValidation}
      />
    </>
  );
}

/**
 * The close-out and what it is owed against: how far the work has reached, every part against
 * every environment, and the record an operator starts reading when they close — spend, the
 * tail, and this goal's subtree of the work graph. The record is an archive and not a step,
 * which is why it folds in here rather than taking a tab of its own.
 * → docs/spec/17-cockpit.md#the-panes
 */
function ClosePane({
  page,
  view,
  actions,
  folds,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  folds: Record<GoalSection, Fold>;
}): JSX.Element {
  const showing = obligationEnvironment(page, 'close', view.sheetEnvironment);
  return (
    <>
      <ObligationPicker page={page} tab="close" showing={showing} actions={actions} />
      <Environments page={page} actions={actions} now={view.now} fold={folds.environments} only={showing} />
      {/* Every part against every environment, unscoped: the rows above are one environment's and
          this is the question they cannot ask. It says its own account out loud, so there is no
          second copy of that line on the pane. → docs/spec/24-environments.md */}
      <GoalReachMatrix page={page} />
      <div className="cn-gcols">
        <div className="cn-stack">
          <Spend issue={page.issue} />
        </div>
        <div className="cn-stack">
          <Tail issue={page.issue} actions={actions} fold={folds.tail} />
        </div>
      </div>
      <Reference page={page} view={view} fold={folds.record} />
      {goalPaneOf(page, 'signals') === 'close' && (
        <Signals page={page} actions={actions} refUrls={view.state.refUrls} fold={folds.signals} />
      )}
    </>
  );
}

/**
 * The post-deploy watch: what this goal declared should be asked of a live environment, and
 * what the window opened on its arrival has read back. Last, and after the close, because a
 * watch opens on an arrival in production — which for most deployments happens *after* the
 * work is closed. → docs/spec/29-post-deploy-watch.md, docs/spec/17-cockpit.md#the-panes
 */
function WatchPane({
  page,
  view,
  actions,
  folds,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  folds: Record<GoalSection, Fold>;
}): JSX.Element {
  const showing = obligationEnvironment(page, 'watch', view.sheetEnvironment);
  const window = page.watches.find((w) => w.environment === showing);
  return (
    <>
      <ObligationPicker page={page} tab="watch" showing={showing} actions={actions} />
      <Signals page={page} actions={actions} refUrls={view.state.refUrls} fold={folds.signals} />
      <WatchWindow
        watch={window}
        environment={showing}
        issueNumber={page.issue.number}
        now={view.now}
        actions={actions}
      />
    </>
  );
}

/**
 * The environments that carry one obligation, where more than one does. One is already named
 * on the tab, and none is the deployment saying the obligation is a person's — a control with
 * one choice on it is a control that cannot be wrong, which is a control nobody needs.
 *
 * It writes the same `?sheet=` the sheet card has always been picked through, so the pick an
 * operator makes here is the one the address bar carries.
 * → docs/spec/17-cockpit.md#the-panes
 */
function ObligationPicker({
  page,
  tab,
  showing,
  actions,
}: {
  page: GoalPageView;
  tab: ObligationTab;
  showing: string | null;
  actions: CockpitActions;
}): JSX.Element | null {
  const names = page.obligations[tab];
  if (names.length < 2) return null;
  return (
    <HeadRow className="cn-envpick">
      {names.map((name) => {
        const env = page.environments.find((e) => e.environment === name);
        return (
          <Button key={name} onClick={() => actions.openRemoteSheet(name)} title={`What this goal reads in ${name}`}>
            {name}
            {env !== undefined && (
              <Tag tone={REACH_TONE[env.status]} fill={name === showing}>
                {env.status}
              </Tag>
            )}
          </Button>
        );
      })}
    </HeadRow>
  );
}

function Validation({
  page,
  standings,
  actions,
  refUrls,
  desktopFolder,
  fold,
}: {
  page: GoalPageView;
  standings: Map<string, CheckStanding>;
  actions: CockpitActions;
  refUrls: Record<string, string>;
  desktopFolder: string;
  fold: Fold;
}): JSX.Element {
  const { issue, plan, checks } = page;
  const live = checks.filter((c) => c.supersededReason === null);
  const settled = live.filter((c) => c.state === 'passed' || c.state === 'waived').length;

  return (
    <section className="cn-card" id={GOAL_ANCHOR.validation}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Checks" />
        {live.length > 0 && (
          <i className="cn-n">
            {settled} of {live.length} done
          </i>
        )}
        {live.length === 0 && <i className="cn-n">no checks</i>}
        {/* Where the checks come from, said on the card that manages them: an
            operator who wants the wording changed has to know it is the plan that
            writes it, and this is the only place that connection is drawn. */}
        <span className="cn-more">
          written by the plan
          {plan !== null && (
            <button type="button" className="cn-linkish" onClick={() => actions.viewPlan(plan.id)}>
              amend it there ↗
            </button>
          )}
        </span>
        {/* The one control on this card that is not about a particular check, and
            it sits here because most checks cannot begin until it has been used:
            it opens the operator's own Claude Code and asks it to get the
            application up. An anchor rather than a button — a deep link is a
            destination — and outside `cn-more` so it reads as an action beside
            that sentence rather than as part of it. Drawn unconditionally: the
            `local-run` prompt always has a body, so there is nothing to check
            first and no configuration state to fall out of step with. */}
        <DesktopLink
          folder={desktopFolder}
          prompt={localRunPrompt(issue.number)}
          explain="so this goal’s work is running on the machine in front of you — then it offers you the checks."
        />
      </h3>
      {fold.open && (
        <div className="cn-vin">
          <ValidationSection
            checks={checks}
            plan={page.checkPlan}
            issueNumber={issue.number}
            resources={page.checkResources}
            refUrls={refUrls}
            desktopFolder={desktopFolder}
            standings={standings}
            onSelect={(environment, rowId, selected) =>
              actions.selectRemoteRow(issue.number, environment, rowId, selected)
            }
            look={{ tone: 'secondary' }}
            onResult={(checkId, result, note) =>
              actions.setValidation(issue.number, checkId, { kind: 'result', result, note })
            }
            onWaive={(checkId, reason) => actions.setValidation(issue.number, checkId, { kind: 'waive', reason })}
            onReset={(checkId) => actions.setValidation(issue.number, checkId, { kind: 'reset' })}
            onHandover={(checkId, to) => actions.setValidation(issue.number, checkId, { kind: 'handover', to })}
          />
        </div>
      )}
    </section>
  );
}
