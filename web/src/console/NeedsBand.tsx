import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { HumanTask, Issue } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { EscalationCard } from '../components/EscalationCard.js';
import { HumanTaskActions } from '../components/HumanTaskActions.js';
import { renderMarkdown } from '../components/markdown.js';
import { ParentPicker } from '../components/ParentPicker.js';
import { proposedParentTitle } from '../view/orphanGoal.js';
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { Ref } from '../components/refs.js';
import { goalIssue } from '../view/goalPage.js';
import { refusedDispatchFor } from '../view/needsYou.js';
import { relTime } from '../components/util.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, holdingLabel } from './QueueRail.js';
import { Button } from '../components/button.js';

// → docs/spec/17-cockpit.md

export function NeedsBand({
  row,
  view,
  actions,
}: {
  row: NeedRow;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const body = needBody(row, view, actions);
  if (body === null) return null;
  return (
    <div className={`cn-needs cn-t-${KIND_TONE[row.kind]}`}>
      <header>
        <span className="cn-sym" aria-hidden="true">
          {KIND_SYMBOL[row.kind]}
        </span>
        Needs you · {KIND_LABEL[row.kind]}
        <span className="cn-age">
          {row.raisedAt !== '' && relTime(row.raisedAt, view.now)}
          {row.holding > 0 && ` · ${holdingLabel(row.holding)}`}
        </span>
        {/* The same ask, alone and in front — for a goal carrying several, or a
            page scrolled past this one. It is the panel the rail opens for an ask
            with no goal page, drawn from the same `needBody`, so there is one
            implementation of the ask and two ways to reach it rather than two
            asks. */}
        <button type="button" className="cn-open" onClick={() => actions.openPanel({ ask: row.id })}>
          Open
        </button>
      </header>
      <div className="cn-in">{body}</div>
    </div>
  );
}

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

/**
 * What answers this ask — the shared component that owns its verdict. `look` is
 * the one seam a station passes, [`Button`](../components/button.tsx)'s own props.
 *
 * Null means the row's source is no longer in the snapshot, which is also how the
 * ask panel closes itself.
 *
 * @public shared with the ask panel, which draws the body under its own header
 */
export function needBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  if (row.kind === 'watch') {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    return <WatchFinding task={task} view={view} actions={actions} />;
  }
  if (
    row.kind === 'bench' ||
    row.kind === 'close_out' ||
    row.kind === 'burn' ||
    row.kind === 'validate' ||
    row.kind === 'supply'
  ) {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    return (
      <>
        <p>{task.title}</p>
        {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
        <div className="cn-acts">
          <HumanTaskActions
            task={task}
            look={{ tone: 'secondary' }}
            noteOnDone={noteOwedOnDone(task, view)}
            onDone={(id, note) => actions.completeHumanTask(id, note)}
            onDecline={(id, note) => actions.declineHumanTask(id, note)}
            onCloseTicket={closeTicketFor(task, view) ? (id, note) => actions.closeHumanTaskTicket(id, note) : null}
          />
        </div>
      </>
    );
  }
  if (row.kind === 'intake') {
    const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
    const appraisal = issue?.appraisal;
    if (!issue || appraisal?.verdict !== 'unclear') return null;
    return (
      <>
        <p>
          <strong>The goal appraisal could not say this is workable</strong> — nothing is dispatched for it until the
          verdict moves.
        </p>
        <p className="cn-tick">“{appraisal.summary}”</p>
        {appraisal.missing.length > 0 && (
          <ul className="cn-tick">
            {appraisal.missing.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        )}
        <p className="cn-tick">
          The hold clears by itself when the goal&rsquo;s own text changes, so answering those on the ticket is the
          other way out and costs no click here. Overriding says the brief is good enough as it stands.
        </p>
        <div className="cn-acts">
          <AsyncButton
            tone="primary"
            onClick={() => actions.setIssueAppraisal(issue.number, 'workable')}
            title="Work it anyway — the harness stops holding pickup and runs a cycle now"
          >
            Override → workable
          </AsyncButton>
        </div>
      </>
    );
  }
  if (row.kind === 'profile') {
    const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
    const appraisal = issue?.appraisal;
    if (!issue || !appraisal?.awaitingProfileAnswer || appraisal.proposedProfile === null) return null;
    const { config } = view.state;
    const proposed = appraisal.proposedProfile;
    const pinned = issue.modelPin.profile;
    const standing = pinned ?? config.defaultProfile;
    const described = config.profiles.find((p) => p.name === proposed)?.description;
    return (
      <>
        <p>
          <strong>The goal appraisal wants this run on “{proposed}”</strong>
          {standing !== null &&
            ` — ${pinned === null ? 'it would otherwise run on' : 'you pinned it to'} “${standing}”`}
          {standing === null && ' — nothing is pinned to it yet'}
        </p>
        <p className="cn-tick">
          {described ?? appraisal.summary} Nothing is dispatched for this goal until you say which to use — that is one
          click either way, and it is not a rejection.
        </p>
        <div className="cn-acts">
          <AsyncButton
            tone="primary"
            onClick={() => actions.setIssueProfile(issue.number, proposed)}
            title={`Pin this goal to “${proposed}” and let the funnel move`}
          >
            Use “{proposed}”
          </AsyncButton>
          <AsyncButton
            onClick={() => actions.setIssueProfile(issue.number, pinned)}
            title={
              pinned === null
                ? 'Leave this goal unpinned, so each rule runs on its own profile'
                : `Keep “${pinned}” and let the funnel move`
            }
          >
            {pinned === null ? 'Leave it unpinned' : `Keep “${pinned}”`}
          </AsyncButton>
        </div>
      </>
    );
  }
  if (row.kind === 'placement') {
    const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
    const ask = (issue?.appraisal?.placement ?? []).find((p) => `placement:${p.field}:${row.goalRef}` === row.id);
    if (!issue || !ask) return null;
    return ask.field === 'parent' ? (
      <ParentAsk issue={issue} proposed={ask.proposedParent} view={view} actions={actions} />
    ) : (
      <AreaPathAsk issue={issue} proposed={ask.proposedAreaPath} view={view} actions={actions} />
    );
  }
  if (row.kind === 'limit') {
    const agent = row.agentId ? view.agentById.get(row.agentId) : undefined;
    if (!agent || !view.limitParked.has(agent.id)) return null;
    return (
      <>
        <p>{agent.waitingReason ?? 'This account has no usage allowance left right now.'}</p>
        <p className="cn-tick">
          Nothing failed and nothing is lost: the branch, the worktree and the conversation are as the agent left them.
          Resuming re-opens that conversation where it stopped.
        </p>
        <div className="cn-acts">
          <AsyncButton tone="primary" onClick={() => actions.resumeAgent(agent.id)} pendingLabel="Resuming…">
            Resume
          </AsyncButton>
          <Button onClick={() => actions.select(agent.id)}>Open transcript</Button>
        </div>
      </>
    );
  }
  if (row.kind === 'assigned') {
    const number = Number(/^assigned:pr:(\d+)$/.exec(row.id)?.[1]);
    const pr = view.state.world.pullRequests.find((p) => p.number === number);
    if (!pr) return null;
    return (
      <>
        <p>
          <strong>{pr.title}</strong>
        </p>
        <p className="cn-tick">{pr.attention?.reasons.join(' · ')}</p>
        <p className="cn-tick">
          Nothing in the harness will act on this. It is here because somebody put it on you where the fleet cannot see
          it, and it stops being drawn the moment they take it off you again.
        </p>
        <div className="cn-refs">
          <Ref to={`pr:${pr.number}`} title="Open the pull request" />
        </div>
      </>
    );
  }
  if (row.kind === 'dispatch') {
    const refusal = refusedDispatchFor(view.state, row.id);
    if (!refusal) return null;
    const rule = refusal.rule === null ? undefined : view.state.dispatchRules[refusal.rule];
    return (
      <>
        <p>
          <strong>
            Nothing has dispatched for this since {relTime(refusal.since, view.now)} — {refusal.pulses} pulses, each
            refused.
          </strong>
        </p>
        <p className="cn-tick">{refusal.detail}</p>
        <p className="cn-tick">
          The harness is proposing it again on every pulse and will go on doing so; it is not paused, and nothing about
          it is retried differently. Clearing what the refusal names is the whole of the fix.
          {rule && ` The rule proposing it is “${rule.name}”.`}
        </p>
        {refusal.originRef !== null && (
          <div className="cn-refs">
            <Ref to={refusal.originRef} title="Open what the refused dispatch is about" />
          </div>
        )}
      </>
    );
  }
  const escalation = view.state.escalations.find((e) => e.id === row.id);
  if (!escalation) return null;
  return (
    <EscalationCard
      escalation={escalation}
      proposal={view.proposalFor.get(escalation.id)}
      resumedAt={escalation.agentId ? (view.agentById.get(escalation.agentId)?.resumedAt ?? null) : null}
      now={view.now}
      refUrls={view.state.refUrls}
      desktopFolder={view.state.config.desktopFolder}
      onAnswer={(text) => actions.answerEscalation(escalation.id, text)}
      onAnswerQuestions={(answers) => actions.answerQuestions(escalation.id, answers)}
      onDecide={(id, verdict, note, acknowledged) => actions.decideProposal(id, verdict, note, acknowledged)}
      onBackOut={(id, verdict, note) => actions.backOutProposal(id, verdict, note)}
      onOverrule={(issueNumber, proposalId, text) => actions.overruleShortfall(issueNumber, proposalId, text)}
      onPermission={(id, allow, note) => actions.decidePermission(id, allow, note)}
      onDismiss={(id, note) => actions.dismissEscalation(id, note)}
      onOpenAgent={(id) => actions.select(id)}
      onComplete={(id) => actions.completeAgent(id)}
      stallExpiresAt={escalation.agentId ? (view.stallExpiryByAgent.get(escalation.agentId) ?? null) : null}
      onExtend={(id) => actions.extendStall(id)}
      onViewPlan={(id) => actions.viewPlan(id)}
    />
  );
}

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
      <p>{task.title}</p>
      {task.detail && <div className="cn-tick">{renderMarkdown(task.detail, view.state.refUrls)}</div>}
      <div className="cn-acts">
        <HumanTaskActions
          task={task}
          look={{ tone: 'secondary' }}
          noteOnDone={null}
          onDone={(id, note) => actions.completeHumanTask(id, note)}
          onDecline={(id, note) => actions.declineHumanTask(id, note)}
          onCloseTicket={null}
        />
        {canRaise && (
          <Button
            onClick={() => setRaising(true)}
            title="Raise a bug from this reading — the numbers ride as your own report, and the bug is related back to this goal"
          >
            Raise a bug…
          </Button>
        )}
      </div>
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

function ParentAsk({
  issue,
  proposed,
  view,
  actions,
}: {
  issue: Issue;
  proposed: number | null;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const containerTitle = proposedParentTitle(view.state, proposed);
  return (
    <>
      {proposed === null ? (
        <p>
          <strong>This goal rolls up to nothing.</strong> Nothing has been suggested for it.
        </p>
      ) : (
        <p>
          <strong>This goal rolls up to nothing.</strong> The appraisal suggests{' '}
          {containerTitle === null ? `work item #${proposed}` : `“${containerTitle}”`}.
          <span className="cn-refs">
            <Ref to={`issue:${proposed}`} title="Open the suggested parent and check it before you accept it" />
          </span>
        </p>
      )}
      <p className="cn-tick">
        Nothing is held up by this: the work is dispatched, done and merged either way. What is missing is the item’s
        place on the backlog — unparented, it rolls up to nothing and whoever plans the work cannot see it.
      </p>
      <ParentPicker issue={issue} proposed={proposed} view={view} actions={actions} />
    </>
  );
}

function AreaPathAsk({
  issue,
  proposed,
  view,
  actions,
}: {
  issue: Issue;
  proposed: string | null;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const [chosen, setChosen] = useState<string>('');
  if (proposed === null) return null;
  const options = view.state.config.areaPaths.filter((p) => p !== proposed);
  return (
    <>
      <p>
        <strong>This goal is on no team’s board.</strong> The appraisal suggests the area “{proposed}”.
      </p>
      <p className="cn-tick">
        It is still on the project root, which is where an item nobody has filed sits. Nothing is held up — the work
        happens either way — but until it is filed it is on nobody’s board.
      </p>
      <div className="cn-acts">
        <AsyncButton
          tone="primary"
          onClick={() => actions.setIssueAreaPath(issue.number, proposed)}
          title={`File this goal under “${proposed}”`}
        >
          Use “{proposed}”
        </AsyncButton>
        {options.length > 0 && (
          <>
            <select
              className="cn-in"
              value={chosen}
              aria-label="A different area path"
              onChange={(e) => setChosen(e.currentTarget.value)}
            >
              <option value="">Choose another…</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <AsyncButton
              disabled={chosen === ''}
              onClick={() => actions.setIssueAreaPath(issue.number, chosen)}
              title="File this goal under the area you picked"
            >
              Use that one
            </AsyncButton>
          </>
        )}
        <AsyncButton
          onClick={() => actions.setIssueAreaPath(issue.number, null)}
          title="This goal wants no area path — stop asking"
        >
          Not applicable
        </AsyncButton>
      </div>
    </>
  );
}
