import type { CSSProperties, JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { Ref } from '../components/refs.js';
import { oneLine } from '../view/needLines.js';
import { notesOf, reviewerAsks, reviewerGroups, type ReviewerGroup } from '../view/reviewersPage.js';
import { assignGroupLine } from '../view/askGroups.js';
import { ShortlistButtons, useTicks } from './assignAsks.js';
import { KIND_TONE } from '../view/askKinds.js';

// → docs/spec/17-cockpit.md#every-reviewer-ask-is-one-page

export function ReviewersPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const asks = reviewerAsks(view.needsYou, view.state);
  if (asks.length === 0) return <p className="muted">No pull request is waiting on a reviewer.</p>;
  const groups = reviewerGroups(asks, view.state);
  return (
    <section className="cn-rv">
      <header>
        <h2>{assignGroupLine(asks.length)}</h2>
        <p className="muted">
          The fleet is done with these and nobody is on them. A stack is usually best read by one person, so each stack
          can be answered once.
        </p>
      </header>
      {groups.map((group) => (
        <GroupCard key={group.stack ?? 'unstacked'} group={group} actions={actions} />
      ))}
    </section>
  );
}

function GroupCard({ group, actions }: { group: ReviewerGroup; actions: CockpitActions }): JSX.Element {
  const asks = group.rungs.map((r) => r.ask);
  const { skipped, ticked, toggle, each } = useTicks(asks);
  const whole = group.stack !== null && asks.length > 1;
  const none = ticked.length === 0;
  return (
    <div className={`cn-needs-group cn-rv-group cn-t-${KIND_TONE.assign}`}>
      <header>
        <span className="cn-needs-kind">{group.stack === null ? 'Not stacked' : 'Stack'}</span>
        {group.goal !== null && (
          <span className="cn-refs">
            <Ref to={group.goal} />
          </span>
        )}
      </header>
      <ul>
        {group.rungs.map(({ ask, depth, goal, people }) => (
          <li key={ask.number}>
            <div className="cn-rv-pr">
              {whole && (
                <input
                  type="checkbox"
                  id={`rv-pick-${ask.number}`}
                  checked={!skipped.has(ask.number)}
                  onChange={() => toggle(ask.number)}
                  aria-label={`Include pull request ${ask.number}`}
                />
              )}
              {depth > 0 && (
                <span className="cn-stack-tie" aria-hidden="true" style={{ '--cn-depth': depth - 1 } as CSSProperties}>
                  └
                </span>
              )}
              <span className="cn-refs">
                <Ref to={`pr:${ask.number}`} />
                {goal !== null && <Ref to={goal} />}
              </span>
              {whole ? (
                <label htmlFor={`rv-pick-${ask.number}`} className="cn-grow">
                  {oneLine(ask.title)}
                </label>
              ) : (
                <span className="cn-grow">{oneLine(ask.title)}</span>
              )}
            </div>
            <div className="cn-rv-do">
              <ShortlistButtons
                people={ask.assignAsk}
                notes={notesOf(people)}
                search={actions.searchAssignees}
                onPick={(person) => actions.assignPr(ask.number, person.id, person.name)}
                onDecline={() => actions.declineAssignPr(ask.number)}
              />
            </div>
          </li>
        ))}
      </ul>
      {whole && (
        <div className="cn-needs-group-do">
          <span className="cn-needs-group-lead">
            {none ? 'Tick one to answer' : `Whole stack — ${ticked.length} to`}
          </span>
          <ShortlistButtons
            people={group.people.map((s) => s.person)}
            notes={notesOf(group.people)}
            disabled={none}
            search={actions.searchAssignees}
            onPick={(person) => each((n) => actions.assignPr(n, person.id, person.name))}
            onDecline={() => each((n) => actions.declineAssignPr(n))}
          />
        </div>
      )}
    </div>
  );
}
