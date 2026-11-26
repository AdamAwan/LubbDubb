import { Fragment, useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedGroup, NeedKind, NeedRow, NeedUrgency } from '../view/needsYou.js';
import { openRow, rowDestination } from './queueRailOpens.js';
import type { Destination } from '../components/button.js';
import type { BuildReading, ControlUsage, SetupCheck } from '../types.js';
import { relTime } from '../components/util.js';
import { PrLink, Ref, refLabel } from '../components/refs.js';
import { BareButton, Button } from '../components/button.js';
import { Tag } from '../components/tag.js';
import { CardFoot, ConfigFix, SettledFix, UpdateActs } from './queueRailFoots.js';
import { foldAssignAsks, type AssignAsk } from '../view/askGroups.js';
import { reviewersLine } from '../view/reviewersPage.js';
import { FoldToggle } from '../components/collapsible.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from '../view/askKinds.js';
import { tabUsage } from '../cockpit/usage.js';
import { classes } from '../components/classes.js';

// → docs/spec/17-cockpit.md

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
  questions: 'Answer them',
  findings: 'Decide',
  profile: 'Answer',
  placement: 'Pick a parent',
  bench: 'Do it',
  close_out: 'Close it out',
  validate: 'Run the checks',
  validation_plan: 'Decide',
  watch: 'Look',
  watch_reading: 'Run it',
  unwatched: 'Look',
  burn: 'Look',
  limit: 'Look',
  supply: 'Top it up',
  dispatch: 'Look',
  assigned: 'Look',
  assign: 'Pick someone',
  bot_pr: 'Decide',
  upgrade: 'Upgrade',
  project_pull: 'Turn it on',
  fleet_stall: 'Look',
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
 * What a row is about, as a ref: its goal when it has one, else the pull request
 * it was raised on. Null only for an ask with neither, which is the one case a
 * surface has nothing true to name.
 *
 * @public shared with the Needs you page, which draws it as a `<Ref/>`
 */
export function subjectRef(row: NeedRow): string | null {
  if (row.goalRef !== null) return row.goalRef;
  const pr = PR_ORIGIN.exec(row.originRef ?? '')?.[1];
  return pr === undefined ? null : `pr:${pr}`;
}

/**
 * {@link subjectRef} in one token — `#12`, or `PR #142` as the ask lines write it.
 *
 * Through `refLabel`, the one function that shortens a ref: this was written
 * three times over, and the fourth surface that wrote it printed a label with no
 * link attached to it.
 *
 * @public shared with the ask panel, which states the same subject in its header
 */
export function subjectLabel(row: NeedRow): string | null {
  const ref = subjectRef(row);
  if (ref === null) return null;
  const pr = PR_ORIGIN.exec(ref);
  return pr ? `PR #${pr[1]}` : refLabel(ref);
}

function subjectBeside(row: NeedRow): string | null {
  const subject = subjectLabel(row);
  return subject !== null && row.title.includes(subject) ? null : subject;
}

/** @public shared with the Needs you page */
export const UNNAMED_RUN = 'a run with no task on record';

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
  usage,
  foot,
  children,
}: {
  cls: string;
  current: boolean;
  onClick: () => void;
  usage: ControlUsage;
  foot: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cls}>
      <i className="cn-stripe" />
      <BareButton usage={usage} className="cn-qbody" onClick={onClick} aria-current={current ? 'true' : undefined}>
        <div className="cn-qin">{children}</div>
      </BareButton>
      {foot !== null && (
        <>
          <i className="cn-stripe" />
          {foot}
        </>
      )}
    </div>
  );
}

/**
 * Where a setup check's row opens: the config page, on the group its fix names.
 *
 * @public shared with the Needs you page
 */
export function configDestination(check: SetupCheck, actions: CockpitActions): Destination {
  const fix = check.fix;
  const group = fix?.kind === 'config' || fix?.kind === 'goto' ? fix.group : null;
  return {
    usage: { counted: 'config.view' },
    go: () => actions.openConfig({ configTab: 'values', configGroup: group }),
  };
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
  const open = configDestination(check, actions);
  return (
    <Card
      cls={cls}
      current={current}
      onClick={open.go}
      usage={open.usage}
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

/**
 * An ask card's classes: its kind's tone, parked when it blocks, dimmed beside the goal in focus.
 *
 * @public shared with the Needs you page, which has no focus and adds its own class
 */
export function rowClass(row: NeedRow, focus: string | null, current: boolean, extra = ''): string {
  const parked = row.group === 'blocking';
  const dim = focus !== null && !current && row.kind !== 'recovery';
  return classes('cn-q', extra, `cn-t-${KIND_TONE[row.kind]}`, parked && 'cn-parked', dim && 'cn-dim');
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
  details: Destination | null;
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
          <Button size="small" usage={details.usage} onClick={details.go}>
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

  const open = openRow(row, actions);
  const card = (foot: ReactNode): JSX.Element => (
    <Card cls={cls} current={current} onClick={open.go} usage={open.usage} foot={foot}>
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
        <Button size="small" usage={details.usage} onClick={details.go}>
          Details
        </Button>
      </CardFoot>,
    );
  }

  return (
    <BareButton usage={open.usage} className={cls} onClick={open.go} aria-current={current ? 'true' : undefined}>
      {inner}
    </BareButton>
  );
}

/* Every assign ask in a section, folded by `foldAssignAsks`, is one card that opens the Reviewers
   page, the pull requests as refs in its foot. → docs/spec/17-cockpit.md#every-reviewer-ask-is-one-page */
function AssignGroupRow({
  first,
  asks,
  view,
  focus,
  actions,
}: {
  first: NeedRow;
  asks: readonly AssignAsk[];
  view: CockpitView;
  focus: string | null;
  actions: CockpitActions;
}): JSX.Element {
  const row: NeedRow = { ...first, goalRef: null, title: reviewersLine(asks.length) };
  const open = {
    usage: tabUsage('reviewers'),
    go: () => {
      actions.selectGoal(null);
      actions.openTab('reviewers');
    },
  };
  const current = focus === null && view.tab === 'reviewers';
  return (
    <Card
      cls={rowClass(row, focus, current)}
      current={current}
      onClick={open.go}
      usage={open.usage}
      foot={
        <CardFoot>
          <span className="cn-refs">
            {asks.map((ask) => (
              <Ref key={ask.number} to={`pr:${ask.number}`} />
            ))}
          </span>
        </CardFoot>
      }
    >
      <RowBody row={row} now={view.now} />
    </Card>
  );
}

/** The rail's urgency headings and its fold, over any rows. → docs/spec/44-needs-you.md#from-the-orchestrator */
function RailTiers({
  rows,
  draw,
}: {
  rows: readonly NeedRow[];
  draw: (rows: readonly NeedRow[]) => ReactNode;
}): JSX.Element {
  const [showLater, setShowLater] = useState(false);
  const sections = URGENCY_ORDER.map((urgency) => ({
    urgency,
    rows: rows.filter((r) => r.urgency === urgency),
  })).filter((s) => s.rows.length > 0);
  /* The fold exists to keep asks that hold nothing out of the way of the ones
     the fleet cannot get past. With no `now` row left there is nothing to keep
     them out of the way of, so they open on their own — including the case where
     the rail's only content is the fold. */
  const answerNow = rows.filter((r) => r.urgency === 'now').length;
  const openLater = showLater || answerNow === 0;
  return (
    <>
      {sections.map((section) => (
        <Fragment key={section.urgency}>
          {section.urgency === 'later' ? (
            /* Folded, and by a control that says what is behind it rather
               than a chevron: these hold nothing, and a rail that spends a
               row each on them is the reason the pressing ones get skimmed.
               The fold is per-visit state, not a `Place` field — it says
               nothing about where the operator is. */
            <FoldToggle
              subject="escalation"
              className="cn-railmore"
              open={openLater}
              onToggle={setShowLater}
              label={`${section.rows.length} holding nothing`}
            />
          ) : (
            <div className="cn-railsub">{URGENCY_LABEL[section.urgency]}</div>
          )}
          {draw(section.urgency === 'later' && !openLater ? [] : section.rows)}
        </Fragment>
      ))}
    </>
  );
}

export function QueueRail({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const rows = view.needsYou;
  const focus = view.goalPage === null ? null : `issue:${view.goalPage.issue.number}`;
  /* The count over the heading stays the whole queue, folded rows included: a
     number that moved when a section closed would read as asks going away. */
  const pressing = rows.filter((r) => r.urgency !== 'later').length;

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
          <RailTiers
            rows={rows}
            draw={(tier) =>
              foldAssignAsks(tier, view.state).map((item) =>
                item.kind === 'assign' ? (
                  <AssignGroupRow
                    key={`assign:${item.first.id}`}
                    first={item.first}
                    asks={item.asks}
                    view={view}
                    focus={focus}
                    actions={actions}
                  />
                ) : (
                  <Row
                    key={item.row.id}
                    row={item.row}
                    now={view.now}
                    focus={focus}
                    build={view.state.build}
                    actions={actions}
                  />
                ),
              )
            }
          />
        )}
      </div>
      <HandledLine view={view} actions={actions} />
    </>
  );
}

// → docs/spec/43-handled-for-you.md#on-the-rail
export function HandledLine({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const open = view.state.handledOpen;
  const here = view.goalPage === null && view.tab === 'handled';
  return (
    <BareButton
      usage={tabUsage('handled')}
      className={`cn-handled${here ? ' cn-on' : ''}`}
      onClick={() => {
        actions.selectGoal(null);
        actions.openTab('handled');
      }}
    >
      <span className="cn-handled-mark">✓</span>
      <span>Handled for you</span>
      {open > 0 && <i className="cn-count">{open}</i>}
    </BareButton>
  );
}
