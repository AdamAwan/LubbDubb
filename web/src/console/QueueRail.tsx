import { Fragment, useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedGroup, NeedKind, NeedRow, NeedUrgency } from '../view/needsYou.js';
import { openGoalForAsk } from './jump.js';
import type { BuildReading, SetupCheck } from '../types.js';
import { relTime } from '../components/util.js';
import { PrLink, Ref, refLabel } from '../components/refs.js';
import { Button } from '../components/button.js';
import { Tag } from '../components/tag.js';
import { CardFoot, ConfigFix, SettledFix, UpdateActs } from './queueRailFoots.js';

// → docs/spec/17-cockpit.md

export const KIND_LABEL: Record<NeedKind, string> = {
  config: 'Config',
  config_gap: 'Config gap',
  recovery: 'Recovery',
  escalation: 'Escalation',
  permission: 'Permission',
  plan: 'Plan',
  reply: 'Reply',
  merge: 'Merge',
  describe: 'Describe',
  description_wrong: 'Description',
  description_note: 'Description note',
  shortfall: 'Shortfall',
  intake: 'Intake',
  sitting: 'Before planning',
  profile: 'Profile',
  placement: 'Backlog',
  bench: 'Bench',
  close_out: 'Close-out',
  outcome: 'Plan verdict',
  validate: 'Run checks',
  validation_plan: 'Checks',
  watch: 'Watch',
  unwatched: 'Unseen stories',
  burn: 'Runaway',
  limit: 'Usage limit',
  supply: 'Runway',
  dispatch: 'Refused',
  assigned: 'Assigned',
  upgrade: 'Upgrade',
  project_pull: 'Auto-pull off',
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
  config: 'red',
  config_gap: 'amber',
  recovery: 'red',
  escalation: 'red',
  permission: 'amber',
  plan: 'blue',
  reply: 'amber',
  merge: 'amber',
  describe: 'blue',
  description_wrong: 'amber',
  description_note: 'blue',
  shortfall: 'blue',
  intake: 'blue',
  sitting: 'blue',
  profile: 'blue',
  placement: 'amber',
  bench: 'blue',
  close_out: 'green',
  outcome: 'blue',
  validate: 'green',
  validation_plan: 'green',
  watch: 'amber',
  unwatched: 'amber',
  burn: 'amber',
  limit: 'amber',
  supply: 'amber',
  dispatch: 'red',
  assigned: 'blue',
  upgrade: 'amber',
  project_pull: 'amber',
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
  config: '\u2699',
  config_gap: '\u2296',
  recovery: '\u21ba',
  escalation: '?',
  permission: '\u2298',
  plan: '\u25c7',
  reply: '\u21b5',
  merge: '\u2295',
  describe: '\u270e',
  description_wrong: '\u2260',
  description_note: '\u00b6',
  shortfall: '\u2717',
  intake: '\u25cc',
  sitting: '\u270d',
  profile: '\u2299',
  placement: '\u25a3',
  bench: '\u25c6',
  close_out: '\u2691',
  outcome: '\u2696',
  validate: '\u2713',
  validation_plan: '\u25c8',
  watch: '\u25ce',
  unwatched: '\u25cb',
  burn: '\u25b2',
  limit: '\u2016',
  supply: '\u25bd',
  dispatch: '\u22a0',
  assigned: '\u2913',
  upgrade: '\u2191',
  project_pull: '\u21a5',
};

/**
 * What the ask wants, as the verb of the press that answers it.
 *
 * The row's own word, never "Open": a page whose asks say *open* and whose panes
 * say *Write the criteria* is a page where the only thing wearing a verb is the
 * thing that is not waiting on anybody. Total over {@link NeedKind}, so a new
 * kind is given one deliberately rather than inheriting a door.
 *
 * It names what happens after the press honestly — the ask opens where it is
 * answered, and an ask that is answered by going somewhere and doing the work
 * says *that*: `validate` is "Run the checks", not "Answer".
 *
 * @public shared with the needs band, which draws the row this labels
 */
export const KIND_VERB: Record<NeedKind, string> = {
  config: 'Fix the config',
  config_gap: 'Fill it in',
  recovery: 'Look',
  escalation: 'Answer',
  permission: 'Allow or deny',
  plan: 'Decide',
  reply: 'Review the draft',
  merge: 'Decide',
  describe: 'Describe it',
  description_wrong: 'Fix it',
  description_note: 'Look',
  shortfall: 'Decide',
  intake: 'Let it in',
  sitting: 'Write them down',
  profile: 'Answer',
  placement: 'Pick a parent',
  bench: 'Do it',
  close_out: 'Close it out',
  outcome: 'Say how it went',
  validate: 'Run the checks',
  validation_plan: 'Decide',
  watch: 'Look',
  unwatched: 'Look',
  burn: 'Look',
  limit: 'Look',
  supply: 'Top it up',
  dispatch: 'Look',
  assigned: 'Look',
  upgrade: 'Upgrade',
  project_pull: 'Turn it on',
};

const GROUP_LABEL: Record<NeedGroup, string> = {
  blocking: 'Blocking',
  yours: 'Yours to do',
};

/**
 * The rail's own headings, which are tiers rather than groups: the operator's
 * question at a glance is *what do I answer first*, and `blocking` / `yours`
 * answers a different one — who is stopped — that each row still carries as its
 * weight. Twenty-four kinds down two headings put a build upgrade beside an
 * agent that cannot proceed.
 */
const URGENCY_LABEL: Record<NeedUrgency, string> = {
  now: 'Answer now',
  next: 'Yours to do',
  later: 'Whenever',
};
const URGENCY_ORDER: NeedUrgency[] = ['now', 'next', 'later'];

const PR_ORIGIN = /^pr:(\d+)(?::|$)/;

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
  const pr = PR_ORIGIN.exec(row.originRef ?? '');
  return pr ? `PR #${pr[1]}` : null;
}

function subjectBeside(row: NeedRow): string | null {
  const subject = subjectLabel(row);
  return subject !== null && row.title.includes(subject) ? null : subject;
}

const UNNAMED_RUN = 'a run with no task on record';

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

function KindTag({ kind }: { kind: NeedKind }): JSX.Element {
  return (
    <Tag>
      {/* Hidden from the reading order on purpose: the word beside it is
            the label, and a screen reader announcing "black diamond bench"
            is worse than one announcing "bench". */}
      <span className="cn-sym" aria-hidden="true">
        {KIND_SYMBOL[kind]}
      </span>
      {KIND_LABEL[kind]}
    </Tag>
  );
}

function RowBody({ row, now }: { row: NeedRow; now: number }): JSX.Element {
  const goal = subjectBeside(row);
  return (
    <>
      <div className="cn-qkind">
        <KindTag kind={row.kind} />
        {/* The card leaves the cockpit, so it says so where a token would: the
            same arrow the vocabulary's arm carries, and `aria-hidden` because the
            anchor around it already announces where it goes. */}
        {row.opens === 'provider' && (
          <i className="cn-qout" aria-hidden="true">
            ↗
          </i>
        )}
        {row.raisedAt !== '' && <i className="cn-qage">{relTime(row.raisedAt, now)}</i>}
      </div>
      <p className="cn-qtitle">{row.title}</p>
      <div className="cn-qmeta">
        {row.note !== undefined && <span>{row.note}</span>}
        {row.note !== undefined && (row.agentId !== null || goal !== null) && <span>·</span>}
        {row.agentId !== null && <span>{row.agentLabel ?? UNNAMED_RUN}</span>}
        {row.agentId !== null && goal !== null && <span>·</span>}
        {goal !== null && <span>{goal}</span>}
        {row.holding > 0 && <span className="cn-hold">{holdingLabel(row.holding)}</span>}
        {/* The group's third statement, which used to be the section heading the
            tier now owns: the weight and the sort say who is stopped, and a
            reading carried only by opacity is one an operator has to have been
            told about. Drawn on the parked rows alone — the word on every row
            says nothing. */}
        {row.group === 'blocking' && <span className="cn-blk">{GROUP_LABEL[row.group]}</span>}
      </div>
    </>
  );
}

function Card({
  cls,
  current,
  onClick,
  foot,
  children,
}: {
  cls: string;
  current: boolean;
  onClick: () => void;
  foot: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cls}>
      <i className="cn-stripe" />
      <button type="button" className="cn-qbody" onClick={onClick} aria-current={current ? 'true' : undefined}>
        <div className="cn-qin">{children}</div>
      </button>
      {foot !== null && (
        <>
          <i className="cn-stripe" />
          {foot}
        </>
      )}
    </div>
  );
}

function ConfigRow({
  row,
  check,
  cls,
  current,
  actions,
}: {
  row: NeedRow;
  check: SetupCheck;
  cls: string;
  current: boolean;
  actions: CockpitActions;
}): JSX.Element {
  const fix = check.fix;
  const group = fix?.kind === 'config' ? fix.group : fix?.kind === 'goto' ? fix.group : undefined;
  return (
    <Card
      cls={cls}
      current={current}
      onClick={() => actions.openConfig({ configTab: 'values', configGroup: group ?? null })}
      foot={
        row.applied === undefined ? (
          <ConfigFix check={check} actions={actions} />
        ) : (
          <SettledFix applied={row.applied} actions={actions} />
        )
      }
    >
      <div className="cn-qkind">
        <KindTag kind={row.kind} />
      </div>
      <p className="cn-qtitle">{row.title}</p>
      {check.remedy !== undefined && <div className="cn-qmeta">{check.remedy}</div>}
    </Card>
  );
}

/* Narrowed at the one place that needs it, so `selectPr` is never handed the
   number of an ask whose destination is not a pull request. */
function rowDestination(row: NeedRow, dest: NeedRow['opens'], actions: CockpitActions): (() => void) | null {
  const ref = row.goalRef;
  const prOf = (r: NeedRow): number => r.prNumber ?? 0;
  if (dest === 'build') return () => actions.openPanel('build');
  if (dest === 'goal') return ref === null ? null : () => openGoalForAsk(actions, ref, row.kind);
  if (dest === 'pr') return row.prNumber === undefined ? null : () => actions.selectPr(prOf(row));
  if (dest === 'prediction') return ref === null ? null : () => actions.openGoalPrediction(ref);
  if (dest === 'ask') return () => actions.openPanel({ ask: row.id });
  return null;
}

function rowClass(row: NeedRow, focus: string | null, current: boolean): string {
  const parked = row.group === 'blocking';
  const dim = focus !== null && !current && row.kind !== 'recovery';
  return ['cn-q', `cn-t-${KIND_TONE[row.kind]}`, parked ? 'cn-parked' : '', dim ? 'cn-dim' : '']
    .filter((c) => c !== '')
    .join(' ');
}

function ProviderRow({
  cls,
  prNumber,
  originRef,
  details,
  children,
}: {
  cls: string;
  prNumber: number;
  originRef: string;
  details: (() => void) | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cls}>
      <i className="cn-stripe" />
      <PrLink number={prNumber} className="cn-qbody">
        <div className="cn-qin">{children}</div>
      </PrLink>
      <i className="cn-stripe" />
      <CardFoot>
        {details !== null && (
          <Button size="small" onClick={details}>
            Details
          </Button>
        )}
        <span className="cn-refs">
          <Ref to={originRef} />
        </span>
      </CardFoot>
    </div>
  );
}

function Row({
  row,
  now,
  focus,
  build,
  actions,
}: {
  row: NeedRow;
  now: number;
  focus: string | null;
  build: BuildReading;
  actions: CockpitActions;
}): JSX.Element {
  const current = focus !== null && row.goalRef === focus;
  const cls = rowClass(row, focus, current);
  const body = <RowBody row={row} now={now} />;
  const inner = (
    <>
      <i className="cn-stripe" />
      <div className="cn-qin">{body}</div>
    </>
  );

  if (row.opens === null) {
    return <div className={cls}>{inner}</div>;
  }

  if (row.check !== undefined) {
    return <ConfigRow row={row} check={row.check} cls={cls} current={current} actions={actions} />;
  }

  const open = rowDestination(row, row.opens, actions) ?? (() => actions.openPanel({ ask: row.id }));
  const card = (foot: ReactNode): JSX.Element => (
    <Card cls={cls} current={current} onClick={open} foot={foot}>
      {body}
    </Card>
  );

  if (row.kind === 'upgrade' || row.kind === 'project_pull') {
    return card(<UpdateActs kind={row.kind} build={build} actions={actions} />);
  }

  const details = row.details === undefined ? null : rowDestination(row, row.details, actions);
  const prNumber = Number(PR_ORIGIN.exec(row.originRef ?? '')?.[1]);
  if (row.opens === 'provider' && !Number.isNaN(prNumber) && row.originRef !== null) {
    return (
      <ProviderRow cls={cls} prNumber={prNumber} originRef={row.originRef} details={details}>
        {body}
      </ProviderRow>
    );
  }
  if (details !== null) {
    return card(
      <CardFoot>
        <Button size="small" onClick={details}>
          Details
        </Button>
      </CardFoot>,
    );
  }

  return (
    <button type="button" className={cls} onClick={open} aria-current={current ? 'true' : undefined}>
      {inner}
    </button>
  );
}

export function QueueRail({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const rows = view.needsYou;
  const focus = view.goalPage === null ? null : `issue:${view.goalPage.issue.number}`;
  const [showLater, setShowLater] = useState(false);
  const sections = URGENCY_ORDER.map((urgency) => ({
    urgency,
    rows: rows.filter((r) => r.urgency === urgency),
  })).filter((s) => s.rows.length > 0);
  /* The count over the heading stays the whole queue, folded rows included: a
     number that moved when a section closed would read as asks going away. */
  const pressing = rows.filter((r) => r.urgency !== 'later').length;
  /* The fold exists to keep asks that hold nothing out of the way of the ones
     the fleet cannot get past. With no `now` row left there is nothing to keep
     them out of the way of, so they open on their own — including the case where
     the rail's only content is the fold. */
  const answerNow = rows.filter((r) => r.urgency === 'now').length;
  const openLater = showLater || answerNow === 0;

  return (
    <>
      <div className="cn-rail-head">
        <h2>Needs you</h2>
        {rows.length > 0 && (
          <i className="cn-count" title={`${pressing} to answer, ${rows.length} in all`}>
            {rows.length}
          </i>
        )}
      </div>
      <div className="cn-rail-list">
        {rows.length === 0 ? (
          <p className="cn-rail-empty">Nothing is waiting on you</p>
        ) : (
          sections.map((section) => (
            <Fragment key={section.urgency}>
              {section.urgency === 'later' ? (
                /* Folded, and by a control that says what is behind it rather
                   than a chevron: these hold nothing, and a rail that spends a
                   row each on them is the reason the pressing ones get skimmed.
                   The fold is per-visit state, not a `Place` field — it says
                   nothing about where the operator is. */
                <button
                  type="button"
                  className="cn-railmore"
                  aria-expanded={openLater}
                  onClick={() => setShowLater((open) => !open)}
                >
                  {openLater ? 'Hide' : 'Show'} {section.rows.length} holding nothing
                </button>
              ) : (
                <div className="cn-railsub">{URGENCY_LABEL[section.urgency]}</div>
              )}
              {(section.urgency === 'later' && !openLater ? [] : section.rows).map((row) => (
                <Row key={row.id} row={row} now={view.now} focus={focus} build={view.state.build} actions={actions} />
              ))}
            </Fragment>
          ))
        )}
      </div>
    </>
  );
}
