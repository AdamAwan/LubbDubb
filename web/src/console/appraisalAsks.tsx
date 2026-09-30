import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { Issue } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { ButtonRow } from '../components/button.js';
import { goalIssue } from '../view/goalRefs.js';
import { discussPrompt } from '../cockpit/desktopLink.js';
import { awaitedProfile } from '../view/issueAsks.js';

// → docs/spec/17-cockpit.md

function rowIssue(row: NeedRow, view: CockpitView): Issue | undefined {
  return row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
}

export function intakeBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const issue = rowIssue(row, view);
  const appraisal = issue?.appraisal;
  if (!issue || appraisal?.verdict !== 'unclear') return null;
  return (
    <>
      <p>
        <strong>The goal appraisal could not say this is workable</strong> — nothing is dispatched for it until the
        verdict moves.
      </p>
      <p className="cn-tick">“{appraisal.summary}”</p>
      <Lines items={appraisal.missing} className="cn-tick" />
      <p className="cn-tick">
        The hold clears by itself when the goal&rsquo;s own text changes, so answering those on the ticket is the other
        way out and costs no click here. Overriding says the brief is good enough as it stands.
      </p>
      <ButtonRow bar>
        <AsyncButton
          tone="primary"
          usage="intake.accept"
          onClick={() => actions.setIssueAppraisal(issue.number, 'workable')}
          title="Work it anyway — the harness stops holding pickup and runs a cycle now"
        >
          Override → workable
        </AsyncButton>
        <DesktopLink
          usage="intake.open"
          folder={view.state.config.desktopFolder}
          prompt={discussPrompt(issue.number)}
          explain="so the gaps are talked through with a session that can rewrite the ticket — the hold stands until the goal's text changes or you override it here."
        />
      </ButtonRow>
    </>
  );
}

export function profileBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const issue = rowIssue(row, view);
  const appraisal = issue?.appraisal;
  const proposed = issue === undefined ? null : awaitedProfile(issue);
  if (!issue || !appraisal || proposed === null) return null;
  const { config } = view.state;
  const pinned = issue.modelPin.profile;
  const standing = pinned ?? config.defaultProfile;
  const described = config.profiles.find((p) => p.name === proposed)?.description;
  return (
    <>
      <p>
        <strong>The goal appraisal wants this run on “{proposed}”</strong>
        {standing !== null && ` — ${pinned === null ? 'it would otherwise run on' : 'you pinned it to'} “${standing}”`}
        {standing === null && ' — nothing is pinned to it yet'}
      </p>
      <p className="cn-tick">
        {described ?? appraisal.summary} Nothing is dispatched for this goal until you say which to use — that is one
        click either way, and it is not a rejection.
      </p>
      <ButtonRow bar>
        <AsyncButton
          tone="primary"
          usage="profile.accept"
          onClick={() => actions.setIssueProfile(issue.number, proposed)}
          title={`Pin this goal to “${proposed}” and let the funnel move`}
        >
          Use “{proposed}”
        </AsyncButton>
        <AsyncButton
          usage="profile.reject"
          onClick={() => actions.setIssueProfile(issue.number, pinned)}
          title={
            pinned === null
              ? 'Leave this goal unpinned, so each rule runs on its own profile'
              : `Keep “${pinned}” and let the funnel move`
          }
        >
          {pinned === null ? 'Leave it unpinned' : `Keep “${pinned}”`}
        </AsyncButton>
      </ButtonRow>
    </>
  );
}

export function Lines({ items, className }: { items: readonly string[]; className: string }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul className={className}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
