import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView, GoalSection, GoalStage, GoalStageAt, PartGroup } from '../view/goalPage.js';
import type { NeedRow } from '../view/needsYou.js';
import { buildGoalStrip, goalSectionsOpen, GOAL_SECTIONS } from '../view/goalPage.js';
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
import { ProfilePicker } from '../components/ProfilePicker.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { InstructionModal } from '../components/InstructionModal.js';
import { GateReleaseModal } from '../components/GateReleaseModal.js';
import { EndRunModal } from '../components/EndRunModal.js';
import { renderRichText } from '../components/richText.js';
import { issueTypeTone } from '../issueGroups.js';
import { Tag, type TagTone } from '../components/tag.js';
import { fmtUsd, relTime } from '../components/util.js';
import { Ref, TicketLink } from '../components/refs.js';
import { waitingOnThis, waitsOn, waveOf, wavesOf } from '../view/sequence.js';
import { askPrompt, localRunPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { Icon } from '../components/icons.js';
import { CiMark } from '../components/CiMark.js';
import { PackMark } from '../components/PackMark.js';
import { ReviewMark } from '../components/ReviewMark.js';
import {
  CONTROL_CLASS,
  ControlBar,
  ControlButton,
  ControlGroup,
  ControlSegment,
  ControlSegments,
} from '../components/controls.js';
import { ValidationSection } from '../components/ValidationSection.js';
import { SignalsSection } from '../components/SignalsSection.js';
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
  localValidationTone,
  STATUS_WORD,
  validateLocallyQuestion,
  type LocalValidationTone,
} from '../view/localValidation.js';
import { Button } from '../components/button.js';

/**
 * Where each of the track's stages jumps to. Anchors, not refs — one element on
 * this page — so they are ids rather than `<Ref>`s, and the controls that carry
 * them are buttons.
 *
 * The map is keyed on {@link GoalStageAt} so a stage the strip learns to draw
 * cannot ship without somewhere to land: a missing entry is a compile error here
 * rather than a control that does nothing, which is the cockpit's most repeated
 * bug and the one thing this strip must not become.
 */
/**
 * The local validation card's anchor, beside {@link ANCHOR} rather than in it: no
 * track stage lands here, because a run somebody asked for is not a stage of the
 * goal's life. The chip is what jumps to it.
 */
const LOCAL_VALIDATION_ANCHOR = 'cn-local-validation';

/** The chip classes each tone wears, in the goal header's own vocabulary. */
const CHIP_TONE: Record<LocalValidationTone, string> = {
  up: 't-green',
  busy: 't-amber',
  bad: 't-red',
  off: '',
};

const ANCHOR: Record<GoalStageAt, string> = {
  plan: 'cn-plan',
  validation: 'cn-validation',
  environments: 'cn-environments',
  tail: 'cn-tail',
};

/**
 * Which section each track stage jumps to, so a jump can *open* what it lands on.
 * A stage that scrolled to a card the goal's own progress had folded away was a
 * control that appeared to do nothing — the page moved and the reading it moved to
 * was not drawn.
 *
 * Keyed on {@link GoalStageAt} for `ANCHOR`'s reason: a stage without a section is
 * a compile error rather than a dead jump. `plan` is not foldable and says so with
 * a null.
 */
const STAGE_SECTION: Record<GoalStageAt, GoalSection | null> = {
  plan: null,
  validation: 'validation',
  environments: 'environments',
  tail: 'tail',
};

/** The three statuses that mean an agent is still going, as `countLiveAgents` reads them. */
const LIVE_AGENT = new Set<Agent['status']>(['starting', 'running', 'waiting']);

/**
 * One goal, with what it wants from you pinned above everything it is doing.
 *
 * That order is the design's whole claim: an ask read next to the goal it is
 * about is answerable, and the same ask read in an inbox is a sentence with no
 * subject. So the bands come first and the plan, the ticket and the pull requests
 * come under them — and a goal with nothing to ask draws no band at all rather
 * than an empty one, because a band that is sometimes furniture stops being read
 * as a demand.
 *
 * Under the bands the page is **three full-width zones and then two columns**,
 * which is a claim about width rather than about importance. The plan is a board
 * read left to right and the validation card draws a check's steps beside what to
 * expect from it; both were laid out in a 1.6fr column, and that column is the
 * whole reason the waves only went side by side at 1500px. Full width they lay out
 * from 1200 — and, with the two wide cards out of the grid, what is left is four
 * row-lists that split comfortably at the same 1200 rather than needing 1500 of
 * their own. One breakpoint for the page instead of two.
 *
 * The plan is also now **above** validation, which is the ordering the cards
 * themselves have always asked for: the validation card's own subtitle says the
 * checks are written by the plan, and the plan was underneath it.
 *
 * The goal-profile gate (#342) is one of those bands rather than a section of
 * its own, which is what puts it in the rail as well: it holds every dispatch for
 * this goal and expires on nothing but the answer, so a hold drawn only here was
 * one nobody found until they wondered why the goal had not started.
 *
 * Every band embeds the *shared* component that owns its refusal rules —
 * `EscalationCard` for a question, a permission or a proposal, `HumanTaskActions`
 * for a bench task — embedded, never redrawn. A second wiring is a second way to
 * answer a proposal with free text on one surface only.
 *
 * What is deliberately not here: this goal's slice of the decision log. The
 * snapshot ships the last hundred audit rows fleet-wide and a cycle spends one of
 * them every pulse on its own rationale, so filtered to one goal the list is a
 * handful of dispatches at best and empty for any goal not touched in the last
 * few hours. The design says that becomes its own route rather than being
 * half-built, and this takes that arm.
 */
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
  return (
    <div className="cn-goal">
      <Header page={page} view={view} actions={actions} folds={folds} />
      <OrphanBand issue={page.issue} view={view} actions={actions} />
      <TrackStrip page={page} folds={folds} />
      {parentAskElsewhere(page).map((row) => (
        <NeedsBand key={row.id} row={row} view={view} actions={actions} />
      ))}
      <Ticket issue={page.issue} refUrls={view.state.refUrls} fold={folds.ticket} />
      <PlanWaves page={page} view={view} actions={actions} />
      <Validation
        page={page}
        actions={actions}
        refUrls={view.state.refUrls}
        desktopFolder={view.state.config.desktopFolder}
        fold={folds.validation}
      />
      <LocalValidation page={page} view={view} actions={actions} fold={folds.localValidation} />
      <Signals page={page} actions={actions} refUrls={view.state.refUrls} fold={folds.signals} />
      <Sequence page={page} fold={folds.sequence} />
      <div className="cn-gcols">
        <div className="cn-stack">
          <PullRequests page={page} view={view} actions={actions} />
          <Environments page={page} actions={actions} now={view.now} fold={folds.environments} />
        </div>
        <div className="cn-stack">
          <OnThisGoal page={page} view={view} actions={actions} />
          <Instructions issue={page.issue} actions={actions} />
          <Tail issue={page.issue} actions={actions} fold={folds.tail} />
          <Spend issue={page.issue} />
        </div>
      </div>
      <Reference page={page} view={view} fold={folds.record} />
    </div>
  );
}

/**
 * One foldable card's state and the control that changes it, resolved once for the
 * whole page.
 *
 * A pair rather than a boolean, because every draw site needs both and the toggle
 * is the same three lines each time. `open` is already the answer — the default and
 * the two overrides have been folded together — so no card re-reads the place.
 */
interface Fold {
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Opens the card without closing anything, for a jump that lands on it. */
  reveal: () => void;
}

/**
 * Where each foldable card starts, and where the operator has since put it.
 *
 * Three inputs, in one order that never varies: the operator's `?open=` wins, then
 * their `?shut=`, then {@link goalSectionsOpen}'s reading of how far the goal has
 * actually got. The default moves as the work does — a card is folded while there
 * is nothing in it and opens itself once there is — and the operator's word about
 * one is permanent in both directions.
 * → docs/spec/17-cockpit.md#folding-what-is-not-relevant-yet
 */
function buildFolds(page: GoalPageView, view: CockpitView, actions: CockpitActions): Record<GoalSection, Fold> {
  const byDefault = goalSectionsOpen(page);
  const entries = GOAL_SECTIONS.map((section): [GoalSection, Fold] => {
    const open = view.goalOpen.has(section) ? true : view.goalShut.has(section) ? false : byDefault[section];
    return [
      section,
      {
        open,
        onToggle: (next) => actions.openGoalSection(section, next),
        reveal: () => {
          if (!open) actions.openGoalSection(section, true);
        },
      },
    ];
  });
  return Object.fromEntries(entries) as Record<GoalSection, Fold>;
}

/**
 * Scroll to a card, having first opened it.
 *
 * The scroll is deferred a frame because the open is a route change: the card is
 * still folded when this returns, and scrolling to it now lands on the heading of
 * a card that is about to grow underneath the viewport.
 */
function jumpTo(anchor: string, fold: Fold | null): void {
  fold?.reveal();
  requestAnimationFrame(() => {
    document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

/**
 * This goal's asks, less the parent question — which the page now states above,
 * louder, and with the same three answers under it.
 *
 * Filtered here rather than dropped from {@link buildNeedsYou}, because the row is
 * not redundant everywhere: the rail still carries it, and the ask panel still
 * answers it for an operator working down the queue rather than down a page. What
 * would be wrong is only this page drawing both — one question, twice, with two
 * sets of buttons that write the same field.
 *
 * The area-path half of `placement` is untouched. It is a different question with
 * a different answer, and the band above says nothing about it.
 */
function parentAskElsewhere(page: GoalPageView): NeedRow[] {
  return page.needs.filter((row) => !row.id.startsWith('placement:parent:'));
}

/**
 * The goal's pipeline in one row, each stretch a way to the section that owns it.
 *
 * It is the page's only surface that says nothing of its own: every reading on it
 * is folded by {@link buildGoalStrip} out of what a card below already draws, so
 * the top of the page cannot disagree with the thing it points at. That is the
 * whole of why the counters it replaced came out of the header — "2 of 5 parts
 * merged" beside "Validation 3/7" beside a reach chip two screens down was four
 * answers to one question, in four places, none of which was where the question
 * gets asked.
 *
 * Buttons rather than `<a href="#…">`, for `cn-jump`'s reason: an anchor changes
 * the address bar, and the cockpit's address bar is `Place` — a hash the place
 * knows nothing about is a history entry the back button steps through to nowhere.
 */
function TrackStrip({ page, folds }: { page: GoalPageView; folds: Record<GoalSection, Fold> }): JSX.Element {
  return (
    <div className="cn-strip">
      {buildGoalStrip(page).map((stage) => (
        <Stage key={stage.at} stage={stage} folds={folds} />
      ))}
    </div>
  );
}

function Stage({ stage, folds }: { stage: GoalStage; folds: Record<GoalSection, Fold> }): JSX.Element {
  const section = STAGE_SECTION[stage.at];
  return (
    <button
      type="button"
      className={`cn-tk cn-t-${stage.tone}`}
      onClick={() => jumpTo(ANCHOR[stage.at], section === null ? null : folds[section])}
      title={`${stage.label}: ${stage.reading} — go to it`}
    >
      <span className="cn-tkk">{stage.label}</span>
      <span className="cn-tkv">{stage.reading}</span>
      {/* Drawn only for a stage with a proportion to draw. An empty bar under
          "no checks" would report every check outstanding, which is the one thing
          a null `done` exists to keep it from saying. */}
      <span className={`cn-tkb ${stage.done === null ? 'cn-none' : ''}`}>
        {stage.done !== null && <i style={{ width: `${stage.done}%` }} />}
      </span>
    </button>
  );
}

/**
 * What is left of the goal once the snapshot has forgotten it, folded away behind
 * its own name at the foot of the page.
 *
 * The ticket used to sit beside it here, and has gone back to the top. The two
 * were paired as *the surfaces that ask nothing of the reader*, which was true of
 * both and only half the story about the ticket: it is what every other card on
 * the page is measured against, and reaching it meant scrolling past all of them.
 * Folded, it costs a heading, which is what it was moved down here to avoid.
 * → docs/spec/17-cockpit.md#folding-what-is-not-relevant-yet
 *
 * **Whether it is open is a `Place`**, not a `useState`. A disclosure held in
 * component state works right up until the back button steps over it or a reload
 * drops it, and both are silent. → docs/spec/17-cockpit.md#the-address-bar
 */
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

/**
 * A card heading that opens its own card. The state being *set* is the argument
 * rather than a bare toggle, for `collapseFeature`'s reason: the caller already
 * knows which way the caret points, and a toggle read from stale props would
 * fight a disclosure restored from the URL.
 */
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

/**
 * The goal itself, and the verdicts anyone has passed on it. Each chip quotes a
 * reading the server already made — the appraisal's own word with its summary in the
 * title, the tracker's own workflow state — so nothing here is a second opinion.
 *
 * A null `spend` draws no reading at all. It means nothing was ever measured (a
 * PTY fleet reports no usage), and `$0.00` would report a goal that cost nothing.
 */
function Header({
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
  const { issue } = page;
  const { config } = view.state;
  const [raisingBug, setRaisingBug] = useState(false);
  const watched = watchBucket(issue.labels, config.watchLabel);
  const finished = issue.conclusion.verdict === 'done';
  // `more_work` is not the opposite of `done` — it is the verdict that puts a
  // goal back in front of the harness once no PR is open, so it needs its own
  // control rather than a second meaning for the finished toggle. Here it only
  // marks the button: what the operator writes is the instruction, and the
  // verdict is what makes there be an agent to read it.
  const moreWork = issue.conclusion.verdict === 'more_work';
  const [instructing, setInstructing] = useState(false);
  const [endingRun, setEndingRun] = useState(false);
  // Which question pressing Validate locally raises, or null while it is open on
  // nothing. Local state and not `Place`: a modal is not a destination.
  const [validating, setValidating] = useState<'swap' | 'refresh' | null>(null);
  // The refusal from a post that went straight through — the one path with no modal
  // to land it in. Without somewhere to say it, a 409 from a race would be a click
  // that did nothing, which is the failure the two required notes already taught
  // this page to avoid. → [17](../../../docs/spec/17-cockpit.md)
  const [validateRefusal, setValidateRefusal] = useState<string | null>(null);
  const run = view.state.localRun;
  const target = view.state.localRunTargets.find((t) => t.issueNumber === issue.number);
  const offer = localValidationOffer(issue, target, config.localRunConfigured);
  // What is in the environment now, for the swap modal's sentence. Read off the
  // goals the cockpit already holds rather than shipped a second time: the modal
  // names it, and a title it cannot find is one it leaves out.
  const runTitle =
    run === null
      ? null
      : (view.state.world.issues.find((i) => `issue:${String(i.number)}` === run.originRef)?.title ?? null);
  const onValidate = async (): Promise<void> => {
    const question = validateLocallyQuestion(issue.number, run);
    // A question opens a modal and posts nothing, so there is no request to hold a
    // pending state on — the modal is the feedback.
    if (question !== null) {
      setValidating(question);
      return;
    }
    setValidateRefusal(null);
    // Awaited rather than fired and forgotten: the button reads its pending state
    // off this promise, and the post behind it starts an environment and runs a
    // cycle. Rejections reach `onRefused`, which is what draws the sentence.
    await actions.validateLocally(issue.number);
  };
  // What ending the run costs, or null when it costs nothing: the route refuses a
  // dismissal with no note while the plan is flagged
  // ([20](../../../docs/spec/20-validation.md#where-it-lands)), and the button
  // posting none was a control that could not work — the 400 went to an unhandled
  // rejection, so the click did nothing and said nothing.
  const owed = issue.validation !== null && issue.validation.state === 'flagged' ? issue.validation : null;
  const standing = issue.instructions.length;
  // What ending the run kills: the `issue:<n>` subtree only, which is the exact
  // scope `clearGoalWork` sweeps. The header counts the goal's agents through its
  // pull requests as well, and those keep running — so the two numbers are read
  // apart on purpose and the modal says which is which, rather than promising a
  // kill the route does not do.
  const live = page.agents.filter((a) => a.onPr === null && LIVE_AGENT.has(a.agent.status)).length;
  const livePr = page.agents.filter((a) => a.onPr !== null && LIVE_AGENT.has(a.agent.status)).length;
  // Keyed on the run existing and not having been ended, never on anything the
  // page itself is showing: the button is how a run is abandoned, so it has to be
  // reachable for exactly as long as the harness still holds one.
  const retained = issue.run !== undefined && !issue.run.dismissed;
  // The other end of the same reading: a run the harness held and the operator
  // ended. Drawn as the run state's third segment, inert — the goal *is* in that
  // state, and a segment that disappeared once it was reached would leave the
  // control saying the run is still working.
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
      </div>
      {/* The verdicts, and nothing else. The counters that used to share this row —
          how long it has run, how many agents, what it cost, how many parts had
          merged — read as noise beside a judgement, and three of the four are now
          on the track. What is left of them is one plain run at the end, which is
          the reading nothing else on the page states in one place. */}
      <div className="cn-ghmeta">
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
        {/* Whether the goal's validation plan is settled, beside the other
              verdicts and inside none of them. Absent when there are no checks —
              a goal nobody wrote a plan for is not "clear", and a chip claiming
              it was would be the one lie this whole surface exists to prevent.
              A button rather than the bare chip its neighbours are: the checks are
              now on this page, so the reading has somewhere to go, and a verdict
              you can act on should not be the one chip that does nothing. */}
        {issue.validation !== null && (
          <button
            type="button"
            className={`tag tag-fill tag-button ${issue.validation.state === 'clear' ? 't-green' : 't-amber'}`}
            onClick={() => jumpTo(ANCHOR.validation, folds.validation)}
            title={
              issue.validation.state === 'clear'
                ? `All ${issue.validation.total} validation checks are settled — go to them`
                : `${issue.validation.failed} failed, ${issue.validation.unrun} never run, ${issue.validation.deferred} deferred — go to them`
            }
          >
            <Icon name="flask" size={12} />
            Validation · {issue.validation.passed + issue.validation.waived} of {issue.validation.total} settled
          </button>
        )}
        {/* What the fleet found driving this goal on the operator's own machine,
            beside the plan's verdict and separate from it: one is a checklist
            somebody keeps, the other is a run somebody asked for. In flight it is
            the only thing drawn about the validation, and it says which minute of
            it we are in — the control above is absent while one is running. */}
        {issue.localValidation !== null && (
          <button
            type="button"
            className={`tag tag-fill tag-button cn-ghverdict cn-jump ${CHIP_TONE[localValidationTone(issue.localValidation.status)]}`}
            onClick={() => jumpTo(LOCAL_VALIDATION_ANCHOR, folds.localValidation)}
            title={issue.localValidation.summary ?? 'Go to what the local validation found'}
          >
            <Icon name="flask" size={12} />
            Local validation ·{' '}
            {inFlight(issue.localValidation)
              ? localValidationSaid(issue.localValidation)
              : STATUS_WORD[issue.localValidation.status]}
          </button>
        )}
        {/* The measurements, in one run at the end rather than as three more chips.
            `parts merged` is deliberately not among them: it is the track's first
            stage now, and stating it twice is how the header and the plan card
            came to disagree. */}
        <span className="cn-ghfacts">
          {issue.run !== undefined && <>started {relTime(issue.run.startedAt, view.now)} · </>}
          {page.agents.length} agent{page.agents.length === 1 ? '' : 's'}
          {issue.spend !== null && <> · {fmtUsd(issue.spend.costUsd)}</>}
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
        {/* Checking the work, which is neither steering it nor leaving the page:
            it asks the fleet to bring this goal up on the operator's own machine
            and drive it. Its own group because it is the only control here whose
            effect is on *this machine* rather than on the tracker or the queue —
            and the whole group is absent when there is nothing to press, since a
            caption over nothing is furniture. */}
        {offer.offered && (
          <ControlGroup caption="Check the work" icon="flask" divider>
            {/* An `AsyncButton` rather than a `ControlButton`, and that is not a
                styling choice: the post behind it starts a dev environment and runs
                a cycle, so it is seconds of work, and a control that looked
                unpressed for those seconds got pressed again. This one disables
                itself while the request is in flight, says so, and lands the
                route's own refusal in its title — which is also what retires the
                separate refusal line this header used to draw. */}
            <AsyncButton
              className={`${CONTROL_CLASS} primary`}
              onClick={onValidate}
              onRefused={setValidateRefusal}
              pendingLabel={
                <>
                  <Icon name="flask" />
                  Starting…
                </>
              }
              title="Bring this goal's code up in your dev environment and send one agent to write a test plan, drive the running application through it, and report here. Asks first if something else is running."
            >
              <Icon name="flask" />
              {/* The label carries whether this has been done before. A goal that
                  has been validated and one that never has are different states,
                  and the chip beside it says the verdict but not that the button is
                  the thing that produced it. */}
              {issue.localValidation === null ? 'Validate locally' : 'Validate locally again'}
            </AsyncButton>
          </ControlGroup>
        )}
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
            className={CONTROL_CLASS}
            folder={config.desktopFolder}
            prompt={askPrompt(issue.number)}
            ready="ready for your question"
            explain="answered from what the harness actually recorded about this goal — the plan, the pull requests, what was escalated, what it cost, and where the work has reached."
          >
            <Icon name="chat" />
            Ask Claude Code ↗
          </DesktopLink>
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
      {validateRefusal !== null && (
        <p className="launch-error" role="alert">
          {validateRefusal}
        </p>
      )}
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

/**
 * How anyone checks this goal was met — the checks, and what anybody concluded
 * from running each one.
 *
 * **Full width, above the two columns.** Not in either stack: a check draws its
 * steps and what to expect side by side and carries a row of five verbs, and both
 * are cramped in a column. Sitting directly under the header also puts it above
 * the plan, which is the order the page already reads in — what is being asked of
 * you, then the work. Running a check is the one thing on this page that is
 * *owed*, and the bands above it are the only thing that outranks that.
 *
 * The card draws even when the goal has no checks, the rule every card on this
 * page follows: a surface that vanishes when quiet is indistinguishable from one
 * that broke, and "nobody wrote a validation plan" is the reading most worth
 * having.
 *
 * {@link ValidationSection} is *embedded*, never redrawn — the same rule the needs
 * bands follow with `EscalationCard`. It owns the five verbs and their refusals;
 * this passes `cn-btn` so they wear the console's chrome, the seam
 * `HumanTaskActions` already takes.
 */
/**
 * What the plan still owes, in the header chip's own words rather than a second
 * wording of them — the counts are the server's fold (`issue.validation`), and
 * two surfaces reading one verdict two ways is the thing that fold exists to
 * prevent.
 */
function outstanding(verdict: ValidationVerdict): string {
  return `Its validation plan is not clear — ${verdict.failed} failed, ${verdict.unrun} never run, ${verdict.deferred} deferred, of ${verdict.total}.`;
}

/**
 * The goal's tracker state, in the colour the operator gave it.
 *
 * The same reading as the backlog's chip and for the same reason: two surfaces
 * drawing one state two colours would be worse than neither being coloured.
 */
function StateChip({ state, colours }: { state: string; colours: Readonly<Record<string, string>> }): JSX.Element {
  const colour = stateColour(colours, state);
  return (
    <span className="tag" style={colour === null ? undefined : { color: colour, borderColor: colour }}>
      {state}
    </span>
  );
}

/**
 * What the fleet found driving this goal on the operator's own machine.
 *
 * **Its own card, under the validation plan.** Not a band inside it, which is the
 * cheaper shape and the wrong one: that card is a checklist against the
 * *delivered* goal and folds until the work has shipped, and this is an
 * exploratory run against work still in flight — folded inside it, the report an
 * operator asked for two minutes ago would be hidden on exactly the unshipped goal
 * they asked about. Under it rather than over, because the plan's checks are the
 * standing statement of what this goal has to do and a run is one look at it.
 *
 * The card is drawn even with nothing in it, the page's rule for every other card:
 * a surface that vanishes when it is empty is one an operator cannot learn.
 */
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
  const target = view.state.localRunTargets.find((t) => t.issueNumber === issue.number);
  const offer = localValidationOffer(issue, target, view.state.config.localRunConfigured);
  // Which of this goal's agents are still going, so the report gives a finished one
  // a door rather than a pulse. The same `LIVE_AGENT` set the header counts with,
  // rather than a second opinion about what "running" means.
  const liveAgents = new Set(page.agents.filter((a) => LIVE_AGENT.has(a.agent.status)).map((a) => a.agent.id));

  return (
    <section className="cn-card" id={LOCAL_VALIDATION_ANCHOR}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Local validation" />
        <i className="cn-n">
          {validation === null
            ? 'never run'
            : inFlight(validation)
              ? localValidationSaid(validation)
              : STATUS_WORD[validation.status]}
        </i>
        {/* What tells this apart from the card above it, on the card itself: that
            one is a person's checklist, this is an agent's run at the machine in
            front of them. Without the sentence the two read as the same feature
            drawn twice. */}
        <span className="cn-more">an agent, in your own dev environment</span>
      </h3>
      {fold.open && (
        <div className="cn-vin">
          <LocalValidationReport
            validation={validation}
            why={offer.offered ? null : offer.why}
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

function Validation({
  page,
  actions,
  refUrls,
  desktopFolder,
  fold,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  refUrls: Record<string, string>;
  /** `config.desktopFolder` — the checkout the desktop hand-off opens Claude Code on. */
  desktopFolder: string;
  fold: Fold;
}): JSX.Element {
  const { issue, plan, checks } = page;
  const live = checks.filter((c) => c.supersededReason === null);
  const settled = live.filter((c) => c.state === 'passed' || c.state === 'waived').length;

  return (
    <section className="cn-card" id={ANCHOR.validation}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Validation" />
        {live.length > 0 && (
          <i className="cn-n">
            {settled}/{live.length} settled
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
          className="cn-linkish"
          folder={desktopFolder}
          prompt={localRunPrompt(issue.number)}
          explain="so this goal’s work is running on the machine in front of you — then it offers you the checks."
        >
          run it locally ↗
        </DesktopLink>
      </h3>
      {fold.open && (
        <div className="cn-vin">
          <ValidationSection
            checks={checks}
            issueNumber={issue.number}
            resources={page.checkResources}
            refUrls={refUrls}
            desktopFolder={desktopFolder}
            look={{ tone: 'secondary' }}
            onResult={(checkId, result, note) =>
              actions.setValidation(issue.number, checkId, { kind: 'result', result, note })
            }
            onDefer={(checkId, reason) => actions.setValidation(issue.number, checkId, { kind: 'defer', reason })}
            onWaive={(checkId, reason) => actions.setValidation(issue.number, checkId, { kind: 'waive', reason })}
            onReset={(checkId) => actions.setValidation(issue.number, checkId, { kind: 'reset' })}
            onHandover={(checkId, to) => actions.setValidation(issue.number, checkId, { kind: 'handover', to })}
          />
        </div>
      )}
    </section>
  );
}

/**
 * What this goal asked production to show for the work, and the controls that
 * change it.
 *
 * Under Validation and above the environments, which is the order the two
 * questions are asked in: validation is *did we build it*, this is *did it do
 * anything*, and the environment rows below carry what each window has read since
 * the work arrived there. The card is the declarations; those rows are the
 * readings.
 *
 * **Nothing is drawn where nothing is declared and nothing could be**, which is
 * this subsystem's own null rule rather than the page being tidy: a goal that
 * declared no checks reads null, and an empty card headed "Signals" is a surface
 * saying the fleet is verified. The exception is a goal whose plan *has* a watch
 * block — there the card draws with its list, and the add controls are how the
 * list grows.
 */
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
  // No checks and no plan is a goal nobody has planned, and an add control on it
  // would offer a query against an environment for work that does not exist yet.
  if (signals.length === 0 && plan === null) return null;
  const pending = signals.filter((c) => !c.live).length;
  return (
    <section className="cn-card" id="cn-signals">
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Signals" />
        <i className="cn-n">
          {signals.length === 1 ? '1 check' : `${signals.length} checks`}
          {pending > 0 && ` · ${pending} awaiting you`}
        </i>
        <span className="cn-more">
          asked of production after this ships
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
 * A part's pull request as the page holds it, with the flag that says which list
 * it came off. A boolean rather than a check for `attention` at the draw site:
 * the closed list ships {@link PullRequest}, where every verdict is optional
 * because nothing folds one for a dead PR, and narrowing it back to
 * {@link OpenPullRequest} by sniffing a field is a cast wearing a condition.
 */
type PartPr = { open: true; pr: OpenPullRequest } | { open: false; pr: PullRequest };

const GROUP_ORDER: PartGroup[] = ['merged', 'now', 'held', 'waiting'];
const GROUP_LABEL: Record<PartGroup, string> = {
  merged: 'Merged',
  now: 'Now',
  held: 'Held',
  waiting: 'Not started',
};

/**
 * The plan, left to right in dispatch order. Grouped by the derivation's own four
 * groups rather than by `status` a second time, so what the overview's segment
 * track counts and what this draws cannot disagree.
 *
 * A held part carries the reconciler's `blockedReason` verbatim. It is the one
 * status nothing else in the world explains — a blocked part has no branch, no PR
 * and no agent to read — so a paraphrase here would be the only account there is,
 * and wrong.
 *
 * **Retired parts are drawn too, in a column of their own.** What an amendment
 * dropped is half of what the plan's record is for: without them a goal whose part
 * list shrank between two readings has simply lost rows, with nothing saying so.
 * They sit outside the four groups because they are outside every count on this
 * page: what the plan proposed is not what the goal is made of.
 *
 * **The header carries the way into the plan sheet.** What this card draws is the
 * shape of the work — titles, groups and dependencies — and the plan is also a
 * diagnosis, an approach, an acceptance checklist per part and the record of the
 * decision that was made on it. Without a control here the only way onto that
 * from a goal was the validation card's aside about amending the checks, which
 * reads as being about checks.
 */
function PlanWaves({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    parts: page.parts.filter((p) => p.group === group),
  })).filter((g) => g.parts.length > 0);
  const retired = page.retiredParts;
  const plan = page.plan;
  // Keyed on the number the part carries, and the open list written second so an
  // open pull request wins a collision rather than the recently-closed copy of it.
  const prs = new Map<number, PartPr>();
  for (const pr of page.closedPullRequests) prs.set(pr.number, { open: false, pr });
  for (const pr of page.openPullRequests) prs.set(pr.number, { open: true, pr });

  return (
    <section className="cn-card" id={ANCHOR.plan}>
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
          {plan !== null && (
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
      <div className="cn-waves">
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
                now={view.now}
                actions={actions}
              />
            ))}
          </div>
        ))}
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
                pr={null}
                now={view.now}
                actions={actions}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One part of the plan.
 *
 * **The agent on it is drawn as a way there, never as its id.** `agent_ab4sc`
 * beside a part named nothing — agent ids are minted and an agent has no name of
 * its own — and the one thing the operator wanted from it, the run's transcript
 * and its controls, was on a surface the row did not lead to. The row already
 * names the part, so the control is a door rather than a second name, and it sits
 * beside the pull-request reference rather than around it: one click cannot have
 * two destinations, so a `<Ref>` is never nested inside a button.
 */
function Part({
  part,
  group,
  agentId,
  agentLive,
  pr,
  now,
  actions,
}: {
  part: PlanPart;
  /** The four the page groups by, plus the one that is drawn beside them and counted in none of them. */
  group: PartGroup | 'retired';
  agentId: string | null;
  agentLive: boolean;
  /** The pull request this part's number names, when the page holds it. */
  pr: PartPr | null;
  now: number;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className={`cn-part cn-${group}`}>
      <b>
        {part.seq} · {part.title}
      </b>
      {group === 'held' && part.blockedReason !== null && <p className="cn-why">{part.blockedReason}</p>}
      {part.scope !== '' && <p>{part.scope}</p>}
      {/* A dead pull request's word is drawn only where it disagrees with the
          column the part is standing in: "merged" under the Merged heading is the
          heading again, while a merged PR on a part grouped anywhere else — or a
          PR closed unmerged — is the one thing the board cannot say for itself. */}
      {pr !== null && (pr.open || pr.pr.merged !== (group === 'merged')) && (
        <span className="cn-pstate">
          {/* The checks are drawn for an open pull request only, which is what the
              pull-request card does with the same two components: on a dead PR
              the checks are history, and the card's closed rows carry a word and
              no chip for exactly that reason. */}
          {pr.open ? (
            <>
              <CiMark pr={pr.pr} />
              <CourtChip pr={pr.pr} now={now} />
            </>
          ) : (
            <Tag tone={pr.pr.merged ? 'green' : undefined} fill={pr.pr.merged}>
              {pr.pr.merged ? 'merged' : 'closed'}
            </Tag>
          )}
        </span>
      )}
      <span className="cn-dep">
        {part.dependsOn.length > 0 ? `depends on ${part.dependsOn.join(', ')}` : 'depends on nothing'}
        {part.prNumber !== null && (
          <>
            {' · '}
            <Ref to={`pr:${part.prNumber}`} label={`PR #${part.prNumber}`} />
          </>
        )}
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

/**
 * The ticket as it stood at pickup — what a plan, an appraisal or an ask is judged
 * against.
 *
 * Through `renderRichText`, not `renderMarkdown`: Azure DevOps stores a
 * description as HTML, and markdown-rendering it printed the `<p>` and `<br>` as
 * text. This is the one field on the page the *tracker* wrote rather than an
 * agent, which is why it is the one that sniffs.
 */
/**
 * What the operator has asked for on this goal and no agent has answered yet.
 *
 * **Above the ticket, and it draws nothing when there is nothing standing.** Both
 * halves are deliberate. An instruction outranks the ticket for as long as it
 * stands — it is the newer statement of the same goal — so reading it after the
 * body it amends is reading them in the wrong order. And a card that were always
 * present would be furniture: the empty-state rule the rest of this page follows
 * ("a surface that vanishes when quiet is indistinguishable from one that broke")
 * is about surfaces that answer a standing question, and "has anyone written on
 * this goal" is answered by the header's own control, which is always drawn and
 * counts them.
 *
 * Withdrawing is offered per row because an instruction is free text sent to an
 * agent: a typo, or a mind changed before anything picked it up, needs a way back
 * that is not "wait for an agent to act on it".
 */
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

/**
 * The goal as it was written, at the top of the page it is the top of.
 *
 * **Open until the work starts, folded from the moment it has.** Those are the two
 * readings the same card is: on a goal nobody has planned it is the only thing on
 * the page with anything in it, and the operator is here to read it; on a goal with
 * a plan, ten pull requests and a validation sheet it has been read, and it is a
 * screen of prose between the track and the work. It goes back to the top either
 * way, because *what was asked for* is what everything below it is measured
 * against, and a reader who wants it half way down a running goal should not have
 * to scroll past the whole run to reach it.
 *
 * `workStarted` rather than a plan alone — see {@link goalSectionsOpen}.
 */
function Ticket({ issue, refUrls, fold }: { issue: Issue; refUrls: Record<string, string>; fold: Fold }): JSX.Element {
  return (
    <section className="cn-card" id="cn-ticket">
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="The ticket" />
        <span className="cn-more">as it stood at pickup</span>
      </h3>
      {fold.open && (
        <div className="cn-tick">
          {issue.body.trim() === '' ? <p className="cn-empty">The ticket has no description.</p> : null}
          {renderRichText(issue.body, refUrls)}
        </div>
      )}
    </section>
  );
}

/**
 * This goal's pull requests. Whose court and which check is red are both the
 * server's verdicts — `attention.status` and `ciVerdict` — quoted rather than
 * re-read here: a client-side second opinion about a merge is the drift that
 * outlives the change that introduces it.
 */
function PullRequests({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const open = page.openPullRequests;
  const closed = page.closedPullRequests;
  return (
    <section className="cn-card">
      <h3>
        Pull requests
        <i className="cn-n">
          {open.length} open · {closed.length} closed
        </i>
      </h3>
      <div className="cn-rows">
        {open.length === 0 && closed.length === 0 && <p className="cn-empty">No pull request names this goal yet.</p>}
        {open.map((pr) => (
          // An unwatched PR is drawn spent, the same as a closed one below and as
          // an unwatched goal in the backlog: nothing will happen on it, and a row
          // at full weight says the opposite.
          <div className={`cn-row ${pr.attention.status === 'unwatched' ? 'cn-spent' : ''}`} key={pr.number}>
            <span className="cn-grow">
              {/* The name is the way onto the pull request's page and the reference
                  sits beside it, never inside it: one click cannot have two
                  destinations, and the provider is a different place from the
                  cockpit's own page for the same pull request.
                  → docs/spec/17-cockpit.md#links */}
              <button type="button" className="cn-prlink" onClick={() => actions.selectPr(pr.number)}>
                #{pr.number} {pr.title}
              </button>
              <span className="cn-sub">{pr.branch}</span>
            </span>
            <ThreadChip pr={pr} />
            {/* The fleet's own reading, left of the checks so the two verdicts
                read in the order the harness produces them. */}
            <ReviewMark review={pr.review} now={view.now} onOpen={() => actions.selectPr(pr.number)} />
            <PackMark pack={pr.pack} onOpen={() => actions.selectPr(pr.number)} />
            <CiMark pr={pr} onOpen={() => actions.selectPr(pr.number)} />
            <CourtChip pr={pr} now={view.now} />
            <span className="cn-refs">
              <Ref to={`pr:${pr.number}`} />
            </span>
          </div>
        ))}
        {closed.map((pr) => (
          <div className="cn-row cn-spent" key={pr.number}>
            <span className="cn-grow">
              <button type="button" className="cn-prlink" onClick={() => actions.selectPr(pr.number)}>
                #{pr.number} {pr.title}
              </button>
              <span className="cn-sub">{pr.branch}</span>
            </span>
            <ThreadChip pr={pr} />
            {/* The one verdict a dead pull request keeps: what was read is a
                record, where the other three are about what happens next. */}
            <ReviewMark review={pr.review} now={view.now} onOpen={() => actions.selectPr(pr.number)} />
            <Tag tone={pr.merged ? 'green' : undefined} fill={pr.merged}>
              {pr.merged ? 'merged' : 'closed'}
            </Tag>
            <span className="cn-refs">
              <Ref to={`pr:${pr.number}`} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * How much of the review is still on the fleet, on the row — the one number from
 * the pull request's page worth carrying back to the goal, because it is the one
 * that says whether anybody is waiting.
 *
 * Nothing at all when the provider reports no threads, and nothing when none is
 * outstanding: a chip reading `0` on every settled pull request is furniture, and
 * one drawn where the reading is *absent* would be a claim about a review the
 * harness cannot see. → docs/spec/07-pull-requests.md#review-threads
 */
function ThreadChip({ pr }: { pr: PullRequest }): JSX.Element | null {
  const waiting = (pr.reviewThreads ?? []).filter((t) => t.state === 'open' || t.state === 'reopened').length;
  if (waiting === 0) return null;
  return (
    <Tag tone="amber" fill title="Review threads the fleet has not answered">
      {waiting} on us
    </Tag>
  );
}

/**
 * Where this story sits in the order its Feature was given — folded shut.
 *
 * Shut by default because a story's own page is read for the story, and its
 * neighbours are what the Feature page is for. **The folded reading is the whole
 * point of folding it**: `wave 2 of 4 · 2 waiting on this` says what the rows
 * would, and a goal nothing is waiting on says so without being opened — the
 * `0/3 reached` case. `2 waiting on this` is the reason to open it, and the
 * Feature’s ref sits on the shut header so the way up does not require expanding.
 *
 * A copy, never a second record: the order is the Feature’s, and it is answered,
 * amended and argued with there.
 * → `docs/spec/33-story-sequencing.md#the-goal-page`
 */
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

/**
 * Where this goal's landed work has got to, one chip per configured environment.
 *
 * Drawn under the pull requests because it is the sentence after them: these
 * merged, and this is where they went. Absent entirely when no environment is
 * configured — a row of question marks on every deployment that never set one up
 * would be a feature announcing itself as broken.
 *
 * The counts are on every chip that is not whole, including `absent`, because
 * "0/3" and "2/3" are the difference between work that has not started moving and
 * work that is halfway there — and the word alone says neither.
 */
function Environments({
  page,
  actions,
  now,
  fold,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  now: number;
  fold: Fold;
}): JSX.Element | null {
  const [releasing, setReleasing] = useState(false);
  if (page.environments.length === 0) return null;
  const number = page.issue.number;
  const reached = page.environments.filter((e) => e.status === 'reached').length;
  return (
    <section className="cn-card" id={ANCHOR.environments}>
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Environments" />
        {/* The count folded away is the whole reading: a card shut on "0/3
            reached" says what the rows would have, and one shut on "2/3" is the
            reason to open it. */}
        <i className="cn-n">
          {reached}/{page.environments.length} reached
        </i>
      </h3>
      {fold.open && (
        <div className="cn-rows">
          {page.environments.map((env) => (
            <div className="cn-env" key={env.environment}>
              <div className="cn-row">
                <span className="cn-grow">
                  <b className="cn-name">{env.environment}</b>
                  <span className="cn-sub">
                    {REACH_SAID[env.status]}
                    {/* What arriving here does, on the row that would do it. An
                    operator reading a held goal asks "waiting for what" exactly
                    once, and the answer is configuration they wrote weeks ago. */}
                    {env.opens.length > 0 && ` · opens ${env.opens.map((g) => GATE_SAID[g]).join(' and ')}`}
                  </span>
                </span>
                {env.status !== 'reached' && (
                  <i className="cn-n">
                    {env.landed}/{env.total}
                  </i>
                )}
                <Tag tone={REACH_TONE[env.status]} fill={REACH_TONE[env.status] !== undefined}>
                  {env.status}
                </Tag>
              </div>
              {/* Inside the environment's own row and not beside it: a watch belongs
                to an arrival, and the two surfaces drawn as siblings would be free
                to disagree about which environment a reading came from. */}
              <Watch
                watch={page.watches.find((w) => w.environment === env.environment)}
                issueNumber={number}
                now={now}
                actions={actions}
              />
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
 * What the environment has said since the work arrived in it.
 *
 * **Inside the row and not beside it**, because a watch belongs to an arrival:
 * drawn as a sibling, the two surfaces would be free to disagree about which
 * environment a reading came from — the disagreement the strip's fold exists to
 * prevent one layer up.
 *
 * **Every check draws, and nothing rolls up to a word.** A goal whose one signal
 * passed and whose other regressed is a fix that worked and a thing that is still
 * broken, and a single verdict for the pair would hide the half the ticket was
 * about.
 *
 * Nothing renders where nothing is watched: no empty block, no row of question
 * marks. A goal that declared no checks and a deployment where no environment
 * declares a `watch` both arrive here as `undefined`, because null is a third fact
 * rather than a synonym for clean.
 */
function Watch({
  watch,
  issueNumber,
  now,
  actions,
}: {
  watch: GoalWatchView | undefined;
  issueNumber: number;
  now: number;
  actions: CockpitActions;
}): JSX.Element | null {
  if (watch === undefined || watch.checks.length === 0) return null;
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

/**
 * One check's reading in the operator's words. A reading that did not come back
 * says so.
 *
 * **A measure reads as expected, before and now**, and the before is what makes
 * the row worth looking at: a p95 of 310ms means nothing alone and everything
 * beside the 8,400ms it replaced. It is available precisely because the baseline
 * was taken at declaration, days before the arrival — so a measure that has one
 * says it, and one that never had a baseline taken says *that* rather than
 * printing a number with nothing beside it.
 */
function watchSaid(check: GoalWatchCheckView): string {
  const reading = check.reading;
  if (reading === null) return 'Not yet put to this environment. Nothing has been read.';
  if (reading.detail !== null) return reading.detail;
  if (check.kind === 'measure') return measureSaid(check, reading.value);
  return check.tolerate === 0
    ? 'No matching rows at all, which is what it declared.'
    : `${String(reading.rows ?? 0)} matching rows, within the ${String(check.tolerate)} it declared.`;
}

/** Expected, before, now — the three the card draws a measure as. */
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

/**
 * No new colours: every tone is one the console already draws, so a theme switch
 * carries the watch block without the token layer having to learn about it.
 *
 * `unknown` takes the attention tone rather than a neutral one deliberately — an
 * environment nobody could read is work, not an all-clear, and it is the reading
 * that most looks like success.
 */
const WATCH_TONE: Record<WatchCheckVerdict | 'unread', TagTone | undefined> = {
  clean: 'green',
  regressed: 'red',
  unknown: 'amber',
  unread: undefined,
};

/** What each gate holds, in the words the card's own rows use for it. */
const GATE_SAID: Record<EnvironmentGate, string> = {
  validate: 'the validation checks',
  close_out: 'the close-out',
};

/**
 * No new colours: every tone here is one the cockpit already draws, so the strip
 * follows a theme switch without the token layer having to learn about it.
 *
 * `partial` takes the attention tone rather than a success one deliberately — half
 * a feature in production is the state on this panel most likely to want somebody,
 * and drawing it green is the mistake the whole tri-state exists to avoid.
 */
const REACH_TONE: Record<GoalReachStatus, TagTone | undefined> = {
  reached: 'green',
  partial: 'red',
  unknown: 'amber',
  absent: undefined,
};

/**
 * What each verdict means, in the words an operator would use asking about it.
 *
 * **Work, not merges.** The fraction counts a plan's unmerged parts too, so a goal
 * three parts short of done reads `1/4` here — and "all of this goal's merges are
 * here" would be true of a row saying `partial`, which is the sentence disagreeing
 * with the count beside it.
 */
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
 * A wait in the units it is read in: days past a day, hours below.
 *
 * Exported for the overview's rack, which draws the same age as a fact on the
 * row. One threshold, in one place — the same reason the chip below was shared
 * before the rack drew the court itself.
 */
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

export function waitedFor(sinceIso: string, now: number): string {
  const hours = Math.floor(Math.max(0, now - Date.parse(sinceIso)) / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}

/**
 * Whose court a pull request is in, and — on the one arm that means it — how long
 * it has been in somebody else's.
 *
 * The goal page's own reading. The overview's rack draws the court in its state
 * column instead — a word in the column every card puts its state in beats the
 * same word in a chip one column further right, which is what the row grammar is
 * for. Both quote `attention`, so neither is a second opinion.
 *
 * **The age is drawn from the first pulse a pull request is observed waiting.**
 * There was a `reviewReminderMs` threshold here, on the argument that an age on
 * every open pull request says nothing about any — which is a team's problem. One
 * person's queue is short enough to read, and a threshold only hides how long the
 * short queue has been sitting.
 *
 * It stays a *chip*, never a row in "Needs you": nothing is dispatched, escalated
 * or filed at any age — the harness has no more idea than you do how to make a
 * review happen faster.
 */
/**
 * Whose court a pull request is in, with how long it has been waiting where that
 * arm means it.
 *
 * Exported for the pull-request page for `CiMark`'s reason: the chip is a
 * reading of `attention`, and a second one written beside it would be a second
 * opinion about a verdict the server already took.
 */
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

/**
 * Who is on this goal right now, and what each has cost where that was measured.
 *
 * **A pull request is for a goal, so an agent on one is on the goal.** A dispatch
 * names the goal's own subtree or it names a pull request — a CI fix, a review
 * round, a retarget — and a card that read only the first said *no agent is on
 * this goal* while somebody was fixing its build, which is the reading an operator
 * is on this page to take. The row names that pull request as a way there, since a
 * row saying an agent is on something and not where is the dead end the ref rule
 * exists to stop. The reference sits **beside** the name rather than inside it:
 * the row's own click opens the transcript, and one click cannot have two
 * destinations.
 */
function OnThisGoal({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <section className="cn-card">
      <h3>
        On this goal <i className="cn-n">{page.agents.length}</i>
      </h3>
      <div className="cn-rows">
        {page.agents.length === 0 && <p className="cn-empty">No agent is on this goal.</p>}
        {page.agents.map(({ agent, onPr, title }) => (
          <div className="cn-row" key={agent.id}>
            <i
              className={`cn-lamp ${agent.status === 'waiting' ? 'cn-lamp-ask' : agent.endedAt === null ? 'cn-run' : 'cn-off'}`}
            />
            <button
              type="button"
              className="cn-grow"
              onClick={() => actions.select(agent.id)}
              title="Open this agent's drawer — its transcript, what it cost, and its controls"
            >
              <b className="cn-name">{title ?? agent.id}</b>
              <span className="cn-sub">
                {agent.status} · {relTime(agent.startedAt, view.now)}
                {agent.note !== null && ` · ${agent.note}`}
              </span>
            </button>
            {agent.costUsd !== null && <span className="cn-num">{fmtUsd(agent.costUsd)}</span>}
            {onPr !== null && (
              <span className="cn-refs">
                <Ref to={`pr:${onPr}`} label={`PR #${onPr}`} />
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * What the goal has cost, over every agent under it and every local run of it. The whole card is absent
 * when nothing was measured — the rows would all read zero and none of them would
 * be a reading.
 */
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

/**
 * What is left after the parts: the goal check, the write-up, and closing the
 * ticket. Each states the verdict its own author wrote, or that nothing has run —
 * "not reached yet" is a fact about the goal worth seeing, not an empty section.
 */
function Tail({ issue, actions, fold }: { issue: Issue; actions: CockpitActions; fold: Fold }): JSX.Element {
  const ref = `issue:${issue.number}`;
  const check = issue.delivery?.summary ?? issue.shortfall?.summary ?? null;
  return (
    <section className="cn-card" id={ANCHOR.tail}>
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
