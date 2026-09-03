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
import { RaiseBugModal } from '../components/RaiseBugModal.js';
import { Ref } from '../components/refs.js';
import { goalIssue } from '../view/goalPage.js';
import { refusedDispatchFor } from '../view/needsYou.js';
import { relTime } from '../components/util.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, holdingLabel } from './QueueRail.js';
import { Button } from '../components/button.js';

/**
 * One open ask, pinned, in the tone and under the glyph its kind wears on the
 * rail — the row and the band it opens have to read as one ask, and hue plus
 * symbol is most of how an operator recognises that they have.
 *
 * The rail's *weight* split (`cn-parked`) is not carried over, and that is the
 * one thing the two surfaces deliberately differ on: weight is a triage aid for a
 * list of asks competing for attention, and the band is a single ask already in
 * front of the operator with its verdict controls under it. There is nothing here
 * to rank it against.
 *
 * The band draws nothing at all when the row's source is gone from the snapshot.
 * A header over an empty box would claim something is waiting while offering no
 * way to answer it.
 *
 * It lives here rather than on the goal page because a goal is not the only place
 * an ask is read: a row whose origin is a pull request has no goal page to sit on
 * ({@link NeedRow.opens}), and it is answered in the ask panel through this same
 * component. One band, two placements — a second wiring is a second set of
 * verdicts to keep in step.
 */
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

/**
 * Why marking this row done costs a sentence, or null when it costs nothing.
 *
 * The route's own guard, mirrored: `POST /api/human-tasks/:id/done` refuses a
 * `close_out` on a goal whose validation plan is flagged unless a note comes with
 * it ([20](../../../docs/spec/20-validation.md#where-it-lands)). Mirrored here for
 * `HumanTaskActions`' Decline reason — the box that answers a rule belongs beside
 * the click, not behind a 400 the operator has to provoke first — and mirrored
 * only in its *condition*: the counts stay the server's, folded once into
 * `issue.validation` and stated in the row's own detail above these buttons.
 *
 * The server stays the authority. A plan flagged between this draw and the click
 * refuses there, and the refusal is drawn where it lands.
 */
function noteOwedOnDone(task: HumanTask, view: CockpitView): string | null {
  if (task.kind !== 'close_out' || task.status !== 'open' || task.originRef === null) return null;
  const issue = goalIssue(view.state, task.originRef);
  if (issue?.validation?.state !== 'flagged') return null;
  return 'Validation is not clear on this goal — the checks listed above are outstanding. Closing it out is still yours to do; what it costs is a sentence saying what you are doing about them, or waiving them first.';
}

/**
 * Whether this row's ticket can be closed from here.
 *
 * Three conditions, and each is a different kind of no. Only a `close_out` row
 * asks for a close at all; only an `issue:` origin names something to close; and
 * only a deployment whose tracker the harness can write has anywhere to send it —
 * `config.canCloseIssue` is the connector's own answer, asked once on the server
 * rather than inferred here from the provider's name.
 *
 * A false draws no button rather than a disabled one: the row already says the
 * other way to discharge it, and a control that cannot work teaches nothing the
 * sentence above it does not.
 */
function closeTicketFor(task: HumanTask, view: CockpitView): boolean {
  if (task.kind !== 'close_out' || task.status !== 'open') return false;
  if (task.originRef === null || !/^issue:\d+$/.test(task.originRef)) return false;
  return view.state.config.canCloseIssue;
}

/**
 * What answers this ask — the shared component that owns its verdict, wired the
 * way the stamp desk and the bench wire it. `look` is the one seam a station
 * passes — [`Button`](../components/button.tsx)'s own props — so the console's
 * buttons and a modal's are one component wearing two faces.
 *
 * Null means the row's source is no longer in the snapshot, which is also how the
 * ask panel closes itself: the answer settles the row, the next snapshot drops
 * it, and the surface that was drawing it has nothing left to draw.
 *
 * @public shared with the ask panel, which draws the body under its own header
 */
export function needBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  // The post-deploy watch's finding. It answers the same two ways as a bench row
  // and carries one control the others do not, so it gets a component of its own
  // rather than a fourth `row.kind ===` on the branch below — the control needs
  // state, and `needBody` is a function rather than a component.
  if (row.kind === 'watch') {
    const task = (view.state.humanTasks ?? []).find((t) => t.id === row.id);
    if (!task) return null;
    return <WatchFinding task={task} view={view} actions={actions} />;
  }
  // A burn notice answers the same two ways as a bench row — done, or declined
  // with a reason — because that is all it ever asks for: it holds nothing, and
  // the run it names carries on either way. What differs is only where the
  // operator goes next, and the row's own agent id is what says that.
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
            look={{ family: 'console' }}
            noteOnDone={noteOwedOnDone(task, view)}
            onDone={(id, note) => actions.completeHumanTask(id, note)}
            onDecline={(id, note) => actions.declineHumanTask(id, note)}
            onCloseTicket={closeTicketFor(task, view) ? (id, note) => actions.closeHumanTaskTicket(id, note) : null}
          />
        </div>
      </>
    );
  }
  // The goal appraisal's refusal (#158). It was drawn only as a call-out on the
  // tickets tab, which is a page an operator opens to groom the backlog rather
  // than to find out what is waiting on them — so the one verdict that stops a
  // goal's pickup outright was the one ask the queue never mentioned.
  //
  // The appraiser's sentence is quoted **whole**, and never reworded: it is the only
  // account of why this goal is held, so a paraphrase would be the only account
  // there is, and wrong.
  if (row.kind === 'intake') {
    const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
    const appraisal = issue?.appraisal;
    // The verdict cleared, or the goal was dropped from the watch tag, between the
    // snapshot this row was derived from and this draw. Either way nothing is held
    // any more, and a band offering an override for a hold that is gone would
    // change a verdict nobody is waiting on.
    if (!issue || appraisal?.verdict !== 'unclear') return null;
    return (
      <>
        <p>
          <strong>The goal appraisal could not say this is workable</strong> — nothing is dispatched for it until the
          verdict moves.
        </p>
        <p className="cn-tick">“{appraisal.summary}”</p>
        <p className="cn-tick">
          The hold clears by itself when the goal&rsquo;s own text changes, so sharpening the ticket is the other answer
          and costs no click here. Overriding says the brief is good enough as it stands.
        </p>
        <div className="cn-acts">
          <AsyncButton
            tone="primary"
            family="console"
            onClick={() => actions.setIssueAppraisal(issue.number, 'workable')}
            title="Work it anyway — the harness stops holding pickup and runs a cycle now"
          >
            Override → workable
          </AsyncButton>
        </div>
      </>
    );
  }
  // The goal-profile gate (#342). Its two buttons are the whole of it, and both
  // go through the same write: the pin is re-affirmed and the question settled in
  // one act, so "keep mine" leaves the tag deliberately disagreeing with the
  // appraiser rather than re-readable as an unanswered disagreement for ever.
  //
  // Drawn here rather than on the goal page, though the goal page is where it is
  // usually read: the page draws its own rows through this same band, so one arm
  // serves both it and the rail's panel. A second copy on the page is a second
  // set of buttons to keep in step with the write.
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
            family="console"
            onClick={() => actions.setIssueProfile(issue.number, proposed)}
            title={`Pin this goal to “${proposed}” and let the funnel move`}
          >
            Use “{proposed}”
          </AsyncButton>
          <AsyncButton
            family="console"
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
  // Where a goal belongs on the backlog. Three answers rather than the profile
  // gate's two, and the third is what the shape needs: this holds nothing, so
  // without an explicit "it wants none" a goal that legitimately has no parent
  // would sit here for ever. The other two gates get their third answer free by
  // blocking — somebody has to clear them.
  //
  // Drawn here rather than on the goal page for the profile gate's reason: the
  // page draws its own rows through this same band, so one arm serves the page,
  // the rail's panel and the console.
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
  // A usage-limit park (issue #318). The row's id *is* the agent, because there is
  // no escalation under it: nothing was asked, so the only verdict is "the limit has
  // cleared, carry on" — and the transcript, which is where an operator decides
  // whether it is worth carrying on at all.
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
          <AsyncButton
            tone="primary"
            family="console"
            onClick={() => actions.resumeAgent(agent.id)}
            pendingLabel="Resuming…"
          >
            Resume
          </AsyncButton>
          <Button family="console" onClick={() => actions.select(agent.id)}>
            Open transcript
          </Button>
        </div>
      </>
    );
  }
  // A dispatch the executor keeps refusing. There is no control here and there
  // must not be one: what is in the way is outside the harness in both cases the
  // worktree pool raises — a checkout of the operator's own standing on the
  // branch, or a cap that has to come down — and a button that could not perform
  // either would be the dead end this cockpit's rules exist to prevent.
  //
  // The refusal is drawn **verbatim**. It is the harness's own prose, written to
  // be read here: it names the branch, the path, why the lease cannot be taken
  // and what clears it, and every attempt to summarise it on the way through has
  // to be re-made the next time the pool learns a new way to refuse.
  // A pull request a person put on you. Nothing here is answerable *in the
  // cockpit* — there is no verdict to record and no act to authorise, because the
  // harness has no part in this one — so the band's whole job is to say what it is
  // and offer the way there. The `<Ref>` is that way, and it is why this kind gets
  // a branch of its own rather than falling through to the escalation lookup,
  // which would find nothing and draw an empty band: a row that opens onto
  // nothing is indistinguishable, to an operator, from a console that is broken.
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
      onAnswer={(text) => actions.answerEscalation(escalation.id, text)}
      onAnswerQuestions={(answers) => actions.answerQuestions(escalation.id, answers)}
      onDecide={(id, verdict, note, acknowledged) => actions.decideProposal(id, verdict, note, acknowledged)}
      onBackOut={(id, verdict, note) => actions.backOutProposal(id, verdict, note)}
      onCommentDraft={(id) => actions.proposalCommentDraft(id)}
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

/**
 * What a post-deploy watch found, and the one thing an operator can do about it
 * that costs the fleet anything.
 *
 * **The bug is a click, and it is the whole bound on this subsystem.** Nothing
 * under `src/dispatcher/` may read a watch, so no reading dispatches an agent;
 * the route from a number to new work is here, and it is a person deciding that
 * the number means something. Arms A and B of a shortfall are put to a person
 * before they happen because they spend a fleet, and a watch that filed its own
 * bugs would be the same loop with a log spike as its trigger and nothing on the
 * outside of it.
 *
 * **The reading rides as the operator's own report.** The modal opens holding the
 * row's own detail — the check, what it expected and what it read — so the fleet
 * is handed the numbers rather than a paraphrase, and it is still editable,
 * because what is filed has to be what the operator actually says. The relation
 * back to the goal is a field on `IssueCreateInput` and never a sentence in a
 * prompt, which is the existing filing path's own rule and why this reuses it
 * rather than filing anything itself. → `src/bugFiling.ts`
 *
 * The control is drawn only where there is a tracker to file into and a goal to
 * relate the bug back to. A false draws no button rather than a disabled one: the
 * row's other two verdicts still answer it, and a control that cannot work
 * teaches nothing.
 */
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
          look={{ family: 'console' }}
          noteOnDone={null}
          onDone={(id, note) => actions.completeHumanTask(id, note)}
          onDecline={(id, note) => actions.declineHumanTask(id, note)}
          onCloseTicket={null}
        />
        {canRaise && (
          <Button
            family="console"
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

/**
 * The parent question: take the appraisal's container, pick another, or say this goal
 * wants none.
 *
 * The prose is this band's; the three answers are {@link ParentPicker}'s, shared
 * with the goal page's orphan warning — the same write to the same field, put in
 * two places, and one implementation of it.
 *
 * The proposed container is drawn as a `<Ref>` **beside** the buttons and never
 * inside one, which is the rule and here also the point: verifying the suggestion
 * has to be as cheap as accepting it. The row draws the title where the harness
 * can see it, so the common case needs no click at all to judge.
 */
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
  const container = proposed === null ? undefined : view.state.world.issues.find((i) => i.number === proposed);
  return (
    <>
      {proposed === null ? (
        /* No suggestion, and the band still draws: the row is the item hanging off
           nothing, and returning null here for want of a proposal was a row that
           opened onto an empty band — indistinguishable, to an operator, from a
           cockpit that is broken. `ParentPicker` leads with its own list when it
           has no first choice to compare against. */
        <p>
          <strong>This goal rolls up to nothing.</strong> Nothing has been suggested for it.
        </p>
      ) : (
        <p>
          <strong>This goal rolls up to nothing.</strong> The appraisal suggests{' '}
          {container ? `“${container.title}”` : `work item #${proposed}`}.
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

/**
 * The area-path question, in {@link ParentAsk}'s three answers.
 *
 * The alternatives come from `config.areaPaths` — the tracker's own tree, read by
 * the harness — and never from a text box, for the reason the appraiser is offered
 * them: a path has to match a node exactly, and a near-miss is refused by the
 * provider and visibly wrong to nobody before then. An empty list is a deployment
 * whose tree the harness could not read, and then the proposal stands alone with
 * no alternative offered, which is honest rather than broken.
 */
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
          family="console"
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
              family="console"
              disabled={chosen === ''}
              onClick={() => actions.setIssueAreaPath(issue.number, chosen)}
              title="File this goal under the area you picked"
            >
              Use that one
            </AsyncButton>
          </>
        )}
        <AsyncButton
          family="console"
          onClick={() => actions.setIssueAreaPath(issue.number, null)}
          title="This goal wants no area path — stop asking"
        >
          Not applicable
        </AsyncButton>
      </div>
    </>
  );
}
