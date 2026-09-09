import { Fragment, useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { AppliedFix, NeedGroup, NeedKind, NeedRow, NeedUrgency } from '../view/needsYou.js';
import type { BuildReading, SetupCheck, SetupFix } from '../types.js';
import { relTime } from '../components/util.js';
import { PrLink, Ref, refLabel } from '../components/refs.js';
import { Button } from '../components/button.js';
import { Tag } from '../components/tag.js';

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
  shortfall: 'Shortfall',
  intake: 'Intake',
  profile: 'Profile',
  placement: 'Backlog',
  bench: 'Bench',
  close_out: 'Close-out',
  validate: 'Validate',
  watch: 'Watch',
  burn: 'Spend',
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
  shortfall: 'blue',
  intake: 'blue',
  profile: 'blue',
  placement: 'amber',
  bench: 'blue',
  close_out: 'green',
  validate: 'green',
  watch: 'amber',
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
  shortfall: '\u2717',
  intake: '\u25cc',
  profile: '\u2299',
  placement: '\u25a3',
  bench: '\u25c6',
  close_out: '\u2691',
  validate: '\u2713',
  watch: '\u25ce',
  burn: '\u25b2',
  limit: '\u2016',
  supply: '\u25bd',
  dispatch: '\u22a0',
  assigned: '\u2913',
  upgrade: '\u2191',
  project_pull: '\u21a5',
};

const GROUP_LABEL: Record<NeedGroup, string> = {
  blocking: 'Blocking',
  yours: 'Yours to do',
};

/**
 * The rail's own headings, which are tiers rather than groups: the operator's
 * question at a glance is *what do I answer first*, and `blocking` / `yours`
 * answers a different one — who is stopped — that each row still carries as its
 * weight. Twenty-three kinds down two headings put a build upgrade beside an
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
  const parked = row.group === 'blocking';
  const current = focus !== null && row.goalRef === focus;
  const dim = focus !== null && !current && row.kind !== 'recovery';
  const cls = ['cn-q', `cn-t-${KIND_TONE[row.kind]}`, parked ? 'cn-parked' : '', dim ? 'cn-dim' : '']
    .filter((c) => c !== '')
    .join(' ');
  const goal = subjectBeside(row);
  const body = (
    <>
      <div className="cn-qkind">
        <Tag>
          {/* Hidden from the reading order on purpose: the word beside it is
                the label, and a screen reader announcing "black diamond bench"
                is worse than one announcing "bench". */}
          <span className="cn-sym" aria-hidden="true">
            {KIND_SYMBOL[row.kind]}
          </span>
          {KIND_LABEL[row.kind]}
        </Tag>
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
        {parked && <span className="cn-blk">{GROUP_LABEL[row.group]}</span>}
      </div>
    </>
  );
  const inner = (
    <>
      <i className="cn-stripe" />
      <div className="cn-qin">{body}</div>
    </>
  );

  const carded = (onClick: () => void, foot: ReactNode, bodyNode: ReactNode = body): JSX.Element => (
    <div className={cls}>
      <i className="cn-stripe" />
      <button type="button" className="cn-qbody" onClick={onClick} aria-current={current ? 'true' : undefined}>
        <div className="cn-qin">{bodyNode}</div>
      </button>
      {foot !== null && (
        <>
          <i className="cn-stripe" />
          {foot}
        </>
      )}
    </div>
  );

  if (row.opens === null) {
    return <div className={cls}>{inner}</div>;
  }

  if (row.check !== undefined) {
    const fix = row.check.fix;
    const group = fix?.kind === 'config' ? fix.group : fix?.kind === 'goto' ? fix.group : undefined;
    return carded(
      () => actions.openConfig({ configTab: 'values', configGroup: group ?? null }),
      row.applied === undefined ? (
        <ConfigFix check={row.check} actions={actions} />
      ) : (
        <SettledFix applied={row.applied} actions={actions} />
      ),
      <>
        <div className="cn-qkind">
          <Tag>
            <span className="cn-sym" aria-hidden="true">
              {KIND_SYMBOL[row.kind]}
            </span>
            {KIND_LABEL[row.kind]}
          </Tag>
        </div>
        <p className="cn-qtitle">{row.title}</p>
        {row.check.remedy !== undefined && <div className="cn-qmeta">{row.check.remedy}</div>}
      </>,
    );
  }

  const ref = row.goalRef;
  const goTo = (dest: NeedRow['opens']): (() => void) | null => {
    if (dest === 'build') return () => actions.openPanel('build');
    if (dest === 'goal') return ref === null ? null : () => actions.selectGoal(ref);
    if (dest === 'ask') return () => actions.openPanel({ ask: row.id });
    return null;
  };
  const open = goTo(row.opens) ?? (() => actions.openPanel({ ask: row.id }));

  if (row.kind === 'upgrade' || row.kind === 'project_pull') {
    return carded(open, <UpdateActs kind={row.kind} build={build} actions={actions} />);
  }

  const details = row.details === undefined ? null : goTo(row.details);
  const prNumber = Number(PR_ORIGIN.exec(row.originRef ?? '')?.[1]);
  if (row.opens === 'provider' && !Number.isNaN(prNumber) && row.originRef !== null) {
    return (
      <div className={cls}>
        <i className="cn-stripe" />
        <PrLink number={prNumber} className="cn-qbody">
          <div className="cn-qin">{body}</div>
        </PrLink>
        <i className="cn-stripe" />
        <CardFoot>
          {details !== null && (
            <Button size="small" onClick={details}>
              Details
            </Button>
          )}
          <span className="cn-refs">
            <Ref to={row.originRef} />
          </span>
        </CardFoot>
      </div>
    );
  }
  if (details !== null) {
    return carded(
      open,
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

function CardFoot({
  why = null,
  wide = false,
  settled = false,
  children,
}: {
  why?: ReactNode;
  wide?: boolean;
  settled?: boolean;
  children: ReactNode;
}): JSX.Element {
  const cls = ['cn-qfoot', wide ? 'cn-wide' : '', settled ? 'cn-settled' : ''].filter((c) => c !== '').join(' ');
  return (
    <div className={cls}>
      {why !== null && <span className="cn-footwhy">{why}</span>}
      <span className="cn-footacts">{children}</span>
    </div>
  );
}

function UpdateActs({
  kind,
  build,
  actions,
}: {
  kind: 'upgrade' | 'project_pull';
  build: BuildReading;
  actions: CockpitActions;
}): JSX.Element | null {
  const snooze = (
    <Button
      ghost
      size="small"
      onClick={() => void actions.snoozeUpdate(kind === 'upgrade' ? 'upgrade' : 'projectPull')}
    >
      Snooze
    </Button>
  );

  if (kind === 'project_pull')
    return <CardFoot why="Nothing to answer — the row clears when the checkout does.">{snooze}</CardFoot>;

  const { intent, live, supervised } = build;
  if (!supervised)
    return (
      <CardFoot why="No supervisor, so this build cannot restart itself — the panel says what to run.">
        {snooze}
      </CardFoot>
    );

  if (intent.state === 'applying') return null;

  if (intent.state === 'draining' || intent.state === 'ready')
    return (
      <CardFoot why={intent.state === 'ready' ? 'The fleet is clear.' : `Waiting for ${live} to finish.`}>
        <Button ghost size="small" onClick={() => void actions.upgrade('cancel')}>
          Cancel
        </Button>
        {intent.state === 'ready' ? (
          <Button tone="primary" size="small" onClick={() => void actions.upgrade('apply')}>
            Apply now
          </Button>
        ) : (
          <Button size="small" onClick={() => void actions.upgrade('apply', { interrupt: true })}>
            Don&apos;t wait — interrupt {live}
          </Button>
        )}
      </CardFoot>
    );

  if (live === 0)
    return (
      <CardFoot why="Exits, takes the update and comes back. Nothing is interrupted.">
        {snooze}
        <Button tone="primary" size="small" onClick={() => void actions.upgrade('drain')}>
          Upgrade
        </Button>
      </CardFoot>
    );

  return (
    <CardFoot
      why={
        <>
          Queue waits for {live} to finish; Now stops {live === 1 ? 'it' : 'them'} and restores{' '}
          {live === 1 ? 'it' : 'them'} on the way back up.
        </>
      }
    >
      {snooze}
      <Button size="small" onClick={() => void actions.upgrade('apply', { interrupt: true })}>
        Now
      </Button>
      <Button tone="primary" size="small" onClick={() => void actions.upgrade('drain')}>
        Queue
      </Button>
    </CardFoot>
  );
}

function ConfigFix({ check, actions }: { check: SetupCheck; actions: CockpitActions }): JSX.Element | null {
  const fix: SetupFix | undefined = check.fix;
  const [value, setValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  if (fix === undefined) return null;

  if (fix.kind === 'shell') {
    return (
      <CardFoot why={fix.why} wide>
        <div className="cn-shell">
          <span aria-hidden="true">$</span>
          <code>{fix.command}</code>
          <button
            type="button"
            className={copied ? 'cn-copy cn-copied' : 'cn-copy'}
            onClick={() => {
              void navigator.clipboard?.writeText(fix.command).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : fix.label}
          </button>
        </div>
      </CardFoot>
    );
  }

  if (fix.kind === 'sheet') {
    return (
      <CardFoot why={check.remedy ?? null}>
        <Button tone="primary" size="small" onClick={() => actions.openPanel('setup')}>
          {fix.label}
        </Button>
      </CardFoot>
    );
  }

  if (fix.kind === 'goto') {
    return (
      <CardFoot why={check.remedy ?? null}>
        <Button
          tone="primary"
          size="small"
          onClick={() =>
            fix.to === 'tickets'
              ? actions.openTab('tickets')
              : actions.openConfig({
                  configTab: fix.to === 'prompts' ? 'prompts' : 'values',
                  configGroup: fix.group ?? null,
                })
          }
        >
          {fix.label}
        </Button>
      </CardFoot>
    );
  }

  const paths = Object.keys(fix.set);
  const only = paths[0];
  const editable = fix.confidence === 'assumed' && paths.length === 1 && only !== undefined;
  const typed = value ?? (editable ? String(fix.set[only as string]) : '');
  const write = (): void => {
    setBusy(true);
    const set = editable ? { [only as string]: coerce(typed, fix.set[only as string]) } : fix.set;
    void actions.applyConfigFix(check.id, set).finally(() => setBusy(false));
  };

  return (
    <CardFoot why={editable ? null : (check.remedy ?? null)} wide={editable}>
      {editable ? (
        <div className="cn-fixline">
          <label className="cn-fixedit">
            Set <code>{only}</code> to
            <input className="cn-inline" value={typed} onChange={(e) => setValue(e.target.value)} aria-label={only} />
          </label>
          <Button size="small" disabled={busy} onClick={write}>
            Write it
          </Button>
        </div>
      ) : (
        <Button tone="primary" size="small" disabled={busy} onClick={write}>
          {fix.label}
        </Button>
      )}
    </CardFoot>
  );
}

function coerce(text: string, like: unknown): unknown {
  if (typeof like === 'boolean') return text === 'true';
  if (typeof like === 'number') return Number(text);
  return text;
}

function SettledFix({ applied, actions }: { applied: AppliedFix; actions: CockpitActions }): JSX.Element {
  return (
    <CardFoot
      settled
      why={
        <span className="cn-settled-what">
          <b>{applied.summary}</b>
          <i className="cn-settled-file">→ {applied.file}</i>
        </span>
      }
    >
      <Button size="small" onClick={() => void actions.undoConfigFix(applied.checkId)}>
        Undo
      </Button>
      <Button size="small" onClick={() => actions.dismissConfigFix(applied.checkId)}>
        Dismiss
      </Button>
    </CardFoot>
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
  /* With nothing pressing there is nothing to protect the operator from, and a
     rail whose only content is a fold reads as an empty one. */
  const openLater = showLater || pressing === 0;

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
