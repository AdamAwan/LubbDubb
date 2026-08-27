import type { JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Issue } from '../types.js';
import { Ref } from '../components/refs.js';
import { ParentPicker } from '../components/ParentPicker.js';
import { relTime } from '../components/util.js';
import { orphanGoal } from '../view/orphanGoal.js';

/**
 * The goal has no parent Feature, said where it cannot be walked past.
 *
 * ## Where it sits, and why up there
 *
 * Between the header and the track strip — above every card on the page, in the
 * one place the eye lands before it reads anything else. The needs rail already
 * carried a version of this and it is the surface an operator reaches *after*
 * they have decided something is worth looking at; a goal that rolls up to
 * nothing is a thing to be told, not a thing to go and find.
 *
 * ## Amber, not red
 *
 * Nothing is broken and nothing is held: the work dispatches, merges and closes
 * either way, which is exactly why nothing catches it. Red is the cockpit's word
 * for a fault and this is a gap in the filing — spending the stronger colour here
 * would devalue it everywhere it means a failure.
 *
 * ## Two weights, one fact
 *
 * A goal nobody has ruled on gets the full band and the three answers. One the
 * operator answered — "this goal wants none" — goes grey and one line tall
 * (`OrphanGoal.settledAt`): the item is still an orphan and the board still
 * cannot roll it up, so the reading does not go away, but it has stopped being an
 * ask and nagging at a decision somebody made is how a warning gets ignored. The
 * way back is left open, because the answer can be wrong.
 *
 * Null when the goal has a parent, when the provider tracks no hierarchy, or when
 * the feature board is off — every condition is {@link orphanGoal}'s, asked once.
 */
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
        /* The suggestion is a `<Ref>` beside the button that accepts it and never
           inside one: checking it has to be as cheap as taking it. */
        <p>
          The appraiser suggested
          <span className="cn-refs">
            <Ref to={`issue:${orphan.proposed}`} title="Open the suggested parent and check it before you accept it" />
          </span>
        </p>
      )}
      <ParentPicker issue={issue} proposed={orphan.proposed} view={view} actions={actions} />
    </div>
  );
}
