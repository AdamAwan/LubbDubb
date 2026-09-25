import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView } from '../view/goalPage.js';
import type { Agent, Issue, ValidationVerdict } from '../types.js';
import { ProfilePicker } from '../components/ProfilePicker.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { InstructionModal } from '../components/InstructionModal.js';
import { EndRunModal } from '../components/EndRunModal.js';
import { issueTypeTone } from '../issueGroups.js';
import { Tag } from '../components/tag.js';
import { fmtUsd, relTime } from '../components/util.js';
import { TicketLink } from '../components/refs.js';
import { askPrompt } from '../cockpit/desktopLink.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { Icon } from '../components/icons.js';
import {
  CONTROL_CLASS,
  ControlBar,
  ControlButton,
  ControlGroup,
  ControlSegment,
  ControlSegments,
} from '../components/controls.js';
import { watchBucket } from '../worldBuckets.js';
import { StaleChip, StateChip } from './goalChips.js';

const LIVE_AGENT = new Set<Agent['status']>(['starting', 'running', 'waiting']);

// → docs/spec/17-cockpit.md

export function Header({
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
  const [instructing, setInstructing] = useState(false);
  const [endingRun, setEndingRun] = useState(false);
  const owed = issue.validation !== null && issue.validation.state === 'flagged' ? issue.validation : null;
  const standing = issue.instructions.length;
  const live = page.agents.filter((a) => a.onPr === null && LIVE_AGENT.has(a.agent.status)).length;
  const livePr = page.agents.filter((a) => a.onPr !== null && LIVE_AGENT.has(a.agent.status)).length;

  return (
    <div className="cn-gh">
      <GoalIdent page={page} view={view} />
      {/* Three captioned groups, drawn through the control kit
          (`web/src/components/controls.tsx`) rather than as class strings: what
          state the run is in, what steers the work, and what happens somewhere
          other than this goal. The caption is the part that does the explaining —
          it answers "how is this one different from that one" once, for a whole
          group, so no control has to grow a defensive name of its own.
          → docs/spec/17-cockpit.md#the-headers-controls */}
      <ControlBar>
        <RunStateGroup issue={issue} actions={actions} onEnd={() => setEndingRun(true)} />
        <SteerGroup issue={issue} view={view} actions={actions} onInstruct={() => setInstructing(true)} />
        <LeaveGroup issue={issue} config={config} onRaiseBug={() => setRaisingBug(true)} />
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

function GoalIdent({ page, view }: { page: GoalPageView; view: CockpitView }): JSX.Element {
  const { issue } = page;
  const { config } = view.state;
  return (
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
  );
}

/* Working, done and ended are three states of one thing, so they are one
   control rather than two buttons at opposite ends of the row. What
   "Mark done" and "End the run" each did was never legible from their
   names side by side; as segments of a run state they are obviously
   alternatives, and which one the goal is in is readable without pressing
   anything. Ending still wears the danger tone and still opens the modal. */
function RunStateGroup({
  issue,
  actions,
  onEnd,
}: {
  issue: Issue;
  actions: CockpitActions;
  onEnd: () => void;
}): JSX.Element {
  const finished = issue.conclusion.verdict === 'done';
  const retained = issue.run !== undefined && !issue.run.dismissed;
  const ended = issue.run !== undefined && issue.run.dismissed;
  return (
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
            onClick={onEnd}
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
  );
}

/* What steers the work the harness does on this goal. Every control here
   is reversible by pressing it again, which is what holds it apart from
   the group before. */
function SteerGroup({
  issue,
  view,
  actions,
  onInstruct,
}: {
  issue: Issue;
  view: CockpitView;
  actions: CockpitActions;
  onInstruct: () => void;
}): JSX.Element {
  const { config } = view.state;
  const watched = watchBucket(issue.labels, config.watchLabel);
  const moreWork = issue.conclusion.verdict === 'more_work';
  const standing = issue.instructions.length;
  return (
    <ControlGroup caption="Steer the work" icon="pen" divider>
      {issue.state === 'open' && (
        <ControlButton
          icon="pen"
          tone={moreWork ? 'on' : 'primary'}
          count={standing}
          onClick={onInstruct}
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
  );
}

/* The three controls whose effect is not on this goal: two destinations,
   and the one that starts a second ticket about it. Grouping them is what
   answers "how is filing a bug different from giving instructions" —
   one steers the work here, one leaves. */
function LeaveGroup({
  issue,
  config,
  onRaiseBug,
}: {
  issue: Issue;
  config: CockpitView['state']['config'];
  onRaiseBug: () => void;
}): JSX.Element {
  return (
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
          onClick={onRaiseBug}
          title="Report that this does not work as you expect — an agent files it as a separate bug against this goal. It changes nothing about this goal's own verdict."
        >
          File a new bug
        </ControlButton>
      )}
    </ControlGroup>
  );
}

function outstanding(verdict: ValidationVerdict): string {
  return `Its checks are not clear — ${verdict.failed} failed, ${verdict.unrun} not run, ${verdict.deferred} left for later, of ${verdict.total}.`;
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
