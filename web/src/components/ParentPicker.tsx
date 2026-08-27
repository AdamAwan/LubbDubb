import type { JSX } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Issue } from '../types.js';
import { AsyncButton } from './AsyncButton.js';

/**
 * The three answers to "what does this goal hang off": take the proposal, pick a
 * container, or say it wants none.
 *
 * One component rather than one per surface, because there are two places the
 * question is put — the needs rail's `placement` band and the goal page's orphan
 * warning — and they are the same write to the same tracker field. Two copies of
 * three buttons is two sets of wording, two disabled rules and two chances for
 * one of them to be wired to nothing, none of which `npm run check` can see.
 *
 * "Choose another" is a select over the containers in the world — the same set
 * `issueContainerTypes` names for every other gate — rather than a free number
 * box: an id typed by hand is the one answer here nobody can check.
 *
 * The proposed container is drawn by the caller, as a `<Ref>` beside these
 * buttons and never inside one. Verifying the suggestion has to be as cheap as
 * accepting it, or the three answers collapse into one rubber stamp.
 */
export function ParentPicker({
  issue,
  proposed,
  view,
  actions,
}: {
  issue: Issue;
  /** The appraiser's suggestion, or null where it named none — then there is nothing to accept. */
  proposed: number | null;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const [chosen, setChosen] = useState<string>('');
  const types = view.state.config.containerTypes.map((t) => t.toLowerCase());
  const options = view.state.world.issues
    .filter((i) => i.number !== issue.number && i.issueType && types.includes(i.issueType.toLowerCase()))
    .sort((a, b) => a.number - b.number);
  return (
    <div className="cn-acts">
      {proposed !== null && (
        <AsyncButton
          className="cn-btn cn-primary"
          onClick={() => actions.setIssueParent(issue.number, proposed)}
          title={`Hang this goal off #${proposed}`}
        >
          Use #{proposed}
        </AsyncButton>
      )}
      {options.length > 0 && (
        <>
          <select
            className="cn-in"
            value={chosen}
            aria-label={proposed === null ? 'A parent for this goal' : 'A different parent'}
            onChange={(e) => setChosen(e.currentTarget.value)}
          >
            {/* The list is the whole offer where nothing was proposed, so it says so:
                "Choose another" beside no first choice names a comparison the
                operator cannot make. */}
            <option value="">{proposed === null ? 'Choose a Feature…' : 'Choose another…'}</option>
            {options.map((o) => (
              <option key={o.number} value={String(o.number)}>
                #{o.number} — {o.title}
              </option>
            ))}
          </select>
          <AsyncButton
            className={`cn-btn ${proposed === null ? 'cn-primary' : ''}`}
            disabled={chosen === ''}
            onClick={() => actions.setIssueParent(issue.number, Number(chosen))}
            title="Hang this goal off the container you picked"
          >
            Use that one
          </AsyncButton>
        </>
      )}
      <AsyncButton
        className="cn-btn"
        onClick={() => actions.setIssueParent(issue.number, null)}
        title="This goal belongs under nothing — stop asking"
      >
        Not applicable
      </AsyncButton>
    </div>
  );
}
