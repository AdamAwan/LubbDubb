import { Fragment, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedGroup, NeedKind, NeedRow } from '../view/needsYou.js';
import { relTime } from '../components/util.js';
import { refLabel } from '../components/refs.js';

/** One word per kind, shared with the goal page so a row and the band it opens name the ask the same. */
export const KIND_LABEL: Record<NeedKind, string> = {
  recovery: 'Recovery',
  escalation: 'Escalation',
  permission: 'Permission',
  proposal: 'Plan',
  profile: 'Profile',
  bench: 'Bench',
  close_out: 'Close-out',
  burn: 'Spend',
  limit: 'Usage limit',
};

// The mockup's two railsub headings, in the order they're drawn — 'blocking'
// above 'yours' per the brief, matching the group's own red/amber urgency.
const GROUP_LABEL: Record<NeedGroup, string> = {
  blocking: 'Blocking',
  yours: 'Yours to do',
};
const GROUP_ORDER: NeedGroup[] = ['blocking', 'yours'];

/**
 * What a row is about, in one token: its goal (`#12`) when it has one, else the
 * pull request it was raised on (`PR #142`). Null only for an ask with neither,
 * which is the one case a surface has nothing true to name.
 *
 * Through `refLabel`, the one function that shortens a ref: this was written
 * three times over, and the fourth surface that wrote it printed a label with no
 * link attached to it.
 *
 * @public shared with the ask panel, which states the same subject in its header
 */
export function subjectLabel(row: NeedRow): string | null {
  if (row.goalRef !== null) return refLabel(row.goalRef);
  const pr = /^pr:(\d+)/.exec(row.originRef ?? '');
  return pr ? `PR #${pr[1]}` : null;
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
 * `focus` is the goal the situation area is currently drawing, when it is drawing
 * one. A row about that goal is marked `aria-current` and every other row is
 * dimmed, so the rail says which of its asks are the ones on screen — the rest
 * stay legible and clickable, because muting is a reading aid and a rail that
 * hid rows would hide the fleet's other blockers.
 *
 * **Where a click goes is `row.opens`, never `row.goalRef`** — the derivation
 * decides it, because it is the only place that can tell a goal with a page from
 * a ref that merely looks like one. Only the recovery hold opens nothing, and it
 * renders as a `div` rather than a `button` so that every button on this rail
 * leads somewhere.
 */
function Row({
  row,
  now,
  focus,
  actions,
}: {
  row: NeedRow;
  now: number;
  focus: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const urgent = row.group === 'blocking';
  const current = focus !== null && row.goalRef === focus;
  // The recovery hold is never dimmed: while it stands no pulse runs at all, so
  // it is not another goal's business — it is everyone's, including this one's.
  const dim = focus !== null && !current && row.kind !== 'recovery';
  const cls = ['cn-q', urgent ? 'cn-urgent' : '', dim ? 'cn-dim' : ''].filter((c) => c !== '').join(' ');
  const goal = subjectLabel(row);
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
    return <div className={cls}>{inner}</div>;
  }
  const ref = row.goalRef;
  const open =
    row.opens === 'goal' && ref !== null ? () => actions.selectGoal(ref) : () => actions.openPanel({ ask: row.id });
  return (
    <button type="button" className={cls} onClick={open} aria-current={current ? 'true' : undefined}>
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
 *
 * The focus is `goalPage`'s ref rather than `selectedGoal`, because a selected
 * ref the world does not carry draws no page: highlighting against it would mute
 * the whole rail in favour of a goal that is not on screen.
 */
export function QueueRail({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const rows = view.needsYou;
  const focus = view.goalPage === null ? null : `issue:${view.goalPage.issue.number}`;
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
                <Row key={row.id} row={row} now={view.now} focus={focus} actions={actions} />
              ))}
            </Fragment>
          ))
        )}
      </div>
    </>
  );
}
