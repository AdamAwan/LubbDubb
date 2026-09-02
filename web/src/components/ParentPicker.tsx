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
 * "Choose another" is a select over `world.parentCandidates` — the containers the
 * harness can see, from the server — rather than a free number box: an id typed by
 * hand is the one answer here nobody can check.
 *
 * **The list comes over the wire and is never re-derived here.** It used to be
 * `world.issues` filtered by `containerTypes`, which is half of `candidateParents`
 * and the half that is almost always empty: an Azure item list is narrowed by tag
 * and assignee, so an open Feature is usually visible only as some *other* item's
 * parent. On the deployments that raise the missing-parent warning at all, that
 * filter therefore matched nothing and the select simply was not drawn — leaving
 * "Not applicable" as the only answer to a warning about filing, which reads as a
 * cockpit that has lost the control rather than one that has nothing to offer
 * (issue #683). The server ships the same list the appraiser's own orphan note is
 * written from.
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
  // Already open, deduplicated and in id order — `candidateParents`' answer, taken
  // whole. The goal itself is dropped: an item cannot be its own container, and it
  // is in the list whenever somebody hung something off it.
  const options = view.state.world.parentCandidates.filter((c) => c.number !== issue.number);
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
