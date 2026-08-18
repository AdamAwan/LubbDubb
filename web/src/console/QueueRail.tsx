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
  validate: 'Validate',
  burn: 'Spend',
  limit: 'Usage limit',
};

/**
 * The hue a kind wears, and it answers *what the ask is* — not who is stopped.
 *
 * Red is something wrong: a restart that orphaned runs, an agent that hit a
 * question it cannot get past. Amber is a gate rather than a fault — nothing
 * broke, something is simply waiting on a yes, an allowance window or a look at
 * the spend. Blue is informative: a plan, a profile, a piece of work only a
 * person can do, all of which want reading rather than repair. Green is the step
 * *after* a delivery — a goal landed and this is what follows it.
 *
 * **Who is stopped is weight, not hue** (see {@link Row}). The rail used to spend
 * its whole palette on that one bit, which left every ask on the bench reading as
 * an alarm; it is now carried by the solid/soft split within each hue, by the
 * `Blocking` sub-heading and by the sort order — three statements of it, none of
 * them costing the operator the ability to tell a delivered goal from a fault at
 * a glance.
 *
 * Total over {@link NeedKind}, like {@link KIND_LABEL}, so a new kind fails the
 * typecheck here rather than drawing in whatever the last rule in the sheet said.
 *
 * @public shared with the needs band, which dresses the same ask in the same tone
 */
export const KIND_TONE: Record<NeedKind, 'red' | 'amber' | 'blue' | 'green'> = {
  recovery: 'red',
  escalation: 'red',
  permission: 'amber',
  proposal: 'blue',
  profile: 'blue',
  bench: 'blue',
  close_out: 'green',
  validate: 'green',
  burn: 'amber',
  limit: 'amber',
};

/**
 * The glyph drawn before the word, a second reading of the same thing rather
 * than a replacement for it — the tag still spells the kind out, so a symbol
 * nobody has learnt yet costs nothing and needs no legend.
 *
 * Text-presentation BMP glyphs only. A character with an emoji variant (`✔`,
 * `☑`, `🏳`) is rendered by the platform's colour font on some machines and the
 * text font on others, which puts a full-colour sticker in a monospace tag on
 * exactly the operator's machine nobody tested on.
 *
 * @public shared with the needs band and the ask panel, which name the ask the same
 */
export const KIND_SYMBOL: Record<NeedKind, string> = {
  recovery: '\u21ba',
  escalation: '?',
  permission: '\u2298',
  proposal: '\u25c7',
  profile: '\u2299',
  bench: '\u25c6',
  close_out: '\u2691',
  validate: '\u2713',
  burn: '\u25b2',
  limit: '\u2016',
};

// The mockup's two railsub headings, in the order they're drawn — 'blocking'
// above 'yours' per the brief. Since the palette went to `NeedKind`, these two
// words are one of the three places the group is still stated; the others are
// the sort order and each row's own weight.
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
 * One row, wearing two readings at once: **hue is the kind** ({@link KIND_TONE}),
 * **weight is the group**. `group === 'blocking'` means an agent is parked on
 * this rather than merely queued for the operator, and it draws as `cn-parked` —
 * a full-strength stripe and a filled tag, against the softened stripe and
 * outlined tag of a row that is only the operator's to get to.
 *
 * The two are deliberately separate channels. Spending the whole palette on the
 * group is what made every ask on the bench read as an alarm, and a delivered
 * goal's close-out is not an alarm; spending it on the kind alone would drop the
 * one bit the rail is sorted by. Weight carries the second without taking the
 * first.
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
  const parked = row.group === 'blocking';
  const current = focus !== null && row.goalRef === focus;
  // The recovery hold is never dimmed: while it stands no pulse runs at all, so
  // it is not another goal's business — it is everyone's, including this one's.
  const dim = focus !== null && !current && row.kind !== 'recovery';
  const cls = ['cn-q', `cn-t-${KIND_TONE[row.kind]}`, parked ? 'cn-parked' : '', dim ? 'cn-dim' : '']
    .filter((c) => c !== '')
    .join(' ');
  const goal = subjectLabel(row);
  const inner = (
    <>
      <i className="cn-stripe" />
      <div className="cn-qin">
        <div className="cn-qkind">
          <i className="cn-tag">
            {/* Hidden from the reading order on purpose: the word beside it is
                the label, and a screen reader announcing "black diamond bench"
                is worse than one announcing "bench". */}
            <span className="cn-sym" aria-hidden="true">
              {KIND_SYMBOL[row.kind]}
            </span>
            {KIND_LABEL[row.kind]}
          </i>
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
