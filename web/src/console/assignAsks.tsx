import { useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import type { AppState, OpenPullRequest } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Ref } from '../components/refs.js';
import { ButtonRow } from '../components/button.js';
import { oneLine } from '../view/needLines.js';
import { KIND_SYMBOL, KIND_TONE } from './QueueRail.js';

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

/**
 * Several assign asks with one shortlist, answered once: every pull request is ticked, and a name
 * or "Nah" is the same write per ticked one that its own row's button makes. Untick one to leave it
 * for its own answer. → docs/spec/17-cockpit.md#the-same-ask-twice-is-one-ask
 */
export function AssignGroup({
  rows,
  view,
  actions,
}: {
  rows: readonly NeedRow[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const asks = rows.flatMap((row) => {
    const ask = assignAskOf(row, view.state);
    return ask === null ? [] : [ask];
  });
  const [first] = asks;
  if (first === undefined) return null;
  const ticked = asks.map((a) => a.number).filter((n) => !skipped.has(n));
  const toggle = (n: number): void =>
    setSkipped((held) => {
      const next = new Set(held);
      if (!next.delete(n)) next.add(n);
      return next;
    });
  const each = (write: (n: number) => Promise<void>) => async (): Promise<void> => {
    await Promise.all(ticked.map(write));
  };
  const none = ticked.length === 0;
  return (
    <div className={`cn-needs-group cn-t-${KIND_TONE.assign}`}>
      <header>
        <span className="cn-sym" aria-hidden="true">
          {KIND_SYMBOL.assign}
        </span>
        <span className="cn-needs-kind">Assign</span>
        <span className="cn-needs-what">{asks.length} pull requests are ready and nobody is on them</span>
      </header>
      <GroupPicks asks={asks} skipped={skipped} toggle={toggle} view={view} />
      <div className="cn-needs-group-do">
        <span className="cn-needs-group-lead">{none ? 'Tick one to answer' : `Assign ${ticked.length} to`}</span>
        {first.assignAsk.map((person) => (
          <AsyncButton
            key={person.id}
            size="small"
            disabled={none}
            onClick={each((n) => actions.assignPr(n, person.id))}
            title={`Assign ${person.name} to every ticked pull request in the tracker`}
          >
            {person.name}
          </AsyncButton>
        ))}
        <AsyncButton
          size="small"
          disabled={none}
          onClick={each((n) => actions.declineAssignPr(n))}
          title="Leave every ticked pull request unassigned"
        >
          Nah
        </AsyncButton>
      </div>
    </div>
  );
}

function GroupPicks({
  asks,
  skipped,
  toggle,
  view,
}: {
  asks: readonly AssignAsk[];
  skipped: ReadonlySet<number>;
  toggle: (n: number) => void;
  view: CockpitView;
}): JSX.Element {
  return (
    <ul>
      {asks.map((ask) => {
        const pr = view.state.world.pullRequests.find((p) => p.number === ask.number);
        return (
          <li key={ask.number}>
            <input
              type="checkbox"
              id={`assign-pick-${ask.number}`}
              checked={!skipped.has(ask.number)}
              onChange={() => toggle(ask.number)}
              aria-label={`Include pull request ${ask.number}`}
            />
            <Ref to={`pr:${ask.number}`} />
            <label htmlFor={`assign-pick-${ask.number}`} className="cn-grow">
              {oneLine(pr?.title)}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
