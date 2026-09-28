import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { AppState, OpenPullRequest } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Ref } from '../components/refs.js';
import { ButtonRow } from '../components/button.js';

// → docs/spec/17-cockpit.md

type AssignAsk = Required<Pick<OpenPullRequest, 'number' | 'assignAsk'>>;

export function assignAskOf(row: NeedRow, state: AppState): AssignAsk | null {
  if (row.kind !== 'assign') return null;
  const pr = state.world.pullRequests.find((p) => p.number === row.prNumber);
  return pr?.assignAsk === undefined ? null : { number: pr.number, assignAsk: pr.assignAsk };
}

/**
 * Every person on the shortlist and "Nah" are drawn alike, so declining costs no more than
 * picking. → docs/spec/07-pull-requests.md#asking-who-should-look-at-it
 */
export function assignBody(row: NeedRow, view: CockpitView, actions: CockpitActions): ReactNode {
  const ask = assignAskOf(row, view.state);
  if (ask === null) return null;
  return (
    <>
      <p className="cn-tick">
        The fleet is done with <Ref to={`pr:${ask.number}`} /> and nobody is on it. Put someone on it in the tracker?
      </p>
      <ButtonRow bar>
        <AssignButtons ask={ask} actions={actions} />
      </ButtonRow>
    </>
  );
}

export function AssignButtons({ ask, actions }: { ask: AssignAsk; actions: CockpitActions }): JSX.Element {
  const prNumber = ask.number;
  return (
    <>
      {ask.assignAsk.map((person) => (
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
