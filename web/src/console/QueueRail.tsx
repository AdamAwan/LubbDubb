import { Fragment, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedGroup, NeedKind, NeedRow } from '../view/needsYou.js';
import { relTime } from '../components/util.js';

/** One word per kind, shared with the goal page so a row and the band it opens name the ask the same. */
export const KIND_LABEL: Record<NeedKind, string> = {
  recovery: 'Recovery',
  escalation: 'Escalation',
  permission: 'Permission',
  proposal: 'Plan',
  bench: 'Bench',
  close_out: 'Close-out',
};

// The mockup's two railsub headings, in the order they're drawn — 'blocking'
// above 'yours' per the brief, matching the group's own red/amber urgency.
const GROUP_LABEL: Record<NeedGroup, string> = {
  blocking: 'Blocking',
  yours: 'Yours to do',
};
const GROUP_ORDER: NeedGroup[] = ['blocking', 'yours'];

/** `issue:12` → `#12`; null stays null. There is no per-row goal title to show, only the ref. */
function goalLabel(ref: string | null): string | null {
  return ref === null ? null : ref.replace(/^issue:/, '#');
}

/**
 * What an ask is holding, worded once. The rail row and the band the row opens
 * both state it, and a count read twice in two sentences is a count the reader
 * has to check against itself.
 *
 * @public shared with GoalPage's needs band
 */
export function holdingLabel(holding: number): string {
  return `holding ${holding} ${holding === 1 ? 'part' : 'parts'}`;
}

/**
 * One row. `group === 'blocking'` is the red half of a red/amber split — an agent
 * is parked on this, not merely queued for the operator — so it alone earns the
 * urgent stripe and tag.
 *
 * **Where a click goes is `row.opens`, never `row.goalRef`** — the derivation
 * decides it, because it is the only place that can tell a goal with a page from
 * a ref that merely looks like one. Only the recovery hold opens nothing, and it
 * renders as a `div` rather than a `button` so that every button on this rail
 * leads somewhere.
 */
function Row({ row, now, actions }: { row: NeedRow; now: number; actions: CockpitActions }): JSX.Element {
  const urgent = row.group === 'blocking';
  const goal = goalLabel(row.goalRef);
  const inner = (
    <>
      <i className="cn-stripe" />
      <div className="cn-qin">
        <div className="cn-qkind">
          <i className="cn-tag">{KIND_LABEL[row.kind]}</i>
          {row.raisedAt !== '' && <i className="cn-qage">{relTime(row.raisedAt, now)}</i>}
        </div>
        <p className="cn-qtitle">{row.title}</p>
        <div className="cn-qmeta">
          {row.agentId !== null && <span>{row.agentId}</span>}
          {row.agentId !== null && goal !== null && <span>·</span>}
          {goal !== null && <span>{goal}</span>}
          {row.holding > 0 && <span className="cn-hold">{holdingLabel(row.holding)}</span>}
        </div>
      </div>
    </>
  );

  if (row.opens === null) {
    return <div className={`cn-q ${urgent ? 'cn-urgent' : ''}`}>{inner}</div>;
  }
  const ref = row.goalRef;
  const open =
    row.opens === 'goal' && ref !== null ? () => actions.selectGoal(ref) : () => actions.openPanel({ ask: row.id });
  return (
    <button type="button" className={`cn-q ${urgent ? 'cn-urgent' : ''}`} onClick={open}>
      {inner}
    </button>
  );
}

/**
 * The merged rail: every kind `needsYou` carries, in the order the view model
 * already sorted them — recovery first, blocking before yours, most-holding
 * first, oldest first. This component only groups by `NeedGroup` for the
 * sub-headings; it never re-sorts, so the rail and the derivation stay one
 * reading.
 *
 * Renders even at zero rows (`cn-rail-empty`) — a rail that vanishes when
 * quiet is indistinguishable from one that broke.
 */
export function QueueRail({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const rows = view.needsYou;
  const sections = GROUP_ORDER.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter(
    (s) => s.rows.length > 0,
  );

  return (
    <>
      <div className="cn-rail-head">
        <h2>Needs you</h2>
        {rows.length > 0 && <i className="cn-count">{rows.length}</i>}
      </div>
      <div className="cn-rail-list">
        {rows.length === 0 ? (
          <p className="cn-rail-empty">Nothing is waiting on you</p>
        ) : (
          sections.map((section) => (
            <Fragment key={section.group}>
              <div className="cn-railsub">{GROUP_LABEL[section.group]}</div>
              {section.rows.map((row) => (
                <Row key={row.id} row={row} now={view.now} actions={actions} />
              ))}
            </Fragment>
          ))
        )}
      </div>
    </>
  );
}
