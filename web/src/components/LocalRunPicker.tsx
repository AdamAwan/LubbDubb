import { useState, type JSX } from 'react';
import type { Issue, LocalRunRefFacts, LocalRunTargetView, LocalRunView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { Tag } from './tag.js';
import { RefSummary, summaryClick } from './LocalRunReadings.js';

// → docs/spec/17-cockpit.md

interface Pick {
  issueNumber: number;
  ref?: string;
}

/* The picker, folded while something is up. Rows rather than a `select`: what
   a row has to say does not fit in an option's label, and a choice you cannot
   see is what this panel got wrong first. */
export function GoalPicker({
  run,
  live,
  goals,
  targets,
  now,
  onStart,
}: {
  run: LocalRunView | null;
  live: boolean;
  goals: Issue[];
  targets: LocalRunTargetView[];
  now: number;
  onStart: (issueNumber: number, ref?: string) => Promise<unknown> | unknown;
}): JSX.Element {
  const [picked, setPicked] = useState<Pick | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [pickerOpen, setPickerOpen] = useState<boolean | null>(null);

  const byNumber = new Map(targets.map((t) => [t.issueNumber, t]));
  const candidates = goals.flatMap((goal) => {
    const target = byNumber.get(goal.number);
    return target === undefined ? [] : [{ goal, target }];
  });
  const rows = showAll ? candidates : candidates.filter((row) => row.target.runnable);
  const holdingBack = candidates.length - rows.length;
  const chosenFacts = factsOf(picked, byNumber);
  const runningOrigin = live && run !== null ? run.originRef : null;
  const open = pickerOpen ?? !live;

  return (
    <details className="lrun-fold lrun-pick" open={open} onClick={(e) => summaryClick(e, () => setPickerOpen(!open))}>
      <summary>
        <span>{live ? 'Run a different goal' : 'Run a goal'}</span>
        {live && <span className="lrun-fold-hint">stops what is running now</span>}
      </summary>
      <div className="lrun-pick-body">
        {(holdingBack > 0 || showAll) && (
          <label className="lrun-filter">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            show every goal
          </label>
        )}

        {rows.length === 0 && <p className="lrun-note">{emptyPickerNote(holdingBack, goals.length)}</p>}

        {rows.map(({ goal, target }) => (
          <GoalRow
            key={goal.number}
            goal={goal}
            target={target}
            now={now}
            running={runningOrigin === target.originRef}
            picked={picked?.issueNumber === goal.number ? picked : null}
            expanded={expanded === goal.number}
            onPick={(ref) =>
              setPicked(ref === undefined ? { issueNumber: goal.number } : { issueNumber: goal.number, ref })
            }
            onExpand={() => setExpanded(expanded === goal.number ? null : goal.number)}
          />
        ))}

        {/* The Start button appears with a choice, not before it: a disabled "Pick a
            goal" is a control that cannot be used, standing where the instruction
            should be. The rows are the instruction. */}
        {picked !== null && chosenFacts !== null && (
          <div className="lrun-go">
            <AsyncButton tone="primary" onClick={() => onStart(picked.issueNumber, picked.ref)}>
              {`${live ? 'Swap to' : 'Start'} #${String(picked.issueNumber)}`}
            </AsyncButton>
            {/* The ref, on the button's own line: this is the last chance to see what
                is about to be checked out, and the goal number does not say it. */}
            <code className="lrun-go-ref">{chosenFacts.ref}</code>
          </div>
        )}
      </div>
    </details>
  );
}

function factsOf(picked: Pick | null, byNumber: Map<number, LocalRunTargetView>): LocalRunRefFacts | null {
  const chosen = picked === null ? null : (byNumber.get(picked.issueNumber) ?? null);
  if (chosen === null) return null;
  if (picked?.ref === undefined) return chosen.target;
  return chosen.options.find((o) => o.option.ref === picked.ref)?.facts ?? chosen.target;
}

function emptyPickerNote(holdingBack: number, goalCount: number): string {
  if (holdingBack > 0)
    return `No goal has a branch of its own yet. ${String(holdingBack)} would run the integration branch — tick “show every goal” to pick one.`;
  if (goalCount === 0) return 'The cockpit is not drawing any goals yet, so there is nothing to run.';
  return 'None of these goals has anywhere to run yet.';
}

function GoalRow({
  goal,
  target,
  now,
  running,
  picked,
  expanded,
  onPick,
  onExpand,
}: {
  goal: Issue;
  target: LocalRunTargetView;
  now: number;
  running: boolean;
  picked: Pick | null;
  expanded: boolean;
  onPick: (ref?: string) => void;
  onExpand: () => void;
}): JSX.Element {
  const others = target.options.filter((o) => o.option.ref !== target.target.ref);
  return (
    <div className={`lrun-row${picked !== null ? ' on' : ''}`}>
      <div className="lrun-row-top">
        {/* The row's name is the control; its refs sit beside it. One click
            cannot have two destinations. */}
        <button
          type="button"
          className="lrun-row-pick"
          onClick={() => onPick()}
          aria-pressed={picked !== null && picked.ref === undefined}
        >
          <span className="lrun-row-name">
            #{goal.number} {goal.title}
          </span>
          <RefSummary facts={target.target} now={now} />
        </button>
        <span className="lrun-refs">
          {running && <Tag tone="green">running</Tag>}
          <Ref to={target.originRef} />
          {target.target.pr !== null && <Ref to={`pr:${String(target.target.pr.number)}`} />}
        </span>
      </div>

      {others.length > 0 && (
        <button type="button" className="lrun-more" onClick={onExpand}>
          {expanded ? '▾' : '▸'} run an earlier part ({others.length})
        </button>
      )}
      {expanded &&
        others.map(({ option, facts }) => (
          <div className="lrun-row-top lrun-sub" key={option.ref}>
            <button
              type="button"
              className="lrun-row-pick"
              onClick={() => onPick(option.ref)}
              aria-pressed={picked !== null && picked.ref === option.ref}
            >
              <span className="lrun-row-name">
                {option.part === null
                  ? 'the goal’s own branch'
                  : `part ${String(option.part.seq)} · ${option.part.title}`}
              </span>
              <RefSummary facts={facts} now={now} />
            </button>
            <span className="lrun-refs">{facts.pr !== null && <Ref to={`pr:${String(facts.pr.number)}`} />}</span>
          </div>
        ))}
    </div>
  );
}
