import { useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Ref } from '../components/refs.js';
import { ButtonRow } from '../components/button.js';
import { oneLine } from '../view/needLines.js';
import { assignAskOf, assignGroupLine, type AssignAsk } from '../view/askGroups.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from './QueueRail.js';

// → docs/spec/17-cockpit.md

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
  return (
    <ShortlistButtons
      people={ask.assignAsk}
      onPick={(id) => actions.assignPr(ask.number, id)}
      onDecline={() => actions.declineAssignPr(ask.number)}
    />
  );
}

function ShortlistButtons({
  people,
  onPick,
  onDecline,
  disabled = false,
}: {
  people: AssignAsk['assignAsk'];
  onPick: (personId: string) => Promise<void>;
  onDecline: () => Promise<void>;
  disabled?: boolean;
}): JSX.Element {
  return (
    <>
      {people.map((person) => (
        <AsyncButton
          key={person.id}
          size="small"
          usage="pr-assignee.accept"
          disabled={disabled}
          onClick={() => onPick(person.id)}
          title={`Assign ${person.name} in the tracker`}
        >
          {person.name}
        </AsyncButton>
      ))}
      <AsyncButton
        size="small"
        usage="pr-assignee.reject"
        disabled={disabled}
        onClick={onDecline}
        title="Leave it unassigned"
      >
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
  asks,
  actions,
}: {
  asks: readonly AssignAsk[];
  actions: CockpitActions;
}): JSX.Element | null {
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const [first] = asks;
  if (first === undefined) return null;
  const ticked = asks.map((a) => a.number).filter((n) => !skipped.has(n));
  const toggle = (n: number): void =>
    setSkipped((held) => {
      const next = new Set(held);
      if (!next.delete(n)) next.add(n);
      return next;
    });
  const each = async (write: (n: number) => Promise<void>): Promise<void> => {
    await Promise.all(ticked.map(write));
  };
  const none = ticked.length === 0;
  return (
    <div className={`cn-needs-group cn-t-${KIND_TONE.assign}`}>
      <header>
        <span className="cn-sym" aria-hidden="true">
          {KIND_SYMBOL.assign}
        </span>
        <span className="cn-needs-kind">{KIND_LABEL.assign}</span>
        <span className="cn-needs-what">{assignGroupLine(asks.length)}</span>
      </header>
      <ul>
        {asks.map((ask) => (
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
              {oneLine(ask.title)}
            </label>
          </li>
        ))}
      </ul>
      <div className="cn-needs-group-do">
        <span className="cn-needs-group-lead">{none ? 'Tick one to answer' : `Assign ${ticked.length} to`}</span>
        <ShortlistButtons
          people={first.assignAsk}
          disabled={none}
          onPick={(id) => each((n) => actions.assignPr(n, id))}
          onDecline={() => each((n) => actions.declineAssignPr(n))}
        />
      </div>
    </div>
  );
}
