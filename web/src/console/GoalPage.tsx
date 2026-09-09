import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView, GoalSection, GoalStage, GoalStageAt, PartGroup } from '../view/goalPage.js';
import type { NeedRow } from '../view/needsYou.js';
import { buildGoalStrip, goalSectionsOpen, reachCount, GOAL_SECTIONS } from '../view/goalPage.js';
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
  localValidationTone,
  STATUS_WORD,
  validateLocallyQuestion,
  type LocalValidationTone,
} from '../view/localValidation.js';
import { Button } from '../components/button.js';
import { logUsage } from '../cockpit/usage.js';

// → docs/spec/17-cockpit.md

const LOCAL_VALIDATION_ANCHOR = 'cn-local-validation';

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

const STAGE_SECTION: Record<GoalStageAt, GoalSection | null> = {
  plan: null,
  validation: 'validation',
  environments: 'environments',
  tail: 'tail',
};

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
      <RemoteValidation page={page} view={view} actions={actions} fold={folds.remoteValidation} />
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

interface Fold {
  open: boolean;
  onToggle: (open: boolean) => void;
  reveal: () => void;
}

function buildFolds(page: GoalPageView, view: CockpitView, actions: CockpitActions): Record<GoalSection, Fold> {
  const byDefault = goalSectionsOpen(page);
  const entries = GOAL_SECTIONS.map((section): [GoalSection, Fold] => {
    const open = view.goalOpen.has(section) ? true : view.goalShut.has(section) ? false : byDefault[section];
    return [
      section,
      {
        open,
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

function jumpTo(anchor: string, fold: Fold | null): void {
  fold?.reveal();
  requestAnimationFrame(() => {
    document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function parentAskElsewhere(page: GoalPageView): NeedRow[] {
  return page.needs.filter((row) => !row.id.startsWith('placement:parent:'));
}

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
  const moreWork = issue.conclusion.verdict === 'more_work';
  const [instructing, setInstructing] = useState(false);
  const [endingRun, setEndingRun] = useState(false);
  const [validating, setValidating] = useState<'swap' | 'refresh' | null>(null);
  const [validateRefusal, setValidateRefusal] = useState<string | null>(null);
  const run = view.state.localRun;
  const target = view.state.localRunTargets.find((t) => t.issueNumber === issue.number);
  const offer = localValidationOffer(issue, target, config.localRunConfigured);
  const runTitle =
    run === null
      ? null
      : (view.state.world.issues.find((i) => `issue:${String(i.number)}` === run.originRef)?.title ?? null);
  const onValidate = async (): Promise<void> => {
    const question = validateLocallyQuestion(issue.number, run);
    if (question !== null) {
      setValidating(question);
      return;
    }
    setValidateRefusal(null);
    await actions.validateLocally(issue.number);
  };
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

function outstanding(verdict: ValidationVerdict): string {
  return `Its validation plan is not clear — ${verdict.failed} failed, ${verdict.unrun} never run, ${verdict.deferred} deferred, of ${verdict.total}.`;
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
  const target = view.state.localRunTargets.find((t) => t.issueNumber === issue.number);
  const offer = localValidationOffer(issue, target, view.state.config.localRunConfigured);
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
          folder={desktopFolder}
          prompt={localRunPrompt(issue.number)}
          explain="so this goal’s work is running on the machine in front of you — then it offers you the checks."
        />
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
  const open = sheets.find((s) => s.environment === showing) ?? sheets[0]!;
  const waiting = open.rows.filter((r) => r.awaitingApproval).length;
  return (
    <section className="cn-card" id="cn-remote-validation">
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Does it work here" />
        <i className="cn-n">
          {open.rows.length === 1 ? '1 row' : `${open.rows.length} rows`}
          {waiting > 0 && ` · ${waiting} waiting on an approval`}
        </i>
        <span className="cn-more">asked of {open.environment}, where this goal&rsquo;s work has arrived</span>
      </h3>
      {fold.open && (
        <RemoteValidationSection
          sheets={sheets}
          showing={showing}
          onShow={(environment) => actions.openRemoteSheet(environment)}
          controls={{
            onRule: (environment, rowId, accept) =>
              actions.ruleRemoteQuery(page.issue.number, environment, rowId, accept),
            onSelect: (environment, rowId, selected) =>
              actions.selectRemoteRow(page.issue.number, environment, rowId, selected),
            onPress: (environment) => actions.pressRemoteSheet(page.issue.number, environment),
            onCancel: (environment) => actions.cancelRemoteRun(page.issue.number, environment),
            onReseed: (environment) => actions.reseedRemoteTenant(page.issue.number, environment),
          }}
        />
      )}
    </section>
  );
}

type PartPr = { open: true; pr: OpenPullRequest } | { open: false; pr: PullRequest };

const GROUP_ORDER: PartGroup[] = ['merged', 'now', 'held', 'waiting'];
const GROUP_LABEL: Record<PartGroup, string> = {
  merged: 'Merged',
  now: 'Now',
  held: 'Held',
  waiting: 'Not started',
};

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
  group: PartGroup | 'retired';
  agentId: string | null;
  agentLive: boolean;
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
            <SplitChip pr={pr} />
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

// A pull request rule `pr-split` read and found to hold more than one concept.
// Only the split verdict draws: a coherent one is the question asked and
// answered, and a chip for it would sit on every wide pull request saying
// nothing happened. → docs/spec/17-cockpit.md
function SplitChip({ pr }: { pr: PullRequest }): JSX.Element | null {
  const split = pr.split;
  if (split === undefined || split.verdict !== 'split') return null;
  return (
    <Tag tone="amber" fill title={`${split.concepts.join(' · ')}\n\n${split.reason}`}>
      {split.concepts.length} concepts
    </Tag>
  );
}

function ThreadChip({ pr }: { pr: PullRequest }): JSX.Element | null {
  const waiting = (pr.reviewThreads ?? []).filter((t) => t.state === 'open' || t.state === 'reopened').length;
  if (waiting === 0) return null;
  return (
    <Tag tone="amber" fill title="Review threads the fleet has not answered">
      {waiting} on us
    </Tag>
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
                {(env.status !== 'reached' || env.unplaced > 0) && <i className="cn-n">{reachCount(env)}</i>}
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
  validate: 'the validation checks',
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

export function waitedFor(sinceIso: string, now: number): string {
  const hours = Math.floor(Math.max(0, now - Date.parse(sinceIso)) / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
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
