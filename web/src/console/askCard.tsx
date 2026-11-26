import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import { BareButton, Button, type Destination } from '../components/button.js';
import { Ref } from '../components/refs.js';
import { relTime } from '../components/util.js';
import { KIND_LABEL, KIND_TONE } from '../view/askKinds.js';
import { goalIssue } from '../view/goalRefs.js';
import { openRow } from './queueRailOpens.js';
import { needBody } from './NeedsBand.js';
import { configDestination, KIND_VERB, rowClass, subjectRef } from './QueueRail.js';

function askOpen(row: NeedRow, actions: CockpitActions): Destination | null {
  if (row.check !== undefined) return configDestination(row.check, actions);
  return row.opens === null ? null : openRow(row, actions);
}

/** The ask card's three parts: what it is about, the ask, and a note only where it adds something. */
function askWords(
  row: NeedRow,
  view: CockpitView,
  inGoal: boolean,
): { about: string | null; ask: string; why?: string } {
  const goal = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
  const about = inGoal && goal !== undefined ? null : (goal?.title ?? row.agentLabel);
  const ask = row.summary ?? row.title;
  const note = row.note ?? row.check?.remedy;
  return note === undefined || (about !== null && note.includes(about)) ? { about, ask } : { about, ask, why: note };
}

// → docs/spec/44-needs-you.md#the-ask-card
export function AskCard({
  row,
  view,
  claude,
  expanded,
  onExpand,
  actions,
  inGoal = false,
}: {
  row: NeedRow;
  view: CockpitView;
  claude: ReactNode;
  expanded: boolean;
  onExpand: () => void;
  actions: CockpitActions;
  inGoal?: boolean;
}): JSX.Element {
  const ref = inGoal ? null : askRef(row);
  const { about, ask, why } = askWords(row, view, inGoal);
  const body = expanded ? needBody(row, view, actions) : null;
  const open = body === null ? askOpen(row, actions) : null;
  return (
    <div className={rowClass(row, null, false, `cn-ny-ask cn-plainrefs${expanded ? ' cn-ny-ask-open' : ''}`)}>
      <i className="cn-stripe" />
      <BareButton
        usage={expanded ? 'escalation.close' : 'escalation.expand'}
        className="cn-ny-askfold"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Fold' : 'Open'}: ${about ?? ask}`}
        onClick={onExpand}
      />
      <div className="cn-qin">
        <AskTop row={row} now={view.now} open={expanded} />
        <p className="cn-ny-about">
          <span>{about ?? ask}</span>
          {ref !== null && (
            <span className="cn-refs">
              <Ref to={ref} />
            </span>
          )}
        </p>
        {body === null ? (
          <>
            {about !== null && <p className="cn-ny-body">{ask}</p>}
            {why !== undefined && <p className="cn-ny-why">{why}</p>}
          </>
        ) : (
          <div className="cn-ny-askmore">{body}</div>
        )}
        <span className="cn-ny-acts">
          {claude}
          {open !== null && (
            <Button size="small" usage={open.usage} onClick={open.go}>
              {row.verb ?? KIND_VERB[row.kind]}
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}

function AskTop({ row, now, open }: { row: NeedRow; now: number; open: boolean }): JSX.Element {
  return (
    <div className="cn-ny-asktop">
      <i className={open ? 'fold-caret open' : 'fold-caret'} aria-hidden="true">
        ›
      </i>
      <span className={`cn-ny-kind cn-ink-${KIND_TONE[row.kind]}`}>{KIND_LABEL[row.kind]}</span>
      {row.raisedAt !== '' && <i className="cn-qage">{relTime(row.raisedAt, now)}</i>}
      {row.urgency === 'now' && (
        <i className="cn-ny-nowdot" title="Answer now — the fleet is stopped on this" aria-label="Answer now" />
      )}
    </div>
  );
}

export function askRef(row: NeedRow): string | null {
  return subjectRef(row) ?? (row.prNumber === undefined || row.prNumber === null ? null : `pr:${row.prNumber}`);
}
