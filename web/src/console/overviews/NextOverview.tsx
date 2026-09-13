import type { JSX } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../../view/viewModel.js';
import type { CockpitActions } from '../../cockpit/actions.js';
import { Ref } from '../../components/refs.js';
import { relTime } from '../../components/util.js';
import { Button } from '../../components/button.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, holdingLabel, subjectLabel } from '../QueueRail.js';
import { needBody } from '../NeedsBand.js';
import { OverviewSwitch } from './OverviewSwitch.js';
import { byWeight, partsHeld } from './asks.js';

// → docs/spec/17-cockpit.md#the-overview

/**
 * Shape D — one at a time. The overview draws the single ask holding the most
 * work and nothing else; answering it advances to the next. It is the furthest
 * the idea goes and almost certainly too little for an operator who also wants to
 * *watch* — but it is the right surface to arrive at from a notification, where
 * somebody came to answer one specific thing and everything else is noise.
 *
 * Skipping is local state and deliberately so: it is a cursor through this
 * sitting, not a place. A reload starts again at the top, which is the correct
 * behaviour for a queue whose order the server decides.
 */
export function NextOverview({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const rows = [...view.needsYou].sort(byWeight);
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const live = rows.filter((r) => !skipped.includes(r.id));
  const row = live[0];
  const held = partsHeld(rows);
  const answered = rows.length - live.length;

  if (row === undefined) {
    return (
      <div className="cn-ov-next">
        <OverviewSwitch shape="next" actions={actions} />
        <div className="cn-ov-next-clear">
          <h2>Nothing needs you.</h2>
          <p>
            {view.live.length} {view.live.length === 1 ? 'agent is' : 'agents are'} working. The next thing that wants
            an answer will land here.
          </p>
          {skipped.length > 0 && (
            <Button tone="secondary" onClick={() => setSkipped([])}>
              Bring back {skipped.length} skipped
            </Button>
          )}
        </div>
      </div>
    );
  }

  const body = needBody(row, view, actions);
  const subject = subjectLabel(row);

  return (
    <div className="cn-ov-next">
      <OverviewSwitch shape="next" actions={actions} />

      <div className={`cn-ov-next-card cn-t-${KIND_TONE[row.kind]}`}>
        <div className="cn-ov-next-progress">
          <span className="cn-ov-pips" aria-hidden="true">
            {rows.map((r) => (
              <i
                key={r.id}
                className={`cn-ov-pip ${r.id === row.id ? 'cn-ov-pip-here' : skipped.includes(r.id) ? 'cn-ov-pip-done' : ''}`}
              />
            ))}
          </span>
          <span>
            {rows.length - live.length + 1} of {rows.length}
            {answered > 0 && ` · ${answered} set aside in this sitting`}
          </span>
        </div>

        <h2 className="cn-ov-next-title">
          <span className="cn-sym" aria-hidden="true">
            {KIND_SYMBOL[row.kind]}
          </span>
          {row.title}
        </h2>

        <div className="cn-ov-next-meta">
          <span className="cn-ov-ask-kind">{KIND_LABEL[row.kind]}</span>
          {subject !== null && <span className="cn-ov-ask-subject">{subject}</span>}
          {row.goalRef !== null && <Ref to={row.goalRef} />}
          {row.originRef !== null && row.originRef !== row.goalRef && <Ref to={row.originRef} />}
          {row.raisedAt !== '' && <span className="cn-ov-ask-age">{relTime(row.raisedAt, view.now)}</span>}
        </div>

        {row.holding > 0 && (
          <p className="cn-ov-next-cost">
            <b>{holdingLabel(row.holding)}</b> waiting on this answer.
          </p>
        )}

        {row.note !== undefined && <p className="cn-ov-ask-note">{row.note}</p>}

        <div className="cn-ov-next-body">{body}</div>

        <footer className="cn-ov-next-foot">
          <Button tone="secondary" ghost onClick={() => setSkipped([...skipped, row.id])}>
            Skip for now
          </Button>
          <span className="cn-ov-next-rest">
            {live.length - 1 === 0
              ? 'last one'
              : `${live.length - 1} more · ${held} ${held === 1 ? 'part' : 'parts'} held in total`}
          </span>
        </footer>
      </div>
    </div>
  );
}
