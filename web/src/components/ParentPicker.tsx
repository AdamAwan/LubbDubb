import type { JSX } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Issue } from '../types.js';
import { AsyncButton } from './AsyncButton.js';

// → docs/spec/17-cockpit.md

export function ParentPicker({
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
  const [chosen, setChosen] = useState<string>('');
  const options = view.state.world.parentCandidates.filter((c) => c.number !== issue.number);
  return (
    <div className="cn-acts">
      {proposed !== null && (
        <AsyncButton
          tone="primary"
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
            tone={proposed === null ? 'primary' : undefined}
            disabled={chosen === ''}
            onClick={() => actions.setIssueParent(issue.number, Number(chosen))}
            title="Hang this goal off the container you picked"
          >
            Use that one
          </AsyncButton>
        </>
      )}
      <AsyncButton
        onClick={() => actions.setIssueParent(issue.number, null)}
        title="This goal belongs under nothing — stop asking"
      >
        Not applicable
      </AsyncButton>
    </div>
  );
}
