import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { PrPerson } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Ref } from '../components/refs.js';
import { ButtonRow } from '../components/button.js';

// → docs/spec/17-cockpit.md

/**
 * Every person on the shortlist and "Nah" are drawn alike, so declining costs no more than
 * picking. → docs/spec/07-pull-requests.md#asking-who-should-look-at-it
 */
export function assignBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const pr = view.state.world.pullRequests.find((p) => p.number === row.prNumber);
  if (pr?.assignAsk === undefined) return null;
  return (
    <>
      <p className="cn-tick">
        The fleet is done with <Ref to={`pr:${pr.number}`} /> and nobody is on it. Put someone on it in the tracker?
      </p>
      <ButtonRow bar>
        <AssignButtons prNumber={pr.number} people={pr.assignAsk} actions={actions} />
      </ButtonRow>
    </>
  );
}

export function AssignButtons({
  prNumber,
  people,
  actions,
}: {
  prNumber: number;
  people: readonly PrPerson[];
  actions: CockpitActions;
}): JSX.Element {
  return (
    <>
      {people.map((person) => (
        <AsyncButton
          key={person.id}
          size="small"
          onClick={() => actions.assignPr(prNumber, person.id)}
          title={`Assign ${person.name} in the tracker`}
        >
          {person.name}
        </AsyncButton>
      ))}
      <AsyncButton size="small" onClick={() => actions.declineAssignPr(prNumber)} title="Leave it unassigned">
        Nah
      </AsyncButton>
    </>
  );
}
