import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Issue } from '../types.js';
import { Ref } from '../components/refs.js';
import { ParentPicker } from '../components/ParentPicker.js';
import { relTime } from '../components/util.js';
import { orphanGoal, proposedParentTitle } from '../view/orphanGoal.js';

// → docs/spec/17-cockpit.md

export function OrphanBand({
  issue,
  view,
  actions,
}: {
  issue: Issue;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const orphan = orphanGoal(view.state, issue);
  if (orphan === null) return null;
  const proposedTitle = proposedParentTitle(view.state, orphan.proposed);

  if (orphan.settledAt !== null) {
    return (
      <div className="cn-orphan cn-orphan-quiet">
        <div className="cn-orphan-head">
          <span className="cn-orphan-mark" aria-hidden="true">
            ▪
          </span>
          <span className="cn-orphan-title">
            No parent Feature — you said this goal wants none, {relTime(orphan.settledAt, view.now)}
          </span>
        </div>
        <p>It still rolls up to nothing on the board.</p>
        <ParentPicker issue={issue} proposed={orphan.proposed} view={view} actions={actions} />
      </div>
    );
  }

  return (
    <div className="cn-orphan">
      <div className="cn-orphan-head">
        <span className="cn-orphan-mark" aria-hidden="true">
          ▲
        </span>
        <span className="cn-orphan-title">No parent Feature</span>
      </div>
      <p>
        This goal hangs off nothing. Its work will merge and close, and the backlog will never show it — it rolls up to
        no Feature, and it is on no team’s board.
      </p>
      {orphan.proposed === null ? (
        <p>Nothing has been suggested for it.</p>
      ) : (
        <p>
          The appraiser suggested {proposedTitle === null ? `work item #${orphan.proposed}` : `“${proposedTitle}”`}.
          <span className="cn-refs">
            <Ref to={`issue:${orphan.proposed}`} title="Open the suggested parent and check it before you accept it" />
          </span>
        </p>
      )}
      <ParentPicker issue={issue} proposed={orphan.proposed} view={view} actions={actions} />
    </div>
  );
}
