import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { api } from '../api.js';
import { HOW_SAID, problemHandled, problemPresses, type ErrorProblem, type ProblemPress } from '../view/appErrors.js';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';
import { Ref } from './refs.js';
import { Tag } from './tag.js';

// → docs/spec/39-app-errors.md#on-the-goal, docs/spec/44-needs-you.md#somethings-wrong

/** How the error came to be put on the goal, said first, because a guess and a stack trace are not the same evidence. */
function problemBasis(p: ErrorProblem): string {
  if (p.basis === 'guess') return `agent's guess${p.confidence === null ? '' : ` · ${p.confidence}`}`;
  return p.how.map((how) => HOW_SAID[how]).join(' + ');
}

const PRESS: Record<ProblemPress, { label: string; usage: 'app-error.create' | 'app-error.undo' | 'app-error.close' }> =
  {
    file: { label: 'File bug', usage: 'app-error.create' },
    confirm: { label: 'Yes, file bug', usage: 'app-error.create' },
    reopen: { label: 'Reopen', usage: 'app-error.undo' },
    'file-anyway': { label: 'File bug anyway', usage: 'app-error.create' },
    'not-it': { label: 'Not it', usage: 'app-error.close' },
  };

async function press(p: ErrorProblem, which: ProblemPress): Promise<void> {
  if (which === 'not-it') await api.dismissAppErrorGoal(p.key, p.goalRef);
  else if (which === 'reopen') await api.reopenAppErrorTicket(p.key);
  else
    await api.fileAppErrorBug(p.environment, p.fingerprint, {
      investigate: false,
      unsearched: which === 'file-anyway',
      confirmGuess: p.basis === 'guess',
    });
}

function problemClass(p: ErrorProblem, compact: boolean): string {
  const parts = ['cn-prob', compact ? 'cn-prob-row' : 'cn-prob-card'];
  if (p.basis === 'guess') parts.push('cn-prob-guess');
  if (problemHandled(p)) parts.push('cn-prob-done');
  return parts.join(' ');
}

function ProblemWhat({ problem, compact }: { problem: ErrorProblem; compact: boolean }): JSX.Element {
  const guess = problem.basis === 'guess';
  return (
    <span className="cn-prob-what">
      <span className="cn-prob-title">{problem.title}</span>
      <span className="cn-prob-count">
        {problem.count}× {problem.state}
        {compact && ` on ${problem.environment}`}
      </span>
      {!compact && (
        <span className="cn-refs cn-prob-goal">
          {guess ? 'Guessed goal' : 'Goal'} <Ref to={problem.goalRef} />
        </span>
      )}
      {guess && !problemHandled(problem) && problem.reason !== null && (
        <span className="cn-prob-reason">
          <b>Is this goal the cause?</b> {problem.reason}
        </span>
      )}
    </span>
  );
}

function ProblemPresses({ problem, onPressed }: { problem: ErrorProblem; onPressed: () => void }): JSX.Element {
  const ticket = problemHandled(problem) ? (problem.tracker?.ticketRef ?? null) : null;
  return (
    <>
      {ticket !== null && (
        <span className="cn-refs">
          Bug <Ref to={ticket} /> open
        </span>
      )}
      {problemPresses(problem).map((which) => (
        <AsyncButton
          key={which}
          usage={PRESS[which].usage}
          tone={which === 'file' || which === 'confirm' ? 'primary' : undefined}
          ghost={which === 'not-it'}
          size="small"
          onClick={async () => {
            await press(problem, which);
            onPressed();
          }}
        >
          {PRESS[which].label}
        </AsyncButton>
      ))}
    </>
  );
}

/**
 * One error put on a goal: on the goal's strip (`compact`) or as a card in Needs you. A handled one says
 * which bug has it and offers nothing.
 */
export function ErrorProblemItem({
  problem,
  compact,
  onPressed,
  actions,
}: {
  problem: ErrorProblem;
  compact: boolean;
  onPressed: () => void;
  actions: CockpitActions;
}): JSX.Element {
  const handled = problemHandled(problem);
  return (
    <div className={problemClass(problem, compact)}>
      <span className="cn-prob-tags">
        <Tag tone={handled ? 'grey' : problem.basis === 'guess' ? 'amber' : 'red'} lower>
          {handled ? 'handled' : problemBasis(problem)}
        </Tag>
        {!compact && <span className="cn-prob-where">{problem.environment}</span>}
      </span>
      <ProblemWhat problem={problem} compact={compact} />
      <span className="cn-prob-acts">
        <ProblemPresses problem={problem} onPressed={onPressed} />
        {!compact && (
          <Button
            ghost
            size="small"
            usage={{ counted: 'app-error.view' }}
            onClick={() => actions.openErrors({ errorsBand: problem.band, errorsShow: 'all', errorsText: problem.key })}
          >
            Open errors
          </Button>
        )}
      </span>
    </div>
  );
}
