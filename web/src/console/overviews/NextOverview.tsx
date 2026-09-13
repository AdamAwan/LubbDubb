import type { JSX } from 'react';
import { useState } from 'react';
import type { CockpitView } from '../../view/viewModel.js';
import type { CockpitActions } from '../../cockpit/actions.js';
import type { NeedRow } from '../../view/needsYou.js';
import { Ref } from '../../components/refs.js';
import { buildGoalPage, goalIssue, type GoalPartView, type PartGroup } from '../../view/goalPage.js';
import { relTime } from '../../components/util.js';
import { Button } from '../../components/button.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, holdingLabel, subjectLabel } from '../QueueRail.js';
import { needBody } from '../NeedsBand.js';
import { PICKUP_WORD } from '../Overview.js';
import { OverviewSwitch } from './OverviewSwitch.js';
import { byWeight, partsHeld } from './asks.js';

// → docs/spec/17-cockpit.md#the-overview

/**
 * One ask at a time, under the work it is about.
 *
 * The overview draws the single ask holding the most work; answering it advances
 * to the next. What makes that more than a queue with the queue hidden is the
 * column beside it: an ask read alone is a decision with no stakes attached —
 * "approve this merge" means very little until you can see it is the fourth of
 * five parts and which of them are waiting on it. So the goal, its plan and its
 * other asks sit alongside, off the goal page's own `parts` fold, with the part
 * the ask is about marked in the ask's own tone.
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

        {/* Setting beside the act rather than over it. Stacked, the plan pushed the
            ask itself under the fold on a wide screen — a surface whose whole
            argument is that the thing to do is in front of you, with the thing to
            do scrolled off. They collapse back into one column below 1100px,
            where the height is cheaper than the width. */}
        <div className="cn-ov-next-split">
          <aside className="cn-ov-next-aside">
            <Context row={row} view={view} actions={actions} />
          </aside>

          <div className="cn-ov-next-main">
            <h3 className="cn-ov-ctx-label cn-ov-ask-label">Your move</h3>
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
      </div>
    </div>
  );
}

/**
 * What the ask is about: the goal, how far along it is, and what else on it is
 * waiting on the operator. Absent where the ask belongs to no goal — an upgrade,
 * a config gap, a supply ask — which is said rather than left blank, because a
 * band that silently vanishes reads as one that failed to load.
 *
 * Every region here wears its name. An unlabelled band under an unlabelled track
 * is a row of boxes the reader has to infer the meaning of, and the inference is
 * different for each of them — which is the whole cost this shape was meant to
 * remove.
 */
function Context({ row, view, actions }: { row: NeedRow; view: CockpitView; actions: CockpitActions }): JSX.Element {
  if (row.goalRef === null) {
    return (
      <div className="cn-ov-ctx cn-ov-ctx-wide">
        <h3 className="cn-ov-ctx-label">What this is about</h3>
        <span className="cn-ov-ctx-none">The fleet itself, rather than any one goal.</span>
      </div>
    );
  }

  const issue = goalIssue(view.state, row.goalRef);
  const page = buildGoalPage(view.state, row.goalRef, view.needsYou, null);
  const parts = page?.parts ?? [];
  const siblings = view.needsYou.filter((n) => n.goalRef === row.goalRef && n.id !== row.id).length;
  const merged = parts.filter((p) => p.group === 'merged').length;

  return (
    <div className="cn-ov-ctx">
      <h3 className="cn-ov-ctx-label">The goal this is about</h3>

      <div className="hdr hdr-base">
        <button type="button" className="cn-ov-ctx-name" onClick={() => actions.selectGoal(row.goalRef ?? '')}>
          {issue?.title ?? row.goalRef}
        </button>
        <Ref to={row.goalRef} />
        {issue !== undefined && (
          <span className="cn-ov-ctx-state">{PICKUP_WORD[issue.pickup.status] ?? issue.pickup.status}</span>
        )}
      </div>

      {parts.length > 0 && (
        <>
          <h3 className="cn-ov-ctx-label cn-ov-ctx-label-sub">
            Its plan{' '}
            <span>
              {merged} of {parts.length} merged
            </span>
          </h3>
          <Track parts={parts} about={partOf(row)} />
        </>
      )}

      {siblings > 0 && (
        <p className="cn-ov-ctx-more">
          {siblings} other {siblings === 1 ? 'ask' : 'asks'} on this goal, after this one.
        </p>
      )}
    </div>
  );
}

/**
 * The goal's parts, each named. The count alone drew five identical boxes, which
 * says how many parts there are and nothing about what any of them is — and the
 * part the ask is about is the one the reader is looking for.
 */
function Track({ parts, about }: { parts: readonly GoalPartView[]; about: string | null }): JSX.Element {
  return (
    <ol className="cn-ov-track">
      {parts.map(({ part, group }) => {
        const here = about !== null && part.slug === about;
        return (
          <li
            key={part.id}
            className={`cn-ov-seg cn-ov-seg-${group} ${here ? 'cn-ov-seg-here' : ''}`}
            title={`${part.title} — ${GROUP_WORD[group]}`}
          >
            <b>{part.seq}</b>
            <span className="cn-ov-seg-name">{part.title}</span>
            <span className="cn-ov-seg-state">{here ? 'this ask' : GROUP_WORD[group]}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The part the ask is about, where its origin names one. Marking it is most of
 * what the band is for: the reader is looking for where this decision sits in the
 * work, and five named rows with none of them marked still leaves them counting.
 */
function partOf(row: NeedRow): string | null {
  const m = /^issue:\d+:part:(.+)$/.exec(row.originRef ?? '');
  return m?.[1] ?? null;
}

const GROUP_WORD: Record<PartGroup, string> = {
  merged: 'merged',
  now: 'being worked',
  held: 'held',
  waiting: 'not started',
};
