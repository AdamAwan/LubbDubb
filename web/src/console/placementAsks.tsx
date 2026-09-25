import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { Issue } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { goalIssue } from '../view/goalRefs.js';
import { placementAskOf } from '../view/issueAsks.js';
import { ParentPicker } from '../components/ParentPicker.js';
import { proposedParentTitle } from '../view/orphanGoal.js';
import { Ref } from '../components/refs.js';
import { ButtonRow } from '../components/button.js';

// → docs/spec/17-cockpit.md

export function placementBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const issue = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
  const ask = placementAskOf(row, issue);
  if (!issue || !ask) return null;
  return ask.field === 'parent' ? (
    <ParentAsk issue={issue} proposed={ask.proposedParent} view={view} actions={actions} />
  ) : (
    <AreaPathAsk issue={issue} proposed={ask.proposedAreaPath} view={view} actions={actions} />
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
      <ButtonRow bar>
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
      </ButtonRow>
    </>
  );
}
