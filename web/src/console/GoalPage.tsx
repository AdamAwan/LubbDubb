import { useRef, useState, type JSX, type MutableRefObject } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type {
  GoalPageView,
  GoalSection,
  GoalTab,
  GoalLanding,
  GoalTabOpening,
  ObligationTab,
  PartGroup,
} from '../view/goalPage.js';
import type { NeedRow } from '../view/needsYou.js';
import {
  buildGoalNav,
  goalSectionsOpen,
  obligationEnvironment,
  planUnderWay,
  planVerdictAsk,
  splitGoalAsks,
  GOAL_ANCHOR,
  goalLanding,
  goalPanes,
  reachBands,
  reachCount,
  GOAL_SECTIONS,
} from '../view/goalPage.js';
import type {
  Agent,
  EnvironmentGate,
  GoalReachStatus,
  GoalWatchCheckView,
  GoalWatchView,
  Issue,
  OpenPullRequest,
  PlanPart,
  PullRequest,
  ValidationVerdict,
  WatchCheckVerdict,
} from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { GoalCriteria } from '../components/GoalCriteria.js';
import { PrDescription } from '../components/PrDescription.js';
import { PartDescriptionsProvider, PartDescriptionTag, usePartDescriptions } from '../components/partDescriptions.js';
import { PlanRevealGate } from '../components/PlanRevealGate.js';
import { PredictionReview } from '../components/PredictionReview.js';
import { ProfilePicker } from '../components/ProfilePicker.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { InstructionModal } from '../components/InstructionModal.js';
import { GateReleaseModal } from '../components/GateReleaseModal.js';
import { EndRunModal } from '../components/EndRunModal.js';
import { renderRichText } from '../components/richText.js';
import { issueTypeTone } from '../issueGroups.js';
import { Tag, type TagTone } from '../components/tag.js';
import { fmtUsd, relTime, waitedFor } from '../components/util.js';
import { Ref, TicketLink } from '../components/refs.js';
import { waitingOnThis, waitsOn, waveOf, wavesOf } from '../view/sequence.js';
import { askPrompt, localRunPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { Icon } from '../components/icons.js';
import { PanelRows, type PanelRowModel } from './PanelRow.js';
import { closedPrRow, prRow } from './prRow.js';
import {
  CONTROL_CLASS,
  ControlBar,
  ControlButton,
  ControlGroup,
  ControlSegment,
  ControlSegments,
} from '../components/controls.js';
import { ValidationSection } from '../components/ValidationSection.js';
import { checkStandings, pressBreakdown, pressableRows, type CheckStanding } from '../view/validatePane.js';
import { GoalReachMatrix } from '../components/GoalReachMatrix.js';
import { HeadRow } from '../components/panel.js';
import { SignalsSection } from '../components/SignalsSection.js';
import { RemoteValidationSection } from '../components/RemoteValidationSection.js';
import { watchBucket } from '../worldBuckets.js';
import { stateColour } from '../stateColour.js';
import { WorkRecord } from '../components/WorkRecord.js';
import { NeedsBand } from './NeedsBand.js';
import { OrphanBand } from './OrphanBand.js';
import { AgentOnIt } from '../components/AgentOnIt.js';
import { ValidateLocallyModal } from '../components/ValidateLocallyModal.js';
import { LocalValidationReport } from './LocalValidationReport.js';
import {
  inFlight,
  localValidationOffer,
  localValidationSaid,
  STATUS_WORD,
  validateLocallyQuestion,
} from '../view/localValidation.js';
import { Button } from '../components/button.js';
import { logUsage } from '../cockpit/usage.js';
import { TabbedPanel, type PanelTab } from './TabbedPanel.js';

// → docs/spec/17-cockpit.md

const LOCAL_VALIDATION_ANCHOR = 'cn-local-validation';

const LIVE_AGENT = new Set<Agent['status']>(['starting', 'running', 'waiting']);

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
  /* The provider is above the body rather than around each reader because the board
     and the panel ask the same question of different parts — and a component cannot
     read a context it renders itself, which is why the body is its own.
     → docs/spec/17-cockpit.md#one-panel-for-the-part-in-front */
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
  /* The chosen card itself, so the panel can draw its pointer under it. The board's
     columns wrap on a narrow pane, so where that card ends up is a question only the
     laid-out page can answer — a share of the width would point at whichever card
     happened to be there. → docs/spec/17-cockpit.md#one-panel-for-the-part-in-front */
  const chosenRef = useRef<HTMLDivElement | null>(null);
  const underWay = planUnderWay(page);
  const describable = page.parts
    .map(({ part }, i) => ({ part, position: i + 1 }))
    .filter((p) => p.part.prNumber !== null);
  /* The operator's pick and nothing else. A part opened for them was a panel of
     prose between the board and the criteria on every visit to every goal, for a
     part nobody had asked about — the card's own standing already says which parts
     want describing, and the card is the press.
     → docs/spec/17-cockpit.md#one-panel-for-the-part-in-front */
  const chosen = describable.find((p) => p.part.slug === view.goalPart) ?? null;
  return (
    <>
      <PlanWaves
        page={page}
        view={view}
        actions={actions}
        fold={folds.prediction}
        chosen={chosen?.part.slug ?? null}
        chosenRef={chosenRef}
      />
      {/* One panel, for the part in front — never one per part. A goal is five
          parts, and five descriptions stacked is five walls of prose an operator tells
          apart by counting headings. Which part a description belongs to is a question
          the board above already answers, so the board is where the part is chosen and
          the panel follows the choice.

          Directly under the board, above the criteria card: the panel points back at
          the card it was opened for, and a pointer with another card in between points
          at that one instead.
          → docs/spec/17-cockpit.md#one-panel-for-the-part-in-front */}
      {chosen !== null && chosen.part.prNumber !== null && (
        <PrDescription
          issueNumber={page.issue.number}
          slug={chosen.part.slug}
          position={chosen.position}
          title={chosen.part.title}
          row={partPrRow(page, chosen.part.prNumber, view, actions)}
          anchor={chosenRef}
          desktopFolder={view.state.config.desktopFolder}
          now={view.now}
        />
      )}
      {/* Below the plan rather than above it: what "done" means is read against the
          shape the fleet proposed, and the card draws nothing at all where the
          criteria routes are not mounted. A part with a task behind it is what
          makes the next version drift, which is the one thing the form has to know
          before the operator starts typing. */}
      <GoalCriteria
        issueNumber={page.issue.number}
        workStarted={[...page.parts.map((p) => p.part), ...page.retiredParts].some((part) => part.taskId !== null)}
        open={folds.criteria.open}
        settled={folds.criteria.settled}
        onToggle={folds.criteria.onToggle}
        now={view.now}
      />
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

interface Fold {
  open: boolean;
  /**
   * Whether `open` is the operator's own answer rather than the page's default. A
   * card whose reading only it holds — the criteria, the prediction — narrows the
   * default it was handed, and must not narrow a fold somebody opened on purpose.
   * → docs/spec/17-cockpit.md#folding-what-is-not-relevant-yet
   */
  settled: boolean;
  onToggle: (open: boolean) => void;
  reveal: () => void;
}

function buildFolds(page: GoalPageView, view: CockpitView, actions: CockpitActions): Record<GoalSection, Fold> {
  const byDefault = goalSectionsOpen(page);
  const entries = GOAL_SECTIONS.map((section): [GoalSection, Fold] => {
    const settled = view.goalOpen.has(section) || view.goalShut.has(section);
    const open = view.goalOpen.has(section) ? true : view.goalShut.has(section) ? false : byDefault[section];
    return [
      section,
      {
        open,
        settled,
        onToggle: (next) => {
          if (next) logUsage('goal.expand');
          actions.openGoalSection(section, next);
        },
        reveal: () => {
          if (!open) actions.openGoalSection(section, true);
        },
      },
    ];
  });
  return Object.fromEntries(entries) as Record<GoalSection, Fold>;
}

function Reference({ page, view, fold }: { page: GoalPageView; view: CockpitView; fold: Fold }): JSX.Element {
  const ref = `issue:${page.issue.number}`;
  return (
    <div className="cn-refs-foot">
      {/* Embedded exactly as the work tree and the launch desk are: it reaches its
          own route, which `console/` may not, but rendering a component that does
          is not reaching — the import ban is on `api.js` and still holds.

          Its disclosure is *its own* rather than one of ours, because the count in
          its heading is: only it knows how many nodes there are, and a heading
          drawn out here would either carry no count or carry a stale one. Folded
          away it also fetches nothing, which is what keeps "on open, never polled"
          true now that the card no longer opens with the page. */}
      <section className="cn-card">
        <WorkRecord goalRef={ref} now={view.now} open={fold.open} onToggle={fold.onToggle} />
      </section>
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <button type="button" className="cn-disc" aria-expanded={open} onClick={() => onToggle(!open)}>
      <i className="cn-caret">{open ? '▾' : '▸'}</i>
      {label}
    </button>
  );
}

function Header({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { issue } = page;
  const { config } = view.state;
  const [raisingBug, setRaisingBug] = useState(false);
  const watched = watchBucket(issue.labels, config.watchLabel);
  const finished = issue.conclusion.verdict === 'done';
  const moreWork = issue.conclusion.verdict === 'more_work';
  const [instructing, setInstructing] = useState(false);
  const [endingRun, setEndingRun] = useState(false);
  const owed = issue.validation !== null && issue.validation.state === 'flagged' ? issue.validation : null;
  const standing = issue.instructions.length;
  const live = page.agents.filter((a) => a.onPr === null && LIVE_AGENT.has(a.agent.status)).length;
  const livePr = page.agents.filter((a) => a.onPr !== null && LIVE_AGENT.has(a.agent.status)).length;
  const retained = issue.run !== undefined && !issue.run.dismissed;
  const ended = issue.run !== undefined && issue.run.dismissed;

  return (
    <div className="cn-gh">
      <div className="cn-ghid">
        <h1>
          #{issue.number} · {issue.title}
        </h1>
        {/* What the goal *is*, beside its name: the tracker's own two words for it.
            Neither is a verdict anybody passed on the work, which is why they sit
            up here rather than in the row below. */}
        {issue.issueType !== undefined && (
          <Tag tone={issueTypeTone(issue.issueType)} fill={issueTypeTone(issue.issueType) !== undefined}>
            {issue.issueType}
          </Tag>
        )}
        <StateChip state={issue.workItemState ?? issue.state} colours={config.stateColours} />
        {/* Beside the state chip, which on a retained run is the harness's copy and
            not the tracker's word: this is the chip that says so, and what the
            tracker says instead. */}
        {issue.stale !== undefined && <StaleChip stale={issue.stale} now={view.now} />}
        {/* The verdicts share the identity's own row. They are judgements about
            the goal as a whole, so they belong beside its name; and a second row
            of small type here is a second row the navigation sits below. */}
        <span className="cn-ghmeta">
          {issue.appraisal !== null && (
            <Tag tone={issue.appraisal.verdict === 'workable' ? 'green' : 'amber'} fill title={issue.appraisal.summary}>
              <Icon name="scale" size={12} />
              Appraisal · {issue.appraisal.verdict}
            </Tag>
          )}
          {/* Prefixed with *whose* verdict it is, because the two words this chip
            most often reads — "more work" — were also the name of a control an
            operator presses. One is a judgement the goal already carries and the
            other is a thing you do to it; a chip that could be read as either is
            the header's oldest confusion. `by` is read rather than assumed: the
            operator's own override says "Your verdict", and calling that one the
            harness's would be the header telling somebody their own decision was
            somebody else's. */}
          {issue.conclusion.verdict !== 'undeclared' && (
            <Tag title={issue.conclusion.note}>
              <Icon name="robot" size={12} />
              {issue.conclusion.by === 'operator' ? 'Your verdict' : 'Harness verdict'} ·{' '}
              {issue.conclusion.verdict.replace(/_/g, ' ')}
            </Tag>
          )}
          {/* The measurements, in one run at the end rather than as three more chips.
            `parts merged` is deliberately not among them: it is the track's first
            stage now, and stating it twice is how the header and the plan card
            came to disagree. */}
          <span className="cn-ghfacts">
            {issue.run !== undefined && <>started {relTime(issue.run.startedAt, view.now)} · </>}
            {/* Who those agents are, on the reading that counts them. It was a card
                of its own on the Plan pane, which put a list of agents — almost
                always none — between the plan and everything below it; the count
                is the fact worth a line, and the names behind it are worth a
                hover. Each agent keeps its own way in on the part it is working.
                → docs/spec/17-cockpit.md#who-is-on-the-goal */}
            <span className="cn-ghagents" title={agentsTitle(page, view.now)}>
              <Icon name="robot" size={12} />
              {page.agents.length} agent{page.agents.length === 1 ? '' : 's'}
            </span>
            {issue.spend !== null && <> · {fmtUsd(issue.spend.costUsd)}</>}
          </span>
        </span>
      </div>
      {/* Three captioned groups, drawn through the control kit
          (`web/src/components/controls.tsx`) rather than as class strings: what
          state the run is in, what steers the work, and what happens somewhere
          other than this goal. The caption is the part that does the explaining —
          it answers "how is this one different from that one" once, for a whole
          group, so no control has to grow a defensive name of its own.
          → docs/spec/17-cockpit.md#the-headers-controls */}
      <ControlBar>
        {/* Working, done and ended are three states of one thing, so they are one
            control rather than two buttons at opposite ends of the row. What
            "Mark done" and "End the run" each did was never legible from their
            names side by side; as segments of a run state they are obviously
            alternatives, and which one the goal is in is readable without pressing
            anything. Ending still wears the danger tone and still opens the modal. */}
        <ControlGroup caption="Run state" icon="clock">
          <ControlSegments label="Run state">
            <ControlSegment
              icon="play"
              pressed={!finished && !ended}
              onClick={() => {
                if (finished) void actions.setIssueConclusion(issue.number, null);
              }}
              title={
                finished
                  ? 'Withdraw "finished" — the goal goes back to whatever its agents and its plan say'
                  : 'The harness is free to schedule work for this goal'
              }
            >
              Working
            </ControlSegment>
            <ControlSegment
              icon="check"
              tone="on"
              pressed={finished}
              onClick={() => {
                if (!finished) void actions.setIssueConclusion(issue.number, 'done');
              }}
              title="Mark this goal finished, so the harness schedules nothing more for it. Agents already running are left alone."
            >
              Done
            </ControlSegment>
            {/* Keyed on the run existing, never on anything else the page is
                showing: for as long as the harness holds a run there is a way to
                end it, and once one has been ended the segment stays — drawn
                inert — because a control that vanishes says nothing about which
                state the goal ended up in. */}
            {retained && (
              <ControlSegment
                icon="stop"
                tone="danger"
                onClick={() => setEndingRun(true)}
                title="Abandon the harness's run at this goal — one way, terminal for the dispatcher, and it stops the agents, jobs and instructions still standing on it. It asks before it does."
              >
                Abandon…
              </ControlSegment>
            )}
            {ended && (
              <ControlSegment
                icon="stop"
                tone="danger"
                inert
                title="This run was abandoned. Nothing more is scheduled for it."
              >
                Abandoned
              </ControlSegment>
            )}
          </ControlSegments>
        </ControlGroup>
        {/* What steers the work the harness does on this goal. Every control here
            is reversible by pressing it again, which is what holds it apart from
            the group before. */}
        <ControlGroup caption="Steer the work" icon="pen" divider>
          {issue.state === 'open' && (
            <ControlButton
              icon="pen"
              tone={moreWork ? 'on' : 'primary'}
              count={standing}
              onClick={() => setInstructing(true)}
              title={
                standing === 0
                  ? 'Say what you want done next on this goal — your words go to the next agent, and the goal goes back in front of the harness: a "delivered" verdict is retracted, and a plan whose parts have all landed is sent back to a planner for you to approve again'
                  : `Add to the ${standing} instruction${standing === 1 ? '' : 's'} already standing on this goal`
              }
            >
              Give instructions
            </ControlButton>
          )}
          {/* One label, both ways: un-watching takes the tag off and writes nothing
              in its place, which is why the goal lands back in Unwatched rather than
              in a bucket of its own. */}
          <ControlButton
            icon="eye"
            tone={watched === 'watched' ? 'on' : undefined}
            onClick={() => void actions.setIssueWatched(issue.number, watched !== 'watched')}
            title={
              watched === 'watched'
                ? `Remove "${config.watchLabel}" so the harness leaves this goal alone`
                : `Tag this goal "${config.watchLabel}" so the harness picks it up`
            }
          >
            {watched === 'watched' ? 'Watching' : 'Watch'}
          </ControlButton>
          {/* "Work this one first." Beside the watch toggle because it is the next
              thing an operator says after "work this" — and deliberately worded as a
              queue statement rather than an importance one: it changes what the
              fleet reaches for while it is short of slots, and it changes nothing
              about whether the goal is allowed to move. A goal sitting on a cooldown
              or an unapproved plan is still sitting there, flagged. */}
          <ControlButton
            icon="bolt"
            tone={issue.priority !== null ? 'on' : undefined}
            onClick={() => void actions.setGoalPriority(issue.number, issue.priority === null)}
            title={
              issue.priority === null
                ? 'Work this goal first: everything under it — its plan, its parts, its pull requests — takes the next free slots ahead of the rest. It does not lift a cooldown, a part cap or an unapproved plan.'
                : `Marked a priority ${relTime(issue.priority.since, view.now)} — click to hand the queue back to its natural order`
            }
          >
            {issue.priority !== null ? 'Priority' : 'Prioritise'}
          </ControlButton>
          {/* Which profile this goal's work runs on (#342). Beside the watch toggle
              because it is the same kind of statement about the same object — "work
              this" and "work this at this depth" — and because an operator who has
              just read a hard ticket is already here. It dresses itself through
              the kit's `ControlSelect`, so this row says nothing about how a
              `<select>` is made to match the controls beside it. */}
          <ProfilePicker
            profiles={config.profiles}
            value={issue.modelPin.profile}
            defaultProfile={config.defaultProfile}
            inheritLabel="Not pinned"
            onPick={(profile) => void actions.setIssueProfile(issue.number, profile)}
          />
        </ControlGroup>
        {/* The three controls whose effect is not on this goal: two destinations,
            and the one that starts a second ticket about it. Grouping them is what
            answers "how is filing a bug different from giving instructions" —
            one steers the work here, one leaves. */}
        <ControlGroup caption="Leave this page" icon="ticket" divider>
          {/* The one control up here that changes nothing. It opens the operator's
              own Claude Code on this goal with `/lubbdubb ask <n>` already in the
              box, so a question about the work — what was done, which pull request,
              is it on hallway yet — is a click from the goal rather than a cockpit
              read joined to a repository read by hand. An anchor rather than a
              button, as the other deep links are: a deep link is a destination.
              Drawn through `DesktopLink`, which is what puts the command in the
              title as well as the href — the standing rule for every one of these,
              and the one this row would otherwise have to remember. */}
          <DesktopLink
            folder={config.desktopFolder}
            prompt={askPrompt(issue.number)}
            ready="ready for your question"
            explain="answered from what the harness actually recorded about this goal — the plan, the pull requests, what was escalated, what it cost, and where the work has reached."
          />
          {/* Which of the three keys resolves the ticket, and the inert `<span>`
              drawn when none of them does, are `TicketLink`'s business rather than
              this page's — both are judgements about how a ref resolves. */}
          <TicketLink className={CONTROL_CLASS} number={issue.number} url={issue.url}>
            <Icon name="ticket" />
            Open ticket ↗
          </TicketLink>
          {config.canFileTickets && (
            <ControlButton
              icon="bug"
              onClick={() => setRaisingBug(true)}
              title="Report that this does not work as you expect — an agent files it as a separate bug against this goal. It changes nothing about this goal's own verdict."
            >
              File a new bug
            </ControlButton>
          )}
        </ControlGroup>
      </ControlBar>
      {instructing && (
        <InstructionModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          onSubmit={(text) => actions.addInstruction(issue.number, text)}
          onClose={() => setInstructing(false)}
        />
      )}
      {endingRun && (
        <EndRunModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          outstanding={owed === null ? null : outstanding(owed)}
          agents={live}
          prAgents={livePr}
          instructions={standing}
          onSubmit={(note) => actions.dismissRun(issue.number, note)}
          onClose={() => setEndingRun(false)}
        />
      )}
      {raisingBug && (
        <RaiseBugModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          onSubmit={(summary, title) => actions.raiseBug(issue.number, summary, title)}
          onClose={() => setRaisingBug(false)}
        />
      )}
    </div>
  );
}

function outstanding(verdict: ValidationVerdict): string {
  return `Its checks are not clear — ${verdict.failed} failed, ${verdict.unrun} not run, ${verdict.deferred} left for later, of ${verdict.total}.`;
}

function StateChip({ state, colours }: { state: string; colours: Readonly<Record<string, string>> }): JSX.Element {
  const colour = stateColour(colours, state);
  return (
    <span className="tag" style={colour === null ? undefined : { color: colour, borderColor: colour }}>
      {state}
    </span>
  );
}

function LocalValidation({
  page,
  view,
  actions,
  fold,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  fold: Fold;
}): JSX.Element {
  const { issue } = page;
  const validation = issue.localValidation;
  const liveAgents = new Set(page.agents.filter((a) => LIVE_AGENT.has(a.agent.status)).map((a) => a.agent.id));

  return (
    <section className="cn-card" id={LOCAL_VALIDATION_ANCHOR}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Runs on your machine" />
        <i className="cn-n">
          {validation === null
            ? 'never run'
            : inFlight(validation)
              ? localValidationSaid(validation)
              : STATUS_WORD[validation.status]}
        </i>
        {/* What tells this apart from the check set above it: that one is the set, this is an
            agent's run at the machine in front of them — and what it does not do, which is answer
            any of them. → docs/spec/32-local-validation.md */}
        <span className="cn-more">
          one agent, in your own dev environment — it writes no reading on the checks above
        </span>
      </h3>
      {fold.open && (
        <div className="cn-vin">
          {/* The press is on the strip at the top of the pane, with every other runner's: a run is
              started in one place and read in another, and this panel is the reading.
              → docs/spec/17-cockpit.md#the-validate-pane */}
          <LocalValidationReport
            validation={validation}
            why={null}
            issueNumber={issue.number}
            liveAgents={liveAgents}
            refUrls={view.state.refUrls}
            now={view.now}
            actions={actions}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Every runner that could take a check on this goal, on one line each, above the list they answer.
 * **The one place a run is started.** The panels below read what a run did; a press offered in both
 * places is two controls for one act, and the question an operator arrives with — *is there a run
 * that would answer some of this, before I start answering by hand* — is asked before the list
 * rather than under it. → docs/spec/17-cockpit.md#the-validate-pane
 */
function RunStrip({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const { issue } = page;
  const run = view.state.localRun;
  const target = view.state.localRunTargets.find((t) => t.issueNumber === issue.number);
  const offer = localValidationOffer(issue, target, view.state.config.localRunConfigured);
  const [validating, setValidating] = useState<'swap' | 'refresh' | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const runTitle =
    run === null
      ? null
      : (view.state.world.issues.find((i) => `issue:${String(i.number)}` === run.originRef)?.title ?? null);
  /* The press asks first where a live run is on another goal or has fallen behind the branch: what
     it starts is the machine's *one* dev environment, so the question is which goal gets it.
     → docs/spec/23-local-runs.md */
  const onValidate = async (): Promise<void> => {
    const question = validateLocallyQuestion(issue.number, run);
    if (question !== null) {
      setValidating(question);
      return;
    }
    setRefusal(null);
    await actions.validateLocally(issue.number);
  };
  const flight = inFlight(issue.localValidation) ? issue.localValidation : null;

  return (
    <section className="cn-runstrip">
      <div className="cn-runstrip-row">
        <span className="cn-runstrip-who">your machine</span>
        {flight !== null ? (
          <span className="cn-sub">{localValidationSaid(flight)} — the panel below follows it</span>
        ) : offer.offered ? (
          <>
            <AsyncButton
              className={`${CONTROL_CLASS} primary`}
              onClick={onValidate}
              onRefused={setRefusal}
              pendingLabel={
                <>
                  <Icon name="flask" />
                  Starting…
                </>
              }
              title="Bring this goal's code up in your dev environment and send one agent to write a test plan, drive the running application through it, and report here. Asks first if something else is running."
            >
              <Icon name="flask" />
              {issue.localValidation === null ? 'Run it here' : 'Run it here again'}
            </AsyncButton>
            <span className="cn-sub">an exploratory run against work in flight — it answers no check</span>
          </>
        ) : (
          <span className="cn-sub">{offer.why}</span>
        )}
      </div>
      {/* One line per environment with a sheet, carrying the gate's own count so the strip never
          offers a run of rows a press would touch in no way at all. **Rows, not checks**: a sheet
          carries queries and measures beside its check rows, and a press re-reads the answered ones
          too — so the line says what a press does and, separately, how many checks are still
          unanswered there. → docs/spec/36-remote-validation.md#a-row-no-press-can-read */}
      {page.remoteSheets.map((sheet) => {
        const rows = pressableRows(sheet);
        const made = pressBreakdown(sheet);
        const live = sheet.run !== null && (sheet.run.status === 'pending' || sheet.run.status === 'dispatched');
        return (
          <div className="cn-runstrip-row" key={sheet.environment}>
            <span className="cn-runstrip-who">{sheet.environment}</span>
            {live ? (
              <span className="cn-sub">a run is going — the panel below follows it</span>
            ) : (
              <>
                <AsyncButton
                  className={`${CONTROL_CLASS} primary`}
                  onClick={() => actions.pressRemoteSheet(issue.number, sheet.environment)}
                  onRefused={setRefusal}
                  title={`Re-read every selected row on this sheet against the commit ${sheet.environment} stands at right now — the ones already answered included`}
                >
                  {rows === 1 ? 'Run 1 row' : `Run ${String(rows)} rows`}
                </AsyncButton>
                {/* What the number is made of, because it is bigger than the ticks below it: the
                    sheet carries queries and measures that have no check to tick, and a press
                    re-reads the checks already answered. */}
                <span className="cn-sub">
                  {made.checks === 1 ? '1 check ticked below' : `${String(made.checks)} checks ticked below`}
                  {made.own > 0 &&
                    ` · ${String(made.own)} ${made.own === 1 ? 'query or measure' : 'queries and measures'} of its own`}
                </span>
                {/* What staleness means, where it can be acted on. A tenant accumulates the residue
                    of every run that used it, so past the window the environment declares a red row
                    may be that residue rather than the code — which is why the answer is to reseed
                    first and press after. → docs/spec/36-remote-validation.md#tenants */}
                {sheet.tenant.stale && (
                  <span className="cn-sub cn-runstrip-stale">
                    Its test data is older than {sheet.environment} allows — reseed it below first, or a failure here
                    may be leftovers from earlier runs rather than this goal&rsquo;s work.
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
      {refusal !== null && (
        <p className="launch-error" role="alert">
          {refusal}
        </p>
      )}
      {validating !== null && run !== null && (
        <ValidateLocallyModal
          mode={validating}
          issueNumber={issue.number}
          issueTitle={issue.title}
          targetRef={target?.target.ref ?? null}
          run={run}
          runTitle={runTitle}
          onSubmit={(opts) => actions.validateLocally(issue.number, opts)}
          onClose={() => setValidating(null)}
        />
      )}
    </section>
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

function Signals({
  page,
  actions,
  refUrls,
  fold,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  refUrls: Record<string, string>;
  fold: Fold;
}): JSX.Element | null {
  const { issue, signals, plan } = page;
  if (signals.length === 0 && plan === null) return null;
  const pending = signals.filter((c) => !c.live).length;
  return (
    <section className="cn-card" id="cn-signals">
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Signals" />
        <i className="cn-n">
          {signals.length === 1 ? '1 reading' : `${signals.length} readings`}
          {pending > 0 && ` · ${pending} awaiting you`}
        </i>
        <span className="cn-more">
          asked of a live environment after this ships
          {plan !== null && (
            <button type="button" className="cn-linkish" onClick={() => actions.viewPlan(plan.id)}>
              see the plan ↗
            </button>
          )}
        </span>
      </h3>
      {fold.open && (
        <SignalsSection
          signals={signals}
          refUrls={refUrls}
          onSave={(check) => actions.saveWatchCheck(issue.number, check)}
          onDelete={(checkId) => actions.deleteWatchCheck(issue.number, checkId)}
          onRule={(checkId, accept) => actions.ruleWatchProposal(issue.number, checkId, accept)}
        />
      )}
    </section>
  );
}

/**
 * Absent entirely where the goal has no sheet — and, on the server, where no environment declares a
 * `validate` block at all. Not an empty card and not a row of question marks: a deployment that has
 * not turned this on must not read as a deployment where it is broken.
 */
function RemoteValidation({
  page,
  view,
  actions,
  fold,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  fold: Fold;
}): JSX.Element | null {
  const sheets = page.remoteSheets;
  if (sheets.length === 0) return null;
  const showing = view.sheetEnvironment;
  /* The pane above picks the environment, so a pick with no sheet draws no sheet — falling
     back to the first would put another environment's rows under this one's heading. */
  const open = showing === null ? sheets[0] : sheets.find((s) => s.environment === showing);
  if (open === undefined) return null;
  const waiting = open.rows.filter((r) => r.awaitingApproval).length;
  /* The same count the gate's own button carries, said on the header so an operator scanning the
     pane knows a press is waiting without opening it. → docs/spec/36-remote-validation.md */
  const pressable = pressableRows(open);
  return (
    <section className="cn-card" id="cn-remote-validation">
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label={`Runs on ${open.environment}`} />
        <i className="cn-n">
          {pressable === 1 ? '1 row a press would read' : `${pressable} rows a press would read`}
          {waiting > 0 && ` · ${waiting} waiting on an approval`}
        </i>
        <span className="cn-more">where this goal&rsquo;s work has arrived</span>
      </h3>
      {fold.open && (
        <RemoteValidationSection
          sheets={sheets}
          showing={showing}
          switcher={false}
          foldRows
          press={false}
          onShow={(environment) => actions.openRemoteSheet(environment)}
          controls={{
            onRule: (environment, rowId, accept) =>
              actions.ruleRemoteQuery(page.issue.number, environment, rowId, accept),
            onSelect: (environment, rowId, selected) =>
              actions.selectRemoteRow(page.issue.number, environment, rowId, selected),
            onPress: (environment) => actions.pressRemoteSheet(page.issue.number, environment),
            onCancel: (environment) => actions.cancelRemoteRun(page.issue.number, environment),
            onReseed: (environment) => actions.reseedRemoteTenant(page.issue.number, environment),
            onOpenAgent: (agentId) => actions.select(agentId),
          }}
        />
      )}
    </section>
  );
}

type PartPr = { open: true; pr: OpenPullRequest } | { open: false; pr: PullRequest };

const GROUP_ORDER: PartGroup[] = ['merged', 'now', 'held', 'waiting'];

/**
 * The groups the board actually draws, in order. One definition, because the pane
 * reads it too: the panel's pointer is aimed at the card the operator chose, and a
 * second spelling of which columns exist is how that pointer comes to aim at the
 * wrong one.
 */
function liveGroups(page: GoalPageView): PartGroup[] {
  return GROUP_ORDER.filter((group) => page.parts.some((p) => p.group === group));
}
const GROUP_LABEL: Record<PartGroup, string> = {
  merged: 'Merged',
  now: 'Now',
  held: 'Held',
  waiting: 'Not started',
};

/* The pull requests this goal owns that no part of the plan carries. A goal
   delivered whole has no parts at all, a pull request can be filed before the
   plan exists, and the provider links some itself — so `ownsPr`'s answer is
   wider than the plan's, and the difference is work the board would otherwise
   not draw at all. → docs/spec/17-cockpit.md#a-part-and-its-pull-request */
function loosePullRequests(page: GoalPageView): PartPr[] {
  const carried = new Set(
    [...page.parts.map((p) => p.part), ...page.retiredParts]
      .map((part) => part.prNumber)
      .filter((n): n is number => n !== null),
  );
  return [
    ...page.openPullRequests.filter((pr) => !carried.has(pr.number)).map((pr): PartPr => ({ open: true, pr })),
    ...page.closedPullRequests.filter((pr) => !carried.has(pr.number)).map((pr): PartPr => ({ open: false, pr })),
  ];
}

/* The row for the pull request a part carries, for a surface that holds the
   number and not the pull request. One builder, so the panel under the board and
   the part on it cannot disagree about the same pull request.
   → docs/spec/17-cockpit.md#a-part-and-its-pull-request */
function partPrRow(
  page: GoalPageView,
  prNumber: number,
  view: CockpitView,
  actions: CockpitActions,
): PanelRowModel | undefined {
  const open = page.openPullRequests.find((pr) => pr.number === prNumber);
  if (open !== undefined) return prRow(open, view, actions, { goal: false });
  const closed = page.closedPullRequests.find((pr) => pr.number === prNumber);
  return closed === undefined ? undefined : closedPrRow(closed, view, actions);
}

function PlanWaves({
  page,
  view,
  actions,
  fold,
  chosen,
  chosenRef,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  fold: Fold;
  /** The part whose description is in front, so the board can say which one that is. */
  chosen: string | null;
  /** Attached to the chosen card, so the panel below can point back at it. */
  chosenRef: MutableRefObject<HTMLDivElement | null>;
}): JSX.Element {
  const groups = liveGroups(page).map((group) => ({
    group,
    parts: page.parts.filter((p) => p.group === group),
  }));
  const retired = page.retiredParts;
  const plan = page.plan;
  // The gate lifts here the moment the reveal returns, rather than waiting on the
  // payload the refresh behind it brings. `revealed` is the server's fact and this
  // is only the page catching up to it, so the flag is never read the other way:
  // once the payload says revealed, this is dead weight and the gate is gone for
  // good. → docs/proposals/prediction-record-and-criteria-integrity.md
  const [lifted, setLifted] = useState(false);
  const gated = plan !== null && !plan.revealed && !lifted;
  const prs = new Map<number, PartPr>();
  for (const pr of page.closedPullRequests) prs.set(pr.number, { open: false, pr });
  for (const pr of page.openPullRequests) prs.set(pr.number, { open: true, pr });
  /* Each part draws its pull request in a card of its own, so each would size its
     own columns and the board's marks would sit at a different x on every part.
     The rail is every part's row, handed to all of them: one set of columns
     across the whole board, which is what `PanelRows`' own rail is for.
     → docs/spec/17-cockpit.md#a-part-and-its-pull-request */
  const loose = loosePullRequests(page);
  const prRail = [
    ...[...page.parts.map((p) => p.part), ...retired]
      .map((part) => (part.prNumber === null ? null : (prs.get(part.prNumber) ?? null)))
      .filter((pr): pr is PartPr => pr !== null),
    ...loose,
  ].map((pr) => (pr.open ? prRow(pr.pr, view, actions, { goal: false }) : closedPrRow(pr.pr, view, actions)));
  const underWay = planUnderWay(page);
  const verdict = planVerdictAsk(page, view.state.escalations);

  return (
    <section className="cn-card" id={GOAL_ANCHOR.plan}>
      <h3>
        The plan
        {page.parts.length > 0 && <i className="cn-n">{page.parts.length} parts</i>}
        {page.parts.length === 0 && retired.length > 0 && <i className="cn-n">{retired.length} retired</i>}
        <span className="cn-more">
          left to right is dispatch order
          {/* The way to the whole plan, on the card that draws its summary. The
              waves are titles and dependencies; the diagnosis, the map, each part's
              acceptance and what was decided are the sheet's, and it was reachable
              from here only through the validation card's aside about amending the
              checks — a door nobody looking for the plan would think to try. */}
          {plan !== null && !gated && (
            <button
              type="button"
              className="cn-linkish"
              title="The plan sheet — the write-up, the shape, each part in full, and the decision that was made on it"
              onClick={() => actions.viewPlan(plan.id)}
            >
              open the full plan ↗
            </button>
          )}
        </span>
      </h3>
      {gated && (
        <PlanRevealGate
          issueNumber={page.issue.number}
          onRevealed={async () => {
            try {
              await actions.refresh();
            } finally {
              setLifted(true);
            }
          }}
        />
      )}
      {/* Above the parts, and only while the plan is still at its gate: marking the
          prediction against what the plan says is what this pane is *for* at that
          moment, and the parts below it are not going anywhere until it is approved.
          Once the plan is approved the prediction leaves this card altogether —
          `WorkPaneBody` draws it at the foot of the pane.
          → docs/spec/17-cockpit.md#where-the-prediction-is-drawn */}
      {!gated && !underWay && (
        <PredictionReview
          issueNumber={page.issue.number}
          revealed={plan !== null && (plan.revealed || lifted)}
          outcomeAsked={page.needs.some((need) => need.kind === 'outcome')}
          plan={plan}
          parts={page.parts.map((p) => p.part)}
          open={fold.open}
          settled={fold.settled}
          onToggle={fold.onToggle}
          now={view.now}
        />
      )}
      {/* Under the prediction, and only while the plan is read and undecided: the
          sitting the gate opened ends in a verdict, and an operator who has just
          marked their prediction against the plan had to go back up the page to
          give one. The ask itself is drawn — not a second spelling of it — so the
          caveats, the check set and every refusal the routes can give are the
          rail's own.
          → docs/spec/17-cockpit.md#the-verdict-where-the-plan-was-read */}
      {!gated && verdict !== null && (
        <div className="cn-plan-verdict">
          <NeedsBand row={verdict} view={view} actions={actions} />
        </div>
      )}
      <div className="cn-waves" hidden={gated}>
        {groups.length === 0 && (
          <p className="cn-empty">
            {page.plan === null
              ? 'No plan has been drawn for this goal.'
              : retired.length > 0
                ? 'Every part of this plan was retired. What it proposed is below.'
                : 'The plan has no live parts.'}
          </p>
        )}
        {groups.map(({ group, parts }) => (
          <div className="cn-col" key={group}>
            <div className="cn-coln">{GROUP_LABEL[group]}</div>
            {parts.map((p) => (
              <Part
                key={p.part.id}
                part={p.part}
                group={p.group}
                agentId={p.agentId}
                agentLive={p.agentLive}
                pr={p.part.prNumber === null ? null : (prs.get(p.part.prNumber) ?? null)}
                chosen={chosen === p.part.slug}
                chosenRef={chosenRef}
                receded={chosen !== null && chosen !== p.part.slug}
                prRail={prRail}
                view={view}
                actions={actions}
              />
            ))}
          </div>
        ))}
        {/* A column of its own, last: these are the goal's work as much as any part
            is, and left off the board they were a card further down the pane
            repeating the same row under a different heading. Drawn as parts with
            nothing known about them rather than as a second list — what the plan
            does not account for is still what is happening to this goal.
            → docs/spec/17-cockpit.md#a-part-and-its-pull-request */}
        {loose.length > 0 && (
          <div className="cn-col">
            <div className="cn-coln">Not in the plan</div>
            {loose.map((pr) => (
              <div className="cn-part cn-loose" key={pr.pr.number}>
                <PartPrRow pr={pr} rail={prRail} view={view} actions={actions} />
                <span className="cn-dep">no part of the plan names this</span>
              </div>
            ))}
          </div>
        )}
        {retired.length > 0 && (
          <div className="cn-col">
            <div className="cn-coln">Retired</div>
            {retired.map((part) => (
              <Part
                key={part.id}
                part={part}
                group="retired"
                agentId={null}
                agentLive={false}
                pr={part.prNumber === null ? null : (prs.get(part.prNumber) ?? null)}
                chosen={false}
                chosenRef={chosenRef}
                receded={chosen !== null}
                prRail={prRail}
                view={view}
                actions={actions}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Part({
  part,
  group,
  agentId,
  agentLive,
  pr,
  chosen,
  chosenRef,
  receded,
  prRail,
  view,
  actions,
}: {
  part: PlanPart;
  group: PartGroup | 'retired';
  agentId: string | null;
  agentLive: boolean;
  pr: PartPr | null;
  chosen: boolean;
  chosenRef: MutableRefObject<HTMLDivElement | null>;
  receded: boolean;
  prRail: readonly PanelRowModel[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const held = usePartDescriptions();
  /* The panel follows this pick, so a part it would never draw is not one to pick:
     no pull request to read, a retired part the panel's list does not hold, or a
     deployment where the read did not answer.
     → docs/spec/17-cockpit.md#one-panel-for-the-part-in-front */
  const pickable = held !== null && part.prNumber !== null && group !== 'retired';
  const pick = (): void => actions.openGoalPart(part.slug);
  return (
    <div
      ref={chosen ? chosenRef : undefined}
      className={`cn-part cn-${group} ${chosen ? 'is-chosen' : ''} ${receded ? 'is-receded' : ''} ${
        pickable ? 'is-pickable' : ''
      }`}
      /* The whole card is the way in, and the title carries the same press for a
         keyboard — a control inside it (the PR reference, the agent) is its own
         press and must not also pick the part. */
      onClick={
        pickable
          ? (event) => {
              if ((event.target as HTMLElement).closest('a, button') === null) pick();
            }
          : undefined
      }
    >
      {pickable ? (
        <button
          type="button"
          className="cn-partpick"
          title="Show what this part is — its description, and the way to write it"
          onClick={pick}
        >
          <b>
            {part.seq} · {part.title}
          </b>
        </button>
      ) : (
        <b>
          {part.seq} · {part.title}
        </b>
      )}
      {group === 'held' && part.blockedReason !== null && <p className="cn-why">{part.blockedReason}</p>}
      {part.scope !== '' && <p>{part.scope}</p>}
      {pr !== null && <PartPrRow pr={pr} rail={prRail} view={view} actions={actions} />}
      {/* The description's standing, said on the part it belongs to. The card is the
          control that brings it to the front — the board is where the parts are told
          apart, so it is where the one in front is chosen.
          → docs/spec/17-cockpit.md#one-panel-for-the-part-in-front */}
      <PartDescriptionTag slug={part.slug} prNumber={part.prNumber} />
      <span className="cn-dep">
        {part.dependsOn.length > 0 ? `depends on ${part.dependsOn.join(', ')}` : 'depends on nothing'}
        {/* A live agent gets the chip the whole cockpit says this with; a
            finished one keeps the plain way in, because what it offers is the
            record of what happened here and not a claim that anything still is. */}
        {agentId !== null && (
          <>
            {' · '}
            {agentLive ? (
              <AgentOnIt agentId={agentId} actions={actions} />
            ) : (
              <button
                type="button"
                className="cn-openagent"
                title="Open the agent that worked this part — its transcript, what it cost, and its controls"
                onClick={() => actions.select(agentId)}
              >
                open the agent ↗
              </button>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/* The pull request carrying this part, drawn as the one pull-request row the
   cockpit has — the same `prRow` the overview's rack is built from, so a part
   and the rack say the same thing about the same pull request in the same
   shape. A strip of bare marks under the title said all of it and named none of
   it: the row is what makes "what is happening to this part" readable without
   first learning six glyphs.
   → docs/spec/17-cockpit.md#a-part-and-its-pull-request */
function PartPrRow({
  pr,
  rail,
  view,
  actions,
}: {
  pr: PartPr;
  rail: readonly PanelRowModel[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="cn-partpr cn-read-marks">
      <PanelRows
        layout="stacked"
        rail={rail}
        /* The goal reference is the page this row is already on, and the rack's
           own `goal: false` reason applies here twice over. */
        rows={[pr.open ? prRow(pr.pr, view, actions, { goal: false }) : closedPrRow(pr.pr, view, actions)]}
      />
    </div>
  );
}

function Instructions({ issue, actions }: { issue: Issue; actions: CockpitActions }): JSX.Element | null {
  if (issue.instructions.length === 0) return null;
  return (
    <section className="cn-card">
      <h3>
        What you’ve asked for <span className="cn-more">standing until an agent concludes this goal</span>
      </h3>
      <div className="cn-rows">
        {issue.instructions.map((instruction) => (
          <div className="cn-row" key={instruction.id}>
            <span className="cn-grow">
              <b className="cn-name">{instruction.text}</b>
              <span className="cn-sub">{instruction.createdAt}</span>
            </span>
            <AsyncButton
              className={CONTROL_CLASS}
              onClick={() => actions.withdrawInstruction(issue.number, instruction.id)}
              title="Take this back — it stops being sent to the next agent"
            >
              Withdraw
            </AsyncButton>
          </div>
        ))}
      </div>
    </section>
  );
}

function Ticket({ issue, refUrls }: { issue: Issue; refUrls: Record<string, string> }): JSX.Element {
  return (
    <section className="cn-card" id="cn-ticket">
      <h3>
        The ticket
        <span className="cn-more">as it stood at pickup</span>
      </h3>
      <div className="cn-tick">
        {issue.body.trim() === '' ? <p className="cn-empty">The ticket has no description.</p> : null}
        {renderRichText(issue.body, refUrls)}
      </div>
    </section>
  );
}
function Sequence({ page, fold }: { page: GoalPageView; fold: Fold }): JSX.Element | null {
  const sequence = page.sequence;
  const parent = page.issue.parent?.number;
  if (sequence === null || parent === undefined) return null;
  const me = page.issue.number;
  const waves = wavesOf([...new Set([me, ...sequence.edges.flatMap((e) => [e.issue, e.dependsOn])])], sequence.edges);
  const mine = waveOf(me, sequence.edges);
  const behind = waitsOn(me, sequence.edges);
  const ahead = waitingOnThis(me, sequence.edges);
  return (
    <section className="cn-card">
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Sequence" />
        <i className="cn-n">
          wave {mine + 1} of {waves.length}
          {ahead.length === 0 ? '' : ` · ${ahead.length} waiting on this`}
        </i>
        <span className="cn-refs">
          <Ref to={`issue:${parent}`} />
        </span>
      </h3>
      {fold.open && (
        <div className="cn-rows">
          {/* Either side of this goal, and nothing else: the whole order belongs
              on the Feature, and repeating it here would be a second list of the
              same stories with no way to act on it. */}
          <SequenceSide label="This waits on" issues={behind} empty="nothing — it is in the first wave" />
          <SequenceSide label="Waiting on this" issues={ahead} empty="nothing" />
        </div>
      )}
    </section>
  );
}

function SequenceSide({
  label,
  issues,
  empty,
}: {
  label: string;
  issues: readonly number[];
  empty: string;
}): JSX.Element {
  return (
    <div className="cn-row">
      <span className="cn-grow">
        <b className="cn-name">{label}</b>
        {issues.length === 0 ? (
          <span className="cn-sub">{empty}</span>
        ) : (
          <span className="cn-refs">
            {issues.map((n) => (
              <Ref key={n} to={`issue:${n}`} />
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

function Environments({
  page,
  actions,
  now,
  fold,
  only = null,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  now: number;
  fold: Fold;
  /** Draw only this environment's row. The pane above picks it; null draws them all. */
  only?: string | null;
}): JSX.Element | null {
  const [releasing, setReleasing] = useState(false);
  if (page.environments.length === 0) return null;
  const number = page.issue.number;
  const bands = reachBands(page);
  const grouped = new Set(page.groups.flatMap((g) => g.environments));
  /* Counted in places rather than in commands: three regions of production are one place,
     and a card reading "1/3 reached" for a group that has arrived nowhere would be counting
     the configuration instead of the deployment. */
  const reached = bands.filter((b) => b.status === 'reached').length;
  const rows = only == null ? page.environments : page.environments.filter((e) => e.environment === only);
  /* A band is drawn only where one of its environments is: the pane that picks a single
     environment is asking about that one, and a group heading over nothing is a place the
     card claims to be saying something about. */
  const shown = new Set(rows.map((e) => e.environment));
  const groups = page.groups.filter((g) => g.environments.some((name) => shown.has(name)));
  return (
    <section className="cn-card" id={GOAL_ANCHOR.environments}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Environments" />
        {/* The count folded away is the whole reading: a card shut on "0/3
            reached" says what the rows would have, and one shut on "2/3" is the
            reason to open it. */}
        <i className="cn-n">
          {reached}/{bands.length} reached
        </i>
      </h3>
      {fold.open && (
        <div className="cn-rows">
          {groups.map((group) => (
            <div className="cn-env cn-env-group" key={`group:${group.group}`}>
              <div className="cn-row">
                <span className="cn-grow">
                  <b className="cn-name">{group.group}</b>
                  <span className="cn-sub">
                    {REACH_SAID[group.status]}
                    {group.opens.length > 0 && ` · opens ${group.opens.map((g) => GATE_SAID[g]).join(' and ')}`}
                    {` · ${group.environments.join(', ')}`}
                  </span>
                </span>
                {group.status !== 'reached' && (
                  <i className="cn-n">
                    {group.landed}/{group.total}
                  </i>
                )}
                <Tag tone={REACH_TONE[group.status]} fill={REACH_TONE[group.status] !== undefined}>
                  {group.status}
                </Tag>
              </div>
            </div>
          ))}
          {rows.map((env) => (
            <div className={`cn-env${grouped.has(env.environment) ? ' cn-env-member' : ''}`} key={env.environment}>
              <div className="cn-row">
                <span className="cn-grow">
                  <b className="cn-name">{env.environment}</b>
                  <span className="cn-sub">
                    {REACH_SAID[env.status]}
                    {/* What arriving here does, on the row that would do it. An
                    operator reading a held goal asks "waiting for what" exactly
                    once, and the answer is configuration they wrote weeks ago. */}
                    {env.opens.length > 0 && ` · opens ${env.opens.map((g) => GATE_SAID[g]).join(' and ')}`}
                    {/* Folded on the server, off the same rows the sheet card above draws. Worked
                        out here instead it would be a second opinion beside the reading it
                        describes. → 36-remote-validation.md#the-cockpit */}
                    {env.sheet !== null && ` · ${env.sheet}`}
                  </span>
                </span>
                {(env.status !== 'reached' || env.unplaced > 0) && <i className="cn-n">{reachCount(env)}</i>}
                <Tag tone={REACH_TONE[env.status]} fill={REACH_TONE[env.status] !== undefined}>
                  {env.status}
                </Tag>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* The hold, said out loud. Drawn whether or not the card is folded, for the
          reason it is drawn at all: nothing is filed while a gate holds, so a
          delivered goal with an empty bench is indistinguishable from a finished
          one, and a fold is not a reason to stop saying so. Nothing is filed while a gate holds, so without
          The control beside it is the escape for work that is never going to
          reach an environment at all. */}
      {page.gateHold !== null && (
        <div className="cn-criteria">
          <p>{page.gateHold}</p>
          <Button ghost onClick={() => setReleasing(true)}>
            not waiting on an environment
          </Button>
        </div>
      )}
      {page.gateRelease !== null && (
        <div className="cn-criteria">
          <p>
            Not waiting on an environment — “{page.gateRelease.note}”
            <span className="cn-sub"> · {relTime(page.gateRelease.releasedAt, now)}</span>
          </p>
          <Button ghost onClick={() => void actions.releaseEnvironmentGate(number, false)}>
            wait for one after all
          </Button>
        </div>
      )}
      {releasing && page.gateHold !== null && (
        <GateReleaseModal
          issueNumber={number}
          issueTitle={page.issue.title}
          hold={page.gateHold}
          onSubmit={(note) => actions.releaseEnvironmentGate(number, true, note)}
          onClose={() => setReleasing(false)}
        />
      )}
    </section>
  );
}

/**
 * The window one environment's arrival opened, as a card of its own on the pane that *is*
 * that obligation. It was drawn inside the environment's own row while the environments and
 * the watch shared a pane, so that the two surfaces could not disagree about which
 * environment a reading came from; the heading carries that now — a watch reading is never
 * drawn without the environment it was read in.
 * → docs/spec/29-post-deploy-watch.md#in-the-cockpit
 */
function WatchWindow({
  watch,
  environment,
  issueNumber,
  now,
  actions,
}: {
  watch: GoalWatchView | undefined;
  /** The environment this pane is showing — named even where its window has not opened. */
  environment: string | null;
  issueNumber: number;
  now: number;
  actions: CockpitActions;
}): JSX.Element | null {
  if (environment === null) return null;
  return (
    <section className="cn-card" id="cn-watch">
      <h3>
        Watch · {environment}
        <span className="cn-more">
          asked of {environment} for as long as the window this goal&rsquo;s arrival opened
        </span>
      </h3>
      {watch === undefined || watch.checks.length === 0 ? (
        /* Not an empty list of readings: a window that never opened and one that opened and
           read nothing are different answers, and only the second is about the work. */
        <p className="cn-sub">No window has opened here — nothing of this goal has arrived in {environment} yet.</p>
      ) : (
        <Watch watch={watch} issueNumber={issueNumber} now={now} actions={actions} />
      )}
    </section>
  );
}

function Watch({
  watch,
  issueNumber,
  now,
  actions,
}: {
  watch: GoalWatchView;
  issueNumber: number;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="cn-watch">
      <span className="cn-watch-head">
        {watch.settledAt === null
          ? `watching until ${relTime(watch.settlesAt, now)}`
          : `settled ${relTime(watch.settledAt, now)}`}
        {/* Said whether it is open or settled: an extension is why a window's end
            is not the one the arrival sized, and without it the card states a
            length nothing in the configuration would produce. */}
        {watch.extendedAt !== null && ` · extended ${relTime(watch.extendedAt, now)}`}
        {/* The honest answer for a window that closed before the weekly job ran.
            It re-opens this window rather than opening a second one, so the
            readings below stay where they are — and it is a click because putting
            a settled verdict back in play is not a thing the harness decides. */}
        <AsyncButton
          className="cn-watch-more"
          onClick={() => actions.extendWatch(issueNumber, watch.environment)}
          title={
            watch.settledAt === null
              ? 'Give this window more time — it runs on from now for this environment’s own window length'
              : 'Re-open this settled window and watch on from now. The readings it already took stay where they are.'
          }
        >
          extend
        </AsyncButton>
      </span>
      {watch.checks.map((check) => (
        <div className={`cn-watch-row ${check.reading?.verdict ?? 'unread'}`} key={check.checkId}>
          <span className="cn-grow">
            <b className="cn-name">{check.title}</b>
            {/* An `unknown` says why, in words, and never in the vocabulary of a
                clean one: a failed observation, a timeout and a presence query
                answering zero are the watch failing to *read* the environment, and
                only a reading that came back can say anything about the work. */}
            <span className="cn-sub">{watchSaid(check)}</span>
          </span>
          <Tag
            tone={WATCH_TONE[check.reading?.verdict ?? 'unread']}
            fill={WATCH_TONE[check.reading?.verdict ?? 'unread'] !== undefined}
          >
            {check.reading?.verdict ?? 'not read'}
          </Tag>
        </div>
      ))}
    </div>
  );
}

function watchSaid(check: GoalWatchCheckView): string {
  const reading = check.reading;
  if (reading === null) return 'Not yet put to this environment. Nothing has been read.';
  if (reading.detail !== null) return reading.detail;
  if (check.kind === 'measure') return measureSaid(check, reading.value);
  return check.tolerate === 0
    ? 'No matching rows at all, which is what it declared.'
    : `${String(reading.rows ?? 0)} matching rows, within the ${String(check.tolerate)} it declared.`;
}

function measureSaid(check: GoalWatchCheckView, value: number | null): string {
  const unit = check.unit === null ? '' : ` ${check.unit}`;
  const expected: string[] = [];
  if (check.expectUnder !== null) expected.push(`under ${String(check.expectUnder)}${unit}`);
  if (check.expectOver !== null) expected.push(`over ${String(check.expectOver)}${unit}`);
  if (check.expectBaseline) expected.push('no worse than its baseline');
  const before = check.baselineValue === null ? 'before: never taken' : `before ${String(check.baselineValue)}${unit}`;
  const now = value === null ? 'now: nothing read' : `now ${String(value)}${unit}`;
  return `Expected ${expected.join(' and ')} · ${before} · ${now}.`;
}

const WATCH_TONE: Record<WatchCheckVerdict | 'unread', TagTone | undefined> = {
  clean: 'green',
  regressed: 'red',
  unknown: 'amber',
  unread: undefined,
};

const GATE_SAID: Record<EnvironmentGate, string> = {
  validate: 'the checks',
  close_out: 'the close-out',
};

const REACH_TONE: Record<GoalReachStatus, TagTone | undefined> = {
  reached: 'green',
  partial: 'red',
  unknown: 'amber',
  absent: undefined,
};

const REACH_SAID: Record<GoalReachStatus, string> = {
  reached: 'all of this goal’s work is here',
  partial: 'some of this goal’s work is here',
  absent: 'none of this goal’s work is here yet',
  unknown: 'nothing here could be confirmed — check the probe, not the deploy',
};

const COURT_TONE: Record<string, TagTone> = {
  you: 'red',
  harness: 'blue',
  stalled: 'amber',
  done: 'green',
};

function courtTone(pr: OpenPullRequest): TagTone | undefined {
  return COURT_TONE[pr.attention.status];
}

/**
 * The tracker has stopped returning this goal, and this is the one place that
 * says so (`wire.Issue.stale`). Drawn on a retained run wherever the goal is
 * listed or opened, and never on a live issue — the field is absent there.
 *
 * Two readings, and it draws whichever the deployment can give. With a ticket
 * mirror, the tracker's own word — `Resolved`, `Closed`, or open with the watch
 * tag gone — because that is the operator's actual question: not "is this stale"
 * but "what happened to it". Without one, only that the item left and when the
 * harness last saw it. The title spells out what the marking covers and what it
 * does not: the tracker's fields are the harness's copy, everything else on the
 * goal is the harness's own record and current.
 *
 * @public drawn on the overview's goal rows as well as the page header
 */
export function StaleChip({ stale, now }: { stale: NonNullable<Issue['stale']>; now: number }): JSX.Element {
  const seen = relTime(stale.lastSeenAt, now);
  const kept = "Its plan, pull requests, agents, spend and notes are the harness's own record and are current.";
  if (stale.tracker === null)
    return (
      <Tag
        dashed
        title={`The tracker no longer returns this item — closed, resolved, or its watch tag removed. The title, description, labels and state shown are the harness's copy from ${seen}. ${kept}`}
      >
        left tracker · seen {seen}
      </Tag>
    );
  const word = stale.tracker.workItemState ?? stale.tracker.state;
  return (
    <Tag
      dashed
      title={`The tracker stopped returning this item and now says ${word} (changed ${relTime(stale.tracker.changedAt, now)}). The title, description and labels shown are the harness's copy from ${seen}. ${kept}`}
    >
      tracker: {word} · seen {seen}
    </Tag>
  );
}

export function CourtChip({ pr, now }: { pr: OpenPullRequest; now: number }): JSX.Element {
  const since = pr.attention.reviewWaitingSince;
  const waited = since !== undefined ? waitedFor(since, now) : null;
  return (
    <Tag
      tone={courtTone(pr)}
      fill={courtTone(pr) !== undefined}
      title={
        waited
          ? [...pr.attention.reasons, `waiting since ${new Date(since!).toLocaleString()}`].join(' · ')
          : pr.attention.reasons.join(' · ')
      }
    >
      {pr.attention.status}
      {waited && <span className="cn-chip-age"> · {waited}</span>}
    </Tag>
  );
}

/* The tooltip behind the header's agent count: one line per agent, in the words
   the drawer uses for the same facts. → docs/spec/17-cockpit.md#who-is-on-the-goal */
function agentsTitle(page: GoalPageView, now: number): string {
  if (page.agents.length === 0) return 'No agent is on this goal.';
  return page.agents
    .map(({ agent, onPr, title }) => {
      const cost = agent.costUsd === null ? '' : ` · ${fmtUsd(agent.costUsd)}`;
      const pr = onPr === null ? '' : ` · PR #${onPr}`;
      return `${title ?? agent.id} — ${agent.status} · ${relTime(agent.startedAt, now)}${cost}${pr}`;
    })
    .join('\n');
}

function Spend({ issue }: { issue: Issue }): JSX.Element | null {
  const spend = issue.spend;
  if (spend === null) return null;
  return (
    <section className="cn-card">
      <h3>Spend</h3>
      <div className="cn-rows">
        <div className="cn-kv">
          <span>Total</span>
          <b>{fmtUsd(spend.costUsd)}</b>
        </div>
        <div className="cn-kv">
          <span>Agents</span>
          <b>{spend.agents}</b>
        </div>
        {/* Named separately because the row above says "Agents" and a local run is
            not one. The total already holds its money. */}
        {spend.localRuns > 0 && (
          <div className="cn-kv">
            <span>Local runs</span>
            <b>{spend.localRuns}</b>
          </div>
        )}
        <div className="cn-kv">
          <span>Tokens</span>
          <b>
            {spend.inputTokens}→{spend.outputTokens}
          </b>
        </div>
      </div>
    </section>
  );
}

function Tail({ issue, actions, fold }: { issue: Issue; actions: CockpitActions; fold: Fold }): JSX.Element {
  const ref = `issue:${issue.number}`;
  const check = issue.delivery?.summary ?? issue.shortfall?.summary ?? null;
  return (
    <section className="cn-card" id={GOAL_ANCHOR.tail}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="The tail" />
        <i className="cn-n">{issue.state === 'open' ? 'ticket open' : issue.state}</i>
      </h3>
      {fold.open && (
        <div className="cn-rows">
          <div className="cn-row">
            <i className={`cn-lamp ${check === null ? 'cn-off' : issue.delivery ? 'cn-run' : 'cn-wait'}`} />
            <span className="cn-grow">
              <b className="cn-name">Goal check</b>
              <span className="cn-sub">{check ?? 'has not run'}</span>
            </span>
          </div>
          <div className="cn-row">
            <i className={`cn-lamp ${issue.retrospective === null ? 'cn-off' : 'cn-run'}`} />
            <span className="cn-grow">
              <b className="cn-name">Write-up</b>
              <span className="cn-sub">{issue.retrospective?.summary ?? 'not written'}</span>
            </span>
            {issue.retrospective !== null && (
              <button type="button" className={CONTROL_CLASS} onClick={() => actions.viewRetro(ref)}>
                Read
              </button>
            )}
          </div>
          <div className="cn-row">
            <i className={`cn-lamp ${issue.state === 'open' ? 'cn-off' : 'cn-run'}`} />
            <span className="cn-grow">
              <b className="cn-name">Close the ticket</b>
              <span className="cn-sub">{issue.state === 'open' ? 'still open' : issue.state}</span>
            </span>
          </div>
          <div className="cn-row">
            <i className={`cn-lamp ${issue.scratchpad === null ? 'cn-off' : 'cn-run'}`} />
            <span className="cn-grow">
              <b className="cn-name">Notes</b>
              <span className="cn-sub">
                {issue.scratchpad === null ? 'nothing written' : `${issue.scratchpad.entries} entries`}
              </span>
            </span>
            {issue.scratchpad !== null && (
              <button type="button" className={CONTROL_CLASS} onClick={() => actions.viewScratchpad(ref)}>
                Open
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
